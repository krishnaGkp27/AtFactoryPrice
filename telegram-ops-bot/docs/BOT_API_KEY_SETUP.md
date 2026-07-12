# BOT_API_KEY — Setup & Verification Guide

**Audience:** owner. **Time:** ~5 minutes.
**Why now:** the ANL-1 analytics dashboard (rollout step 4) and the existing
admin-page threshold editor both authenticate to the bot with this key.
**Verified live 12-Jul-2026** against the running bot (results in §5).

---

## 1 · What BOT_API_KEY is

The single credential accepted by the bot's HTTP admin API (SEC-P1 H5).
Callers present it in the `X-API-Key` header (or `?apiKey=` query param).

| State | GET /api/settings | PUT /api/settings | /api/analytics/* (ANL-1) |
|---|---|---|---|
| Key **not set** (today's production) | open — read-only thresholds | **503 disabled** | 503 disabled |
| Key **set** | requires key (403 without) | requires key (403 without) | requires key |

It does **not** grant Telegram powers, sheet access, or money actions —
only threshold writes and (once ANL-1 ships) read-only usage aggregates.

## 2 · Generate a strong key

PowerShell (any machine):

```powershell
-join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_})
```

Copy the 48-character output. Never commit it to git; never paste it in chat.

## 3 · Set it on Railway (production)

1. Open the Railway project → **AtFactoryPrice** app service (not Postgres).
2. **Variables** tab → **+ New Variable**:
   - `BOT_API_KEY` = the generated key
3. Same tab, also set the CORS allow-list so only your site may call the API
   from a browser:
   - `ADMIN_ALLOWED_ORIGINS` = `https://atfactoryprice.com,https://www.atfactoryprice.com`
   (add your `*.web.app` / `*.firebaseapp.com` preview domain if you use it)
4. Railway redeploys automatically (~1 min).

## 4 · Verify after deploy (copy-paste)

```powershell
# A) no key -> expect 403 (proves the gate is ON)
Invoke-WebRequest https://YOUR-APP.up.railway.app/api/settings -UseBasicParsing

# B) correct key -> expect 200 with thresholds JSON
Invoke-WebRequest https://YOUR-APP.up.railway.app/api/settings -UseBasicParsing `
  -Headers @{ "X-API-Key" = "PASTE-KEY-HERE" }

# C) wrong key on a write -> expect 403
Invoke-WebRequest https://YOUR-APP.up.railway.app/api/settings -Method PUT `
  -ContentType "application/json" -Body '{"riskThreshold":300}' `
  -Headers @{ "X-API-Key" = "wrong" } -UseBasicParsing
```

A=403, B=200, C=403 → done.

## 5 · Tested behavior record (local bot, 12-Jul-2026)

| Test | Result | Expected |
|---|---|---|
| PUT with key unset | **503** "Settings API is disabled" | ✅ |
| GET with key unset | **200** (read-only open) | ✅ |
| GET without key, key set | **403** | ✅ |
| GET with correct key | **200** | ✅ |
| PUT with wrong key | **403** | ✅ |

Implementation: `src/controllers/apiController.js` (guard), `server.js`
(CORS allow-list, `X-API-Key` in allowed headers).

## 6 · Where the key gets used

- **admin.html** → Operations Bot settings section (write thresholds).
- **admin-analytics.html** (ANL-1 step 5) → paste the key once on first open;
  it is stored in that browser's localStorage only (owner decision D1 v1).
  Upgrade path: Firebase Function proxy so the key never reaches a browser.

## 7 · Care & feeding

- **Rotate** by generating a new key and replacing the Railway variable
  (old key dies on redeploy); re-paste into the admin pages.
- If a device with the key in localStorage is lost → rotate immediately.
- The local dev bot may keep its own throwaway key in `telegram-ops-bot/.env`
  (currently a test key from this verification) — unrelated to production.
