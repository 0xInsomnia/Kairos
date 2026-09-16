'use strict';
/**
 * Kairos Vega mini-chat + journal API
 * Serves static app from repo root + /api/chat/* + /api/journal/*
 * Persistence: server/data/messages.json, server/data/journal.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.json');
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.VEGA_CHAT_SECRET || '';
const OUTBOUND = process.env.VEGA_OUTBOUND_WEBHOOK || '';
const MAX_MESSAGES = 500;
const MAX_CONTENT = 8000;
const MAX_TRADES = 5000;

const DEFAULT_SYMBOLS = ['EURUSD','GBPUSD','USDJPY','XAUUSD','NAS100','US500','GER40','BTCUSD','ETHUSD'];
const DEFAULT_SETUPS = ['FVG','Breakout','Pullback','Order block','Mean reversion','News','Scalping'];
const DEFAULT_MISTAKES = ['FOMO','Revenge','Oversize','Uscita anticipata','Stop spostato','Nessun piano','Overtrading','Contro trend'];
const SESSIONS = new Set(['asia','london','newyork','overlap']);
const DIRECTIONS = new Set(['long','short']);
const STATUSES = new Set(['open','closed']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function emptyJournal() {
  return {
    trades: [],
    symbols: DEFAULT_SYMBOLS.slice(),
    setups: DEFAULT_SETUPS.slice(),
    mistakes: DEFAULT_MISTAKES.slice(),
    startingCapital: 10000,
    locale: 'it',
    updatedAt: new Date().toISOString(),
  };
}

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ messages: [] }, null, 2));
  }
  if (!fs.existsSync(JOURNAL_FILE)) {
    fs.writeFileSync(JOURNAL_FILE, JSON.stringify(emptyJournal(), null, 2));
  }
}

function readMessages() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return Array.isArray(raw.messages) ? raw.messages : [];
  } catch {
    return [];
  }
}

function writeMessages(messages) {
  ensureStore();
  const trimmed = messages.slice(-MAX_MESSAGES);
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ messages: trimmed, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, DATA_FILE);
  return trimmed;
}

function readJournal() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8'));
    const base = emptyJournal();
    return {
      trades: Array.isArray(raw.trades) ? raw.trades : [],
      symbols: Array.isArray(raw.symbols) && raw.symbols.length ? raw.symbols : base.symbols,
      setups: Array.isArray(raw.setups) && raw.setups.length ? raw.setups : base.setups,
      mistakes: Array.isArray(raw.mistakes) && raw.mistakes.length ? raw.mistakes : base.mistakes,
      startingCapital: Number.isFinite(Number(raw.startingCapital)) ? Number(raw.startingCapital) : base.startingCapital,
      locale: typeof raw.locale === 'string' && raw.locale ? raw.locale : base.locale,
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return emptyJournal();
  }
}

function writeJournal(journal) {
  ensureStore();
  const out = {
    trades: (journal.trades || []).slice(0, MAX_TRADES),
    symbols: journal.symbols || DEFAULT_SYMBOLS.slice(),
    setups: journal.setups || DEFAULT_SETUPS.slice(),
    mistakes: journal.mistakes || DEFAULT_MISTAKES.slice(),
    startingCapital: journal.startingCapital != null ? journal.startingCapital : 10000,
    locale: journal.locale || 'it',
    updatedAt: new Date().toISOString(),
  };
  const tmp = JOURNAL_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, JOURNAL_FILE);
  return out;
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vega-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function getSecret(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return (req.headers['x-vega-secret'] || '').trim();
}

function secretsMatch(provided) {
  if (!SECRET) return false;
  if (!provided) return false;
  const a = Buffer.from(SECRET);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function requireBotAuth(req, res) {
  if (!SECRET) {
    sendJson(res, 503, { error: 'VEGA_CHAT_SECRET not configured on server' });
    return false;
  }
  if (!secretsMatch(getSecret(req))) {
    sendJson(res, 401, { error: 'unauthorized' });
    return false;
  }
  return true;
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
}

function asNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function computeR(pnl, risk) {
  if (pnl == null || risk == null || !risk) return null;
  return pnl / risk;
}

/**
 * Normalize a trade to Kairos localStorage shape (index.html openForm/save).
 * Accepts partial updates; `existing` used when upserting.
 */
