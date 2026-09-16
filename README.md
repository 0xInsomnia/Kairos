# Kairos

Trading journal (PWA) — personale, locale, offline.

## Run the journal (static)

Open `index.html`, or serve the folder with any static server.

## Vega mini-chat

Optional in-app chat for an external assistant (Vega). Needs the small Node API:

```bash
cd server
export VEGA_CHAT_SECRET='change-me'
npm start
```

Then open http://127.0.0.1:3847/

See [docs/VEGA_CHAT.md](docs/VEGA_CHAT.md) for API, env vars, and bot POST examples.
