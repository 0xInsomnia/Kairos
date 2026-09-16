# Vega mini-chat + journal API (Kairos)

In-app chat so an external assistant (Vega / Grok Bot) can read/write messages and **insert trades into the Kairos journal**.

## Architecture

- **UI**: floating chat panel in `index.html` (journal tabs unchanged).
- **API**: zero-dependency Node server in `server/`.
- **Chat store**: `server/data/messages.json` (gitignored).
- **Journal store**: `server/data/journal.json` — same shape as browser `localStorage` key `kairos-journal`.
- **Sync**: UI loads/polls `GET /api/journal` every ~3s; local `save()` also `PUT`s the full journal. Vega inserts via authenticated `POST /api/journal/trades` appear in the UI on the next poll (or refresh).
- **Realtime chat (v1)**: ~2.5s polling while the panel is open.

Static GitHub Pages alone cannot accept authenticated POSTs. Run the Node server and open Kairos through that origin.

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `VEGA_CHAT_SECRET` | Yes (for bot) | Shared secret. Bot must send `Authorization: Bearer <secret>` **or** `X-Vega-Secret: <secret>`. |
| `VEGA_OUTBOUND_WEBHOOK` | No | URL called with `POST` JSON when the user sends a chat message. |
| `PORT` | No | Default `3847`. |
| `HOST` | No | Default `127.0.0.1`. |

Copy `.env.example`. Secrets are never hardcoded.

## Run locally

```bash
cd server
export VEGA_CHAT_SECRET='your-long-random-secret'
npm start
```

Open http://127.0.0.1:3847/

---

## Chat API

### Health

```http
GET /api/chat/health
```

### List / send messages

```http
GET /api/chat/messages
POST /api/chat/messages
Content-Type: application/json

{ "content": "ciao Vega", "role": "user" }
```

### Bot reply (authenticated)

```bash
curl -s http://127.0.0.1:3847/api/chat/bot \
  -H "Authorization: Bearer $VEGA_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"content":"Ping from Vega"}'
```

---

## Journal API (trade insert)

Kairos trade fields (mirror `index.html` form / `localStorage`):

| Field | Type | Notes |
|-------|------|--------|
| `symbol` | string | e.g. `EURUSD`, `XAUUSD` |
| `direction` | `long` \| `short` | |
| `setup` | string | e.g. `FVG`, `Breakout` |
| `session` | `asia` \| `london` \| `newyork` \| `overlap` | |
| `status` | `open` \| `closed` | |
| `openedAt` / `closedAt` | ISO-8601 | |
| `entry` `exit` `stop` `takeProfit` `size` `fees` `pnl` `risk` | number \| null | |
| `notes` | string | |
| `mistakes` | string[] | |
| `mood` | any \| null | |
| `assetClass` | string | default `forex` |
| `id` | string | optional; if set, upserts |

Server also sets `rMultiple` (= `pnl / risk` when possible), `createdAt`, `updatedAt`.

### List journal / trades (no auth — for UI + bot verify)

```bash
curl -s http://127.0.0.1:3847/api/journal | jq .
curl -s http://127.0.0.1:3847/api/journal/trades | jq .
```

### Insert or upsert a trade (authenticated — Vega)

```bash
curl -s http://127.0.0.1:3847/api/journal/trades \
  -H "Authorization: Bearer $VEGA_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "symbol": "EURUSD",
    "direction": "long",
    "setup": "FVG",
    "session": "london",
    "status": "closed",
    "entry": 1.0850,
    "exit": 1.0910,
    "stop": 1.0820,
    "takeProfit": 1.0920,
    "size": 1,
    "fees": 2.5,
    "pnl": 60,
    "risk": 30,
    "notes": "Inserito da Vega via chat",
    "mistakes": []
  }'
```

Equivalent with header `X-Vega-Secret: $VEGA_CHAT_SECRET`.

Body may wrap the object as `{ "trade": { ... } }`.

### Update a trade

```bash
curl -s -X PATCH http://127.0.0.1:3847/api/journal/trades/<id> \
  -H "Authorization: Bearer $VEGA_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"pnl": 75, "notes": "updated"}'
```

### Delete a trade

```bash
curl -s -X DELETE http://127.0.0.1:3847/api/journal/trades/<id> \
  -H "Authorization: Bearer $VEGA_CHAT_SECRET"
```

### Full journal replace (UI sync, no auth)

```http
PUT /api/journal
Content-Type: application/json

{ "journal": { "trades": [], "symbols": [], "setups": [], "mistakes": [], "startingCapital": 10000, "locale": "it" } }
```

---

## How André pastes a trade for Vega to insert

In the Kairos chat (or wherever you talk to Vega), paste something like:

```text
Inserisci nel diario Kairos:
symbol: EURUSD
direction: long
setup: FVG
session: london
status: closed
entry: 1.0850
exit: 1.0910
stop: 1.0820
takeProfit: 1.0920
size: 1
fees: 2.5
pnl: 60
risk: 30
notes: London FVG, tenuto fino a TP
mistakes: []
```

Vega should map those fields and `POST /api/journal/trades` with the secret. Within ~3s the trade appears in Diario / Operazioni (no full reload needed if the app is open against the Node server).

---

## UI notes

- Optional API base override: `localStorage.setItem('kairos-chat-api','http://127.0.0.1:3847')` then reload.
- Service worker skips `/api/`.

## Limitations (v1)

- User chat `POST` and journal `PUT` are unauthenticated (local/trusted host).
- Polling only (no SSE/WebSocket).
- Single shared journal + chat room.
- Chat history capped at 500 messages; trades at 5000.
