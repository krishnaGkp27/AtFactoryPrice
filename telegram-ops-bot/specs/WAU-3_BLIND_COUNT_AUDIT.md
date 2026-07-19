# WAU-3 — Blind-count warehouse audit (owner-locked 20-Jul-2026)

Replaces the WAU-2 checkbox checklist. Owner decisions locked across
19-20 Jul: blind counting (auditor NEVER sees book quantities), the book
figure is never revealed to the counter even after a flag (admins only),
flagged designs lock for the day until an admin clears, offline-first
batch template because warehouse network is poor, PLUS an easy tappable
online mode.

## The two input modes (one reconcile engine)

**Online (tappable):** 🏭 Warehouse Audit → location → warehouse → blind
design list (⬜ pending / 🔁 recount / 🚩 locked / ✅ done — no numbers).
Tap a design → inline NUMBER PAD (digits, ➕, ⌫) to compose `12` or
`12+5` (bales+loose bundles) → ✔ Done:
- match → ✅ toast, StockTakes `reconciled` row (with counted_*), back to list
- 1st miss → "recount CAREFULLY" (no figures leaked), pad re-opens
- 2nd miss → 🚩 `flagged` row + DM card to every admin (counted vs book,
  auditor name, [✅ Clear flag] button) + design locked for the day

**Offline (batch template):** 📄 Offline count sheet button sends
`AUDIT <warehouse>` + one `design =` line per open design. The auditor
copies it, fills lines while walking with NO network (`9032 = 12+5`),
sends when back in coverage — Telegram's outbox delivers it. The message
is processed STATELESSLY (header carries the warehouse; works hours later
with no session) and answered with one results card: ✅ reconciled /
🔁 recount-these (mini-template included) / 🚩 flagged / 🔒 locked /
⬜ left blank / ❓ unknown designs.

## Access + blindness

- Flow open to all authorized staff (was admin-only); tile visibility for
  a department comes from its allowed_activities CSV (`warehouse_audit`).
- 🔬 Deep inspect (reveals bale/than book detail) is ADMIN-ONLY.
- Admin flag card is the only place book vs counted figures meet.

## Storage (rule 5b — append-only, verdicts derived at read time)

StockTakes gains end columns K-M: counted_bales, counted_bundles, note.
result values: `reconciled` | `mismatch` (attempt 1) | `flagged` (attempt
2, locks) | `flag_cleared` (admin unlock row). Day-lock/holding/recount
states are all derived; nothing is ever mutated or deleted. WAU-2's
self-invalidating reconciliation (stock change ⇒ back to holding) is
unchanged.

## Deferred (owner decision menu)

- WAU-4 dual-auditor layer (both count independently, three-way agreement
  matrix, sync fingerprinting, GPS gate via attendance anchors) — design
  agreed 19-Jul, ships behind an AUDIT mode switch when first-round
  testing of WAU-3 passes.
- Photo evidence on flags (reuse ATT-C4 photo machinery).
- Auto-adjustment of Inventory from confirmed discrepancies (today flags
  are evidence only; corrections stay manual admin work).
