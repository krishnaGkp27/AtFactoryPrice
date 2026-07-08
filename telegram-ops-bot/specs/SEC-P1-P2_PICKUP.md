# SEC-P1 / P2 — pickup checklist

Everything below is **shipped to `main`** (auto-deploys on Railway). The security
hardening is live EXCEPT the webhook fail-closed guard, which is deployed but
**dormant** until you flip one env flag. This doc is the short list of what's
left on your side.

Full analysis + phase plan: `telegram-ops-bot/docs/CODE_AUDIT_2026-07-07.md`.

---

## ✅ Live now (pushed, no action needed)

- **C2** — button taps go through the allow-list gate (revoked users blocked).
- **C3** — a sale confirm/cancel only works for the user who owns that sale.
- **H1** — an admin can't approve their own request when a 2nd admin exists.
- **H5** — `/api/settings` accepts only `X-API-Key`; CORS is an allow-list.
- **C4** — concurrent Approve taps can't double-apply a sale/payment/stock move.
- **C5** — an already-sold than can't be re-sold by a racing approval.
- **H3** — transfer dispatch/receive/abort can't double-move bales.
- **H7** — office-expense / landed-cost approvals now mark the row approved.

## 🔧 Your task — turn ON webhook enforcement (10 min)

The webhook currently accepts any POST if no secret is set (an open webhook =
anyone who knows the URL can forge admin updates). The fix ships dormant so the
deploy didn't crash-loop. Activate it **in this order** (order matters):

1. Generate a secret:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. Railway → service → Variables → add `TELEGRAM_WEBHOOK_SECRET` = that value.
   (Railway redeploys; still fine — enforcement is off.)
3. Register it with Telegram — from Railway shell (or locally with the same
   value + `TELEGRAM_TOKEN` + `BASE_URL` in `.env`): `npm run set-webhook`.
   Expect `Secret token registered with Telegram`.
4. Railway → Variables → add `REQUIRE_WEBHOOK_SECRET=1`. Redeploy.
5. Verify: logs show a clean boot (no `FATAL`), the bot still responds to a
   real message, and a `curl -X POST https://<base>/webhook` with no secret
   header returns **401**.

If you skip step 1–3 and set `REQUIRE_WEBHOOK_SECRET=1` first, the bot will
refuse to boot (by design) — just unset the flag or set the secret to recover.

### Optional, same screen
- `BOT_API_KEY` — only if the admin settings page must WRITE thresholds; the
  page must then send it as `X-API-Key`. Reads work without it; writes are
  disabled without it (safe).
- `ADMIN_ALLOWED_ORIGINS` — comma-separated origin(s) for the admin page.

## 🧪 Still pending from before (unchanged)
- TRF-5 manual live test — `specs/TRF-5_TEST_STEPS.md` (owner).
- BKP-1 backup + Drive-quota — `specs/BKP-1_EMIN_CHECKLIST.md` (Emin).

## ⏭️ Remaining agent-side work (for a fresh session, not on you)
Resume from `docs/CODE_AUDIT_2026-07-07.md`:
- **H6** (deferred) — surface "inventory applied but ledger update failed" to
  the admin (needs a small `approvalEvents.js` edit).
- **P3** — resource safety: download size cap, `data/ocr` retention, JSON body
  limit, per-user rate limit before OpenAI.
- **P4** — access-control polish (gate typed value-reports, callback re-checks).
- **P5** — dependency vulns (`npm audit fix`; decide on `xlsx`).
- **P6** — performance (users-sheet cache, batched writes, escape helper).
- **P7** — customer-balance single source of truth (design decision).
