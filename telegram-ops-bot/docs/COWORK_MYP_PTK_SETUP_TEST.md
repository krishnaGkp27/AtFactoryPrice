# Cowork task dump — activate Snap Task OCR, seed one marketer, run the field tests

Paste the block below into a Claude Cowork chat as-is. Written
23-Aug-2026 at the owner's request. Two owner-side setup works plus the
guided field test for PTK-1 (Snap Task) and MYP-1 (My Products), with
guardrails.

---

TASK — Three works, in order, for the AtFactoryPrice Telegram ops bot.
Guide the owner step by step; do only what each work names.

WORK 1 — RAILWAY: turn on the OCR master switch (env only)
1. Open the Railway project → the AtFactoryPrice APP service (never the
   Postgres service) → Variables.
2. VERIFY whether OCR_ENABLED already exists. If it is already true,
   report that and change nothing — the bill OCR runs on this same
   switch and flipping it off/on pointlessly restarts the service.
3. If absent or false: set OCR_ENABLED=true. ONE redeploy.
4. Optional cost note for the owner (informational — change nothing
   unless he says so): task notes read on a cheap model by default
   (OCR_TASKNOTE_MODEL, default claude-haiku-4-5-20251001); the strong
   model stays reserved for bale labels and bill checks; the shared
   daily cap is Settings OCR_DAILY_CAP (default 100 reads).
GUARDRAILS: touch ONLY OCR_ENABLED. Never open, print, or modify
TELEGRAM_BOT_TOKEN, GOOGLE_* credentials, ANTHROPIC/OPENAI keys,
DATABASE_URL or any other variable. Never echo secret VALUES anywhere.
If the deploy fails, capture the last ~30 log lines, change nothing
else, stop and report.

WORK 2 — TELEGRAM: seed one linked marketer (the owner taps; you guide)
1. Register the marketer: Menu → Sales & Marketing → Marketers →
   Register Marketer. Fill name/phone/area/photos. A SECOND admin must
   approve (register_marketer) before the person is active.
2. From a spare/test Telegram account, message the bot once ("hi").
3. On the admin triage card that arrives, tap 📣 Link as marketer and
   pick the person registered in step 1. The card confirms the link.
4. Verify: from the test account send "hi" — the menu must show exactly
   ONE tile, 📦 My Products. If the person has no purchase history and
   no allocation, the polite empty state is CORRECT, not a bug.
GUARDRAILS: use a TEST account, never a real customer's number. Do not
onboard the marketer through 👔 Onboard as employee — that creates
staff (§16: a marketer is NOT company). If a step's card differs from
this script, STOP and report with a screenshot; never improvise taps
on approval cards.

WORK 3 — FIELD TESTS: run the two checklists
Run the owner's test PDF (Snap_Task_and_My_Products_Test_Steps.pdf)
top to bottom — 10 checks per feature — with these CORRECTIONS from
the 23-Aug STK-PRIV ruling (the PDF's original rows predate it):
- MY PRODUCTS row 4: chips read `📦 9037 — 70B` (supplied to them
  ONLY). There is NO second number. Seeing any live stock count as a
  non-admin is a FAILURE, not a pass.
- MY PRODUCTS row 5: the card reads `Allocated: N B · ✅ In stock`
  (or ⛔ Out of stock) — a word, never a count. No prices anywhere.
- Add one check: as a SALESMAN account, open My Products — designs,
  shades and price only; any bale/than/yard count is a FAILURE.
- SNAP TASK row 2 unchanged; note the read now runs on the cheap
  model — quality should stay fine for typed/printed captions; if
  handwriting reads poorly, report it (the owner can raise
  OCR_TASKNOTE_MODEL rather than accept bad reads).
REPORT: row number + screenshot + one line per failure; the clean rows
as a list. Do not fix anything in code or sheets; findings go to the
owner.