function normalizeTrade(input, existing) {
  const src = input && typeof input === 'object' ? input : {};
  const base = existing && typeof existing === 'object' ? existing : null;
  const now = new Date().toISOString();

  const direction = String(src.direction != null ? src.direction : (base && base.direction) || 'long').toLowerCase();
  const status = String(src.status != null ? src.status : (base && base.status) || 'closed').toLowerCase();
  const session = String(src.session != null ? src.session : (base && base.session) || 'london').toLowerCase();

  if (!DIRECTIONS.has(direction)) throw new Error('direction must be long or short');
  if (!STATUSES.has(status)) throw new Error('status must be open or closed');
  if (!SESSIONS.has(session)) throw new Error('session must be asia|london|newyork|overlap');

  let mistakes = src.mistakes != null ? src.mistakes : (base && base.mistakes);
  if (mistakes == null) mistakes = [];
  if (!Array.isArray(mistakes)) mistakes = [String(mistakes)];
  mistakes = mistakes.map((m) => String(m)).filter(Boolean);

  const pnl = src.pnl !== undefined ? asNum(src.pnl) : (base ? base.pnl : null);
  const risk = src.risk !== undefined ? asNum(src.risk) : (base ? base.risk : null);
  const fees = src.fees !== undefined ? (asNum(src.fees) ?? 0) : (base && base.fees != null ? base.fees : 0);

  const trade = {
    id: (src.id && String(src.id)) || (base && base.id) || uid(),
    symbol: String(src.symbol != null ? src.symbol : (base && base.symbol) || 'EURUSD').trim().toUpperCase() || 'EURUSD',
    assetClass: String(src.assetClass != null ? src.assetClass : (base && base.assetClass) || 'forex'),
    direction,
    setup: src.setup != null ? String(src.setup) : (base && base.setup) || '',
    session,
    status,
    openedAt: src.openedAt != null ? String(src.openedAt) : (base && base.openedAt) || now,
    closedAt: src.closedAt !== undefined ? (src.closedAt == null ? null : String(src.closedAt)) : (base ? base.closedAt : (status === 'closed' ? now : null)),
    entry: src.entry !== undefined ? asNum(src.entry) : (base ? base.entry : null),
    exit: src.exit !== undefined ? asNum(src.exit) : (base ? base.exit : null),
    stop: src.stop !== undefined ? asNum(src.stop) : (base ? base.stop : null),
    takeProfit: src.takeProfit !== undefined ? asNum(src.takeProfit) : (base ? base.takeProfit : null),
    size: src.size !== undefined ? asNum(src.size) : (base ? base.size : null),
    fees,
    pnl,
    risk,
    mood: src.mood !== undefined ? src.mood : (base ? base.mood : null),
    notes: src.notes != null ? String(src.notes) : (base && base.notes) || '',
    mistakes,
    rMultiple: src.rMultiple !== undefined ? asNum(src.rMultiple) : computeR(pnl, risk),
    createdAt: (base && base.createdAt) || src.createdAt || now,
    updatedAt: now,
  };

  if (src.rMultiple === undefined) trade.rMultiple = computeR(trade.pnl, trade.risk);
  return trade;
}

function ensureCatalog(journal, trade) {
  if (trade.symbol && !journal.symbols.some((s) => s.toLowerCase() === trade.symbol.toLowerCase())) {
    journal.symbols.push(trade.symbol);
  }
  if (trade.setup && !journal.setups.some((s) => s.toLowerCase() === trade.setup.toLowerCase())) {
    journal.setups.push(trade.setup);
  }
  (trade.mistakes || []).forEach((m) => {
    if (m && !journal.mistakes.some((x) => x.toLowerCase() === m.toLowerCase())) journal.mistakes.push(m);
  });
}

async function notifyOutbound(msg) {
  if (!OUTBOUND) return;
  try {
    await fetch(OUTBOUND, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
  } catch (err) {
    console.error('[vega-chat] outbound webhook failed:', err.message);
  }
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

async function handleChatApi(req, res, pathname) {
  if (pathname === '/api/chat/messages' && req.method === 'GET') {
    const u = new URL(req.url, `http://${HOST}`);
    const after = u.searchParams.get('after') || '';
    const since = u.searchParams.get('since') || '';
    let messages = readMessages();
    if (after) {
      const idx = messages.findIndex((m) => m.id === after);
      messages = idx >= 0 ? messages.slice(idx + 1) : messages;
    } else if (since) {
      const t0 = Date.parse(since);
      if (Number.isFinite(t0)) messages = messages.filter((m) => Date.parse(m.createdAt) > t0);
    }
    return sendJson(res, 200, { messages, serverTime: new Date().toISOString() });
  }

  if (pathname === '/api/chat/messages' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const content = String(body.content ?? body.text ?? '').trim();
    if (!content) return sendJson(res, 400, { error: 'content required' });
    if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: 'content too long' });

    let role = String(body.role || 'user').toLowerCase();
    if (role === 'bot' || role === 'vega' || role === 'assistant') role = 'assistant';
    if (role !== 'user' && role !== 'assistant') {
      return sendJson(res, 400, { error: 'role must be user or assistant' });
    }

    if (role === 'assistant') {
      if (!requireBotAuth(req, res)) return;
    }

    const msg = {
      id: uid(),
      role,
      content,
      createdAt: new Date().toISOString(),
      source: role === 'assistant' ? (body.source || 'vega') : (body.source || 'ui'),
    };
    const messages = readMessages();
    messages.push(msg);
    writeMessages(messages);

    if (role === 'user') notifyOutbound(msg);
    return sendJson(res, 201, { message: msg });
  }

  if (pathname === '/api/chat/bot' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!requireBotAuth(req, res)) return;
    const content = String(body.content ?? body.text ?? '').trim();
    if (!content) return sendJson(res, 400, { error: 'content required' });
    if (content.length > MAX_CONTENT) return sendJson(res, 400, { error: 'content too long' });

    const msg = {
      id: uid(),
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      source: body.source || 'vega',
    };
    const messages = readMessages();
    messages.push(msg);
    writeMessages(messages);
    return sendJson(res, 201, { message: msg });
  }

  if (pathname === '/api/chat/health' && req.method === 'GET') {
    const j = readJournal();
    return sendJson(res, 200, {
      ok: true,
      secretConfigured: Boolean(SECRET),
      outboundConfigured: Boolean(OUTBOUND),
      count: readMessages().length,
      trades: j.trades.length,
      journalUpdatedAt: j.updatedAt,
    });
  }

  return sendJson(res, 404, { error: 'not found' });
}

