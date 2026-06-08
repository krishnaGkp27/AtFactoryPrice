# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

AtFactoryPrice is a Firebase-hosted e-commerce platform (fabrics/garments, Lagos Nigeria) with an MLM referral system. Three main components:

1. **Web storefront (PWA)** — Static HTML/CSS/JS in repo root, served by Firebase Hosting. Uses Firebase compat SDK v9.22.0 (loaded from CDN). Auth + Firestore calls go directly to the production Firebase project (`atfactoryprice-6ba8f`).
2. **Firebase Cloud Functions** — `functions/` directory, Node.js 18. MLM commissions, wallet ops, fraud detection, Google Sheets sync.
3. **Telegram Operations Bot** — `telegram-ops-bot/` directory, Node.js 18. Express server with AI-powered inventory management via Telegram.

### Running services locally

**Web storefront + Cloud Functions (Firebase Emulators):**
```
cd /workspace
firebase emulators:start --only hosting,functions --project atfactoryprice-6ba8f
```
- Hosting: `http://127.0.0.1:5000`
- Functions: `http://127.0.0.1:5001`
- Emulator UI: `http://127.0.0.1:4000`

The frontend talks directly to the production Firebase Auth/Firestore (no emulator connectors in the client code). The Hosting emulator just serves the static files; the Functions emulator runs Cloud Functions locally.

**Telegram bot:**
```
cd /workspace/telegram-ops-bot
cp .env.example .env   # fill in secrets if available
node server.js
```
- Server: `http://127.0.0.1:3000`
- Health check: `GET /health` → `{"ok":true,"service":"telegram-ops-bot"}`
- Starts successfully even without secrets (warns about missing `TELEGRAM_TOKEN` and Google credentials).

### Gotchas

- **No `.eslintrc` in `functions/`**: The `package.json` has an ESLint `lint` script and `eslint` as a devDependency, but no ESLint configuration file exists. Running `npx eslint .` will fail with "couldn't find a configuration file." This is a repo gap, not a setup issue.
- **No `.firebaserc`**: The repo doesn't include a `.firebaserc`. Pass `--project atfactoryprice-6ba8f` when running Firebase CLI commands.
- **Node.js 18 required**: Both `functions/package.json` and `telegram-ops-bot/package.json` specify `engines.node: "18"` / `">=18"`.
- **Java required for Firebase Emulators**: The Functions emulator needs a JRE (default-jre-headless is sufficient).
- **Package manager**: Both subprojects use `npm` (lockfiles are `package-lock.json`).

### Testing

- See `FEATURE_TESTING_GUIDE.md` for comprehensive manual testing steps.
- See `telegram-ops-bot/TESTING.md` for Telegram bot testing.
- The Telegram bot requires external API keys (Telegram, OpenAI, Google Sheets) for full functionality testing.
- The web storefront's core UI (browse products, cart, signup form) works without authentication via the Hosting emulator.
