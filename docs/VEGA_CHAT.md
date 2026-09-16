# Vega mini-chat (Kairos)

In-app chat so an external assistant (Vega / Grok Bot) can read and write messages in near real time.

## Architecture

- **UI**: floating panel in `index.html` (does not replace journal tabs).
- **API**: small Node server in `server/` (zero npm deps).
- **Store**: `server/data/messages.json` (created at runtime, gitignored).
- **Realtime (v1)**: client polls every ~2.5s while the panel is open.

Static GitHub Pages alone cannot accept authenticated POSTs. Run the Node server locally (or on any host) and open Kairos through that origin.

## Env vars

| Variable | Required | Description |
|----------|----------|-------------|
| `VEGA_CHAT_SECRET` | Yes (for bot) | Shared secret. Bot must send `Authorization: Bearer <secret>` **or** `X-Vega-Secret: <secret>`. |
| `VEGA_OUTBOUND_WEBHOOK` | No | URL called with `POST` JSON when the user sends a message. |
| `PORT` | No | Default `3847`. |
| `HOST` | No | Default `127.0.0.1`. |

Copy `.env.example` and export vars in your shell (or use a process manager). Secrets are never hardcoded.

## Run locally

```bash
cd server
export VEGA_CHAT_SECRET='your-long-random-secret'
# optional:
# export VEGA_OUTBOUND_WEBHOOK='https://example.com/hook'
npm start
```

Open http://127.0.0.1:3847/ — tap the chat bubble (bottom-right).

## API

### Health

```http
GET /api/chat/health
```

### List messages

```http
GET /api/chat/messages
GET /api/chat/messages?after=<messageId>
GET /api/chat/messages?since=<ISO-8601>
```

### User message (from the UI)

```http
POST /api/chat/messages
Content-Type: application/json

{ "content": "ciao Vega", "role": "user" }
```

If `VEGA_OUTBOUND_WEBHOOK` is set, the server forwards the saved message JSON to that URL.

### Bot reply (authenticated)

```http
POST /api/chat/bot
Authorization: Bearer $VEGA_CHAT_SECRET
Content-Type: application/json

{ "content": "eccomi — ho letto il diario." }
```

Equivalent:

```http
POST /api/chat/messages
X-Vega-Secret: $VEGA_CHAT_SECRET
Content-Type: application/json

{ "content": "…", "role": "assistant" }
```

### curl example

```bash
curl -s http://127.0.0.1:3847/api/chat/bot \
  -H "Authorization: Bearer $VEGA_CHAT_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"content":"Ping from Vega"}'
```

## UI notes

- Chat button sits above the bottom nav; journal features unchanged.
- Optional API base override: `localStorage.setItem('kairos-chat-api','http://127.0.0.1:3847')` then reload (useful if the HTML is opened elsewhere).
- Service worker skips `/api/` so polls are never served from cache.

## Limitations (v1)

- No auth on user `POST` (local/trusted network assumed). Put the server behind a tunnel/VPN if exposed.
- Polling only (no SSE/WebSocket yet).
- Single shared room (no multi-user accounts).
- Message history capped at 500 entries.