async function handleJournalApi(req, res, pathname) {
  // GET /api/journal — full journal (UI sync + bot verify)
  if (pathname === '/api/journal' && req.method === 'GET') {
    const journal = readJournal();
    return sendJson(res, 200, { journal, serverTime: new Date().toISOString() });
  }

  // PUT /api/journal — full replace from UI (local-trust, no auth)
  if (pathname === '/api/journal' && req.method === 'PUT') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const src = body.journal || body;
    const journal = writeJournal({
      trades: Array.isArray(src.trades) ? src.trades.map((t) => {
        try { return normalizeTrade(t, null); } catch { return null; }
      }).filter(Boolean) : [],
      symbols: Array.isArray(src.symbols) ? src.symbols.map(String) : DEFAULT_SYMBOLS.slice(),
      setups: Array.isArray(src.setups) ? src.setups.map(String) : DEFAULT_SETUPS.slice(),
      mistakes: Array.isArray(src.mistakes) ? src.mistakes.map(String) : DEFAULT_MISTAKES.slice(),
      startingCapital: asNum(src.startingCapital) ?? 10000,
      locale: src.locale || 'it',
    });
    return sendJson(res, 200, { journal });
  }

  // GET /api/journal/trades — list trades (optional auth; open for UI)
  if (pathname === '/api/journal/trades' && req.method === 'GET') {
    const journal = readJournal();
    return sendJson(res, 200, {
      trades: journal.trades,
      updatedAt: journal.updatedAt,
      serverTime: new Date().toISOString(),
    });
  }

  // POST /api/journal/trades — create or upsert one trade (bot: auth required)
  if (pathname === '/api/journal/trades' && req.method === 'POST') {
    if (!requireBotAuth(req, res)) return;
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const payload = body.trade || body;
    const journal = readJournal();
    const existing = payload.id
      ? journal.trades.find((t) => t.id === payload.id)
      : null;
    let trade;
    try {
      trade = normalizeTrade(payload, existing || null);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    ensureCatalog(journal, trade);
    if (existing) {
      journal.trades = journal.trades.map((t) => (t.id === trade.id ? trade : t));
    } else {
      journal.trades.unshift(trade);
    }
    const saved = writeJournal(journal);
    return sendJson(res, existing ? 200 : 201, {
      trade,
      created: !existing,
      updatedAt: saved.updatedAt,
    });
  }

  // PATCH/PUT /api/journal/trades/:id — update (auth)
  const tradeMatch = pathname.match(/^\/api\/journal\/trades\/([^/]+)$/);
  if (tradeMatch && (req.method === 'PUT' || req.method === 'PATCH')) {
    if (!requireBotAuth(req, res)) return;
    const id = decodeURIComponent(tradeMatch[1]);
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    const journal = readJournal();
    const existing = journal.trades.find((t) => t.id === id);
    if (!existing) return sendJson(res, 404, { error: 'trade not found' });
    const payload = { ...(body.trade || body), id };
    let trade;
    try {
      trade = normalizeTrade(payload, existing);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    ensureCatalog(journal, trade);
    journal.trades = journal.trades.map((t) => (t.id === id ? trade : t));
    const saved = writeJournal(journal);
    return sendJson(res, 200, { trade, updatedAt: saved.updatedAt });
  }

  // DELETE /api/journal/trades/:id — auth
  if (tradeMatch && req.method === 'DELETE') {
    if (!requireBotAuth(req, res)) return;
    const id = decodeURIComponent(tradeMatch[1]);
    const journal = readJournal();
    const before = journal.trades.length;
    journal.trades = journal.trades.filter((t) => t.id !== id);
    if (journal.trades.length === before) return sendJson(res, 404, { error: 'trade not found' });
    const saved = writeJournal(journal);
    return sendJson(res, 200, { deleted: id, updatedAt: saved.updatedAt });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) {
      return sendJson(res, 204, {});
    }
    if (pathname.startsWith('/api/chat')) {
      return await handleChatApi(req, res, pathname);
    }
    if (pathname.startsWith('/api/journal')) {
      return await handleJournalApi(req, res, pathname);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      return res.end('Method Not Allowed');
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
  }
});

ensureStore();
server.listen(PORT, HOST, () => {
  console.log(`[kairos] http://${HOST}:${PORT}`);
  console.log(`[kairos] secret ${SECRET ? 'configured' : 'MISSING — bot POSTs will fail'}`);
  console.log(`[kairos] outbound ${OUTBOUND || '(none)'}`);
});
