# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

AtFactoryPrice is a Firebase-based e-commerce platform for premium fabrics and garments. It has three main components:

| Component | Location | Stack |
|-----------|----------|-------|
| Web Storefront + Admin | `/workspace/` (root HTML/CSS/JS files) | Vanilla JS, Firebase SDK (CDN), PWA |
| Cloud Functions | `/workspace/functions/` | Node.js, firebase-functions, firebase-admin |
| Telegram Ops Bot | `/workspace/telegram-ops-bot/` | Node.js, Express, OpenAI, Google Sheets |

There is also a Flutter mobile app in `/workspace/mobile/` but it requires Flutter SDK and Firebase config files not in the repo.

### Running the development environment

Start Firebase emulators for local development:

```
firebase emulators:start --only hosting,auth,firestore --project atfactoryprice-6ba8f
```

This starts:
- **Hosting** on `http://localhost:5000` (serves the static web frontend)
- **Auth emulator** on `http://localhost:9099`
- **Firestore emulator** on `http://localhost:8080`
- **Emulator UI** on `http://localhost:4000`

The web frontend JS connects to the **production** Firebase project (API key is hardcoded in `js/auth-ui.js` and individual HTML files). The hosting emulator only serves static files; Auth/Firestore calls go to production Firebase unless you add emulator connection code.

To include Cloud Functions in the emulator, add `functions` to the `--only` flag, but note the functions require Node 18 (the `engines` field in `functions/package.json`) while the environment has Node 22. The functions emulator will run with the host Node version.

### Lint

The `functions/package.json` has a `"lint": "eslint ."` script, but **no `.eslintrc` config file exists** in the repo. Running `npm run lint` in `functions/` will fail with "ESLint couldn't find a configuration file." This needs to be addressed by the project maintainer.

### Testing

No automated test suites exist for the web frontend or Cloud Functions. The `firebase-functions-test` package is listed as a dev dependency in `functions/package.json` but no test files exist. The Flutter mobile app has a `test/` directory stub.

### Telegram Ops Bot

Requires a `.env` file with `TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_CREDENTIALS_JSON`, `ADMIN_IDS`, `EMPLOYEE_IDS`. See `telegram-ops-bot/README.md` for details. Run with `npm run dev` from `telegram-ops-bot/`.

### Key gotchas

- The `.firebaserc` file and emulator config in `firebase.json` were added as part of dev environment setup. If they are missing, create `.firebaserc` with project ID `atfactoryprice-6ba8f` and add emulator port config to `firebase.json`.
- Firebase CLI must be installed globally: `npm install -g firebase-tools`.
- Java is required for the Firestore emulator (OpenJDK 21 works).
- The `functions/node_modules/.bin/eslint` binary may have incorrect permissions after `npm install`; run `chmod +x` if needed.
