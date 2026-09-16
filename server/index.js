'use strict';
/**
 * Kairos Vega mini-chat server
 * Serves static app from repo root + /api/chat/*
 * Persistence: server/data/messages.json
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');
const PORT = Number(process.env.PORT || 3847);
const HOST = process.env.HOST || '127.0.0.1';
const SECRET = process.env.VEGA_CHAT_SECRET || '';
const OUTBOUND = process.env.VEGA_OUTBOUND_WEBHOOK || '';
const MAX_MESSAGES = 500;
const MAX_CONTENT = 8000;

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

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ messages: [] }, null, 2));
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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Vega-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024) {
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

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
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
  // prevent path traversal
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

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  // GET /api/chat/messages?after=<id>&since=<iso>
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

  // POST /api/chat/messages — user (or authenticated bot)
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
      if (!SECRET) {
        return sendJson(res, 503, { error: 'VEGA_CHAT_SECRET not configured on server' });
      }
      if (!secretsMatch(getSecret(req))) {
        return sendJson(res, 401, { error: 'unauthorized' });
      }
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

    if (role === 'user') {
      // fire-and-forget
      notifyOutbound(msg);
    }
    return sendJson(res, 201, { message: msg });
  }

  // POST /api/chat/bot — alias for authenticated assistant reply
  if (pathname === '/api/chat/bot' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
    if (!SECRET) {
      return sendJson(res, 503, { error: 'VEGA_CHAT_SECRET not configured on server' });
    }
    if (!secretsMatch(getSecret(req))) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
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

  // GET /api/chat/health
  if (pathname === '/api/chat/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      secretConfigured: Boolean(SECRET),
      outboundConfigured: Boolean(OUTBOUND),
      count: readMessages().length,
    });
  }

  return sendJson(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/chat')) {
      return await handleApi(req, res, pathname);
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
  console.log(`[vega-chat] http://${HOST}:${PORT}`);
  console.log(`[vega-chat] secret ${SECRET ? 'configured' : 'MISSING — bot POSTs will fail'}`);
  console.log(`[vega-chat] outbound ${OUTBOUND || '(none)'}`);
});
