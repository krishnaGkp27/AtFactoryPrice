# Cowork task dump — onboarding & My Products card display audit (UI/UX)

Paste the block below into a Claude Cowork chat as-is. It audits the
Telegram card rendering for the onboarding path (Part 1) and, once
MYP-1 ships, the My Products chips — offline, zero credentials, using
the repo's own harness. Written 23-Aug-2026 at the owner's request.

---

TASK — Audit the AtFactoryPrice Telegram bot's onboarding and My
Products CARD RENDERING for display defects. OFFLINE ONLY.

SETUP
1. Clone https://github.com/krishnaGkp27/AtFactoryPrice and work in
   telegram-ops-bot/. npm install. Baseline first: `npm test` and
   `npm run smoke` must be green before you audit anything — if red,
   STOP and report; do not audit on a broken base.
2. Everything runs with ZERO real credentials (repo rule): the
   characterization harness at test/helpers/controllerHarness with
   fakeSheets + fakeBot renders real cards without Telegram or Google.

AUDIT — drive each surface through the harness and capture every
rendered card (fakeBot records text + reply_markup):
A. Stranger path: first message → capture card to admins; 2nd/3rd
   message → the SAME card edited (IDR-3), log lines "HH:MM — _text_";
   a lone bare greeting → NO message log block (IDR-2 rule).
B. Triage chips: exact set and order; every callback_data ≤ 64 BYTES
   (measure bytes, not chars — ids ride the payload).
C. Add Employee wizard steps 1–7 (marketer role chip path): every
   step's card + Back/Cancel rows; the two no-warehouse warnings.
D. Allocate to Marketer (mal:): all four steps; qty chips; confirm.
E. My Products: empty state; category chips; per-design card. After
   MYP-1 ships also: sdg-grammar chips `📦 <design> — XB / YB` with a
   fixture matching the owner's screenshot (9037 70/94 … 408/204
   13/13) — verify ✅ appears only when X ≥ Y never otherwise.

CHECK EVERY CAPTURED CARD FOR:
- Markdown-v1 breakage: unescaped _ * ` [ ] in user-supplied strings
  (names like "M_usa" or "O*wai" must render escaped — inject such
  fixtures); unbalanced entities that make Telegram reject the send.
- callback_data > 64 bytes (Telegram silently truncates → dead chip).
- Keyboard shape: ≤ 8 buttons per row, ≤ 100 per message; chip label
  overflow (>~40 chars ellipsized mid-word looks broken on phones).
- Message length > 4096 chars (send fails) and caption > 1024.
- Every card has at least one tappable exit (no dead-end cards —
  house rule SBL-2b), and Cancel/Close rows also offer a menu path
  (NAV-3).
- Empty-state texts present and polite (no raw "undefined", no bare
  error strings).

GUARDRAILS — HARD RULES
- OFFLINE ONLY: no real bot token, no Sheets credentials, no network
  calls to Telegram/Google. Never touch .env.
- Do NOT modify src/ code. Findings are REPORTED, not fixed. You may
  add throwaway test files under test/ to drive the harness; delete
  them before finishing, or leave them ONLY on your own branch.
- Push nothing to main. If asked to persist the audit, commit the
  REPORT ONLY to a branch named cowork/card-audit-<date> and say so.
- If the harness cannot reach a card (feature not yet built — e.g.
  MYP-1 pre-implementation), mark it SKIPPED with the reason; never
  simulate a result.

DONE MEANS
A findings table: card / defect / severity (breaks send > dead chip >
looks wrong > cosmetic) / exact fixture that reproduces it — plus the
list of cards checked clean, and the skipped list. No screenshots
needed; the captured text + keyboard JSON is the evidence.
