# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

AtFactoryPrice is an e-commerce PWA (static HTML/CSS/JS) with Firebase Cloud Functions backend and an optional Telegram operations bot. No build step is required for the frontend.

### Services

| Service | Directory | Port | Start Command |
|---------|-----------|------|---------------|
| Web App + Functions + Firestore | `/workspace` | Hosting:5002, Functions:5001, Firestore:8080, UI:4000 | `firebase emulators:start --project demo-atfactoryprice --only hosting,functions,firestore` |
| Telegram Ops Bot | `/workspace/telegram-ops-bot` | 3000 | `node server.js` (requires `.env`) |

### Running Firebase Emulators

Use `--project demo-atfactoryprice` to avoid needing Firebase auth/login. This starts with a demo project that doesn't require real credentials.

```bash
cd /workspace
firebase emulators:start --project demo-atfactoryprice --only hosting,functions,firestore
```

The Auth emulator won't start unless you explicitly add `"emulators": { "auth": { "port": 9099 } }` to `firebase.json`.

### Lint

The `functions/package.json` has an eslint lint script (`npm run lint` in `functions/`), but there is **no `.eslintrc` config file** present in the repo. Running `npm run lint` will fail with "ESLint couldn't find a configuration file." This is a pre-existing repo state.

### Testing

There are no automated test scripts configured. Manual testing is done via the Firebase emulators and Telegram bot health endpoint (`GET /health` on port 3000).

### Telegram Bot

The bot requires external API credentials (Telegram token, OpenAI key, Google Sheets credentials). Without these, it still starts the Express server but logs warnings. Use `.env.example` as a template: `cp .env.example .env`.

### Node.js Version

The project requires Node.js 18 (`engines` field in `functions/package.json`). Use `nvm use 18` before running emulators or the bot.
