# AtFactoryPrice Telegram Operations Bot

AI-powered textile inventory control via Telegram: natural-language commands, Google Sheets backend, OpenAI intent parsing, and admin approval for risky actions.

## Quick start

1. **Setup** — Follow [SETUP.md](./SETUP.md) (Telegram bot, OpenAI key, Google Cloud + Sheets, env vars).
2. **Install** — `npm install`
3. **Run locally** — `npm run dev` (no webhook; use ngrok or deploy to test Telegram).
4. **Deploy** — Use Railway or Render; set `BASE_URL` and run `npm run set-webhook`.

## Env (.env)

Copy `.env.example` to `.env`. Required: `TELEGRAM_TOKEN`, `OPENAI_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_CREDENTIALS_JSON`, `ADMIN_IDS`, `EMPLOYEE_IDS`. Optional: `RISK_THRESHOLD`, `LOW_STOCK_THRESHOLD`, `BOT_API_KEY` (for admin page), `BASE_URL` (for webhook).

| Variable | Default | Meaning |
|---|---|---|
| `CURRENCY` | `NGN` | The accounting CODE only (ledger narrations, FX pair, incentive rows) — never a display unit. Expenses always print `₦`; sale invoices and inventory outputs print a bare number (BUSINESS_RULES §17, CUR-1). Blank = `NGN`. |
| `INVOICE_RATE_MULTIPLIER` | blank = none | Boot default for the Settings cell of the same name (CUR-2): the factor the customer copy of a sale invoice multiplies the entered rate by. The Settings row overrides it without a deploy; the factor is frozen per invoice at issue (`Invoices.rate_multiplier`), and the sheet's own figures are never multiplied. |

## Endpoints

- `POST /webhook` — Telegram sends updates here (set via `npm run set-webhook`).
- `GET /api/settings` — Returns risk thresholds (for admin page).
- `PUT /api/settings` — Update thresholds; auth: `X-API-Key` or admin Telegram ID.
- `GET /health` — Health check.

## Project layout

- `src/config` — Env and app config
- `src/controllers` — Telegram + API handlers
- `src/services` — Inventory business logic
- `src/repositories` — Google Sheets data access
- `src/ai` — Intent parser (OpenAI) + analytics
- `src/risk` — Risk evaluation (approval rules)
- `src/events` — Approval notifications to admins
- `src/middlewares` — Auth, validation

## Admin page

On AtFactoryPrice.com admin panel, set `CONFIG.opsBot.baseUrl` to your deployed bot URL and optionally `CONFIG.opsBot.apiKey`. The **Operations Bot — Risk thresholds** section will load and save limits.
