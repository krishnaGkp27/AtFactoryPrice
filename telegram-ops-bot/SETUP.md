# AtFactoryPrice Telegram Operations Bot — Setup

Follow these steps before running or deploying the bot.

---

## 1. Telegram Bot Creation

1. Open Telegram and search for **@BotFather**.
2. Send `/newbot` and follow the prompts (name and username, e.g. `AtFactoryPrice Ops` and `AtFactoryPriceOpsBot`).
3. Copy the **bot token** (e.g. `7123456789:AAH...`). This is your `TELEGRAM_TOKEN`.
4. **Webhook** will be set after deployment (see Hosting section). Command:
   ```bash
   BASE_URL=https://YOUR-APP-URL node scripts/set-webhook.js
   ```

---

## 2. OpenAI API Key

1. Go to [platform.openai.com](https://platform.openai.com) and sign in or create an account.
2. Open **API keys**: [https://platform.openai.com/api-keys](https://platform.openai.com/api-keys).
3. Click **Create new secret key**. Name it (e.g. "AtFactoryPrice Bot") and copy the key. Store it as `OPENAI_API_KEY` in `.env`.
4. **Billing**: Ensure you have credits or a payment method under **Billing** so the API can be used.
5. Model: default is `gpt-4o-mini`. To use `gpt-4o`, set `OPENAI_MODEL=gpt-4o` in `.env`.

---

## 3. Google Cloud & Sheets API

1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. **Create a project** (or select one): Project name e.g. "AtFactoryPrice Ops", then Create.
3. **Enable Google Sheets API**:
   - APIs & Services → Library → search "Google Sheets API" → Enable.
4. **Create a Service Account**:
   - APIs & Services → Credentials → Create Credentials → Service Account.
   - Name it (e.g. "telegram-ops-bot"), then Create and Continue → Done.
5. **Create a key** for the service account:
   - Click the new service account → Keys → Add Key → Create new key → JSON → Create. A JSON file will download.
6. **Use the JSON in the bot**:
   - Either paste the entire JSON into `.env` as one line:  
     `GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}`  
   - Or copy the file into the project (e.g. `credentials.json`) and in code read from file (you’d need to add that loading in `src/config` if you prefer file over env).
7. **Share your Google Sheet** with the service account:
   - Open the JSON and copy the `client_email` (e.g. `xxx@yyy.iam.gserviceaccount.com`).
   - Open your Google Sheet (ID: `1DmZMmXi-X82UfCVkeO_5O9N2mPSlMaE0lKX2giRL-6s`) → Share → add that email as **Editor**.

---

## 4. Google Sheets Structure

Use one workbook with these sheets (create tabs if missing):

| Sheet name   | Purpose        | Columns (row 1) |
|-------------|----------------|------------------|
| **Inventory**   | Stock by design/color/warehouse | Design \| Color \| Bale \| Qty \| Price \| Warehouse \| UpdatedAt |
| **Transactions** | All inventory actions           | Timestamp \| User \| Action \| Design \| Color \| Qty \| Before \| After \| Status |
| **ApprovalQueue** | Pending admin approvals       | RequestID \| User \| ActionJSON \| RiskReason \| Status \| CreatedAt \| ResolvedAt |
| **AuditLog**     | Raw events                     | Timestamp \| EventType \| Payload \| User |
| **Settings**     | Risk thresholds (optional)     | Key \| Value \| UpdatedAt |

- **Inventory**: Warehouses are dynamic (any value in the Warehouse column). Add rows as needed.
- **Settings**: Optional. Add rows e.g. `RISK_THRESHOLD` / `300` and `LOW_STOCK_THRESHOLD` / `100` to override env defaults.

---

## 5. Environment Variables (.env)

Copy `.env.example` to `.env` and set:

```env
TELEGRAM_TOKEN=<from BotFather>
OPENAI_API_KEY=<from OpenAI>
GOOGLE_SHEET_ID=1DmZMmXi-X82UfCVkeO_5O9N2mPSlMaE0lKX2giRL-6s
GOOGLE_CREDENTIALS_JSON=<paste full JSON or leave empty if using file>
ADMIN_IDS=7863545956
EMPLOYEE_IDS=7430648262
RISK_THRESHOLD=300
LOW_STOCK_THRESHOLD=100
PORT=3000
BASE_URL=https://your-deployed-url.com
CURRENCY=NGN
BOT_API_KEY=<optional; for admin page to update settings>
```

---

## 6. Hosting (Railway or Render)

### Option A: Railway (recommended for webhooks — no spin-down)

1. Sign up at [railway.app](https://railway.app).
2. New Project → Deploy from GitHub repo (select AtFactoryPrice, root or `telegram-ops-bot` folder).
3. Add environment variables in Railway dashboard (same as `.env`). For `GOOGLE_CREDENTIALS_JSON`, paste the whole JSON in one line.
4. Set **BASE_URL** to your Railway URL (e.g. `https://your-app.up.railway.app`).
5. After first deploy, run locally (with `.env` and `BASE_URL` set):
   ```bash
   npm run set-webhook
   ```

### Option B: Render

1. Sign up at [render.com](https://render.com).
2. New → Web Service → Connect repo, root or `telegram-ops-bot`.
3. Build: `npm install`, Start: `npm start`. Add all env vars.
4. **Note**: Free tier spins down after ~15 min inactivity; first request after that may be slow (webhook will still be delivered when the service wakes).
5. Set **BASE_URL** to your Render URL (e.g. `https://your-app.onrender.com`), then run:
   ```bash
   npm run set-webhook
   ```

---

## 7. After Deployment

1. Set the webhook: `BASE_URL=https://YOUR-URL npm run set-webhook` (from a machine that has the same `TELEGRAM_TOKEN` in env).
2. Send a message to your bot from a Telegram account whose ID is in `EMPLOYEE_IDS` or `ADMIN_IDS`.
3. (Optional) On the AtFactoryPrice admin page, configure the **Operations Bot** base URL and (if set) **API key** so risk thresholds can be read and updated from the admin panel.

---

## 8. Admin Page — Risk Thresholds

The bot exposes:

- **GET /api/settings** — returns `riskThreshold`, `lowStockThreshold`, `currency`.
- **PUT /api/settings** — body `{ "riskThreshold": 300, "lowStockThreshold": 100 }`. Auth: header `X-API-Key: <BOT_API_KEY>` (or admin Telegram ID).

On the AtFactoryPrice admin page, add a section that calls your deployed bot URL (e.g. `https://your-bot.up.railway.app`) and, if you set `BOT_API_KEY`, send it in `X-API-Key` when saving thresholds.
