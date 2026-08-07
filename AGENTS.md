# AGENTS.md

## Cursor Cloud specific instructions

### Project Overview

AtFactoryPrice is a Firebase-based e-commerce platform with MLM/referral system for premium fabrics in Nigeria. It consists of:

- **Web storefront** (root `/`): Static HTML/JS/CSS served via Firebase Hosting (no build step)
- **Cloud Functions** (`functions/`): Node.js serverless backend (MLM, payments, fraud, analytics)
- **Telegram Operations Bot** (`telegram-ops-bot/`): Express server for AI-powered inventory management
- **Flutter Mobile App** (`mobile/`): Cross-platform mobile client (optional, requires Flutter SDK)

### Running Services

**Start all core services (web + functions + database + auth):**
```
firebase emulators:start --project demo-atfactoryprice
```
This starts: Auth (:9099), Functions (:5001), Firestore (:8080), Hosting (:5000), Emulator UI (:4000).

**Start the Telegram bot (separate service):**
```
cd telegram-ops-bot && npm start
```
Runs on port 3000. Requires `.env` with `TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_CREDENTIALS_JSON` for full functionality.

### Known Gotchas

- **Binary permissions**: After `npm install` in `functions/`, the binaries in `node_modules/.bin/` may lack execute permission. Fix with `chmod +x functions/node_modules/.bin/*`.
- **Port 8080 conflicts**: If Firestore emulator fails to start with "port taken", kill any orphaned Java processes: check with `lsof -i :8080`.
- **Use `demo-` project prefix**: Run emulators with `--project demo-atfactoryprice` to avoid authentication requirements and production API calls.
- **Node version warning**: Functions specify `"node": "18"` in engines, but emulators run fine on Node 22. The warning is safe to ignore.
- **No ESLint config was committed**: An `.eslintrc.js` was added to `functions/` for lint checks. Run lint via `cd functions && npx eslint .`.
- **Telegram bot starts without tokens**: The bot gracefully handles missing `TELEGRAM_TOKEN` — the Express server still starts and responds on `/health`.

### Lint / Test / Build

| Service | Lint | Test | Run |
|---------|------|------|-----|
| Cloud Functions | `cd functions && npx eslint .` | `cd functions && npm test` (uses firebase-functions-test) | Part of `firebase emulators:start` |
| Telegram Bot | N/A | See `telegram-ops-bot/TESTING.md` | `cd telegram-ops-bot && npm start` |
| Web (static) | N/A | Manual browser testing | Served by Firebase Hosting emulator on :5000 |
