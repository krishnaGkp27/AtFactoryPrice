# Sheet audit — 14-Aug-2026 (full-workbook export)

The owner exported the complete live spreadsheet (every tab) and asked for
a complete defect review of the sheets the bot writes. This document is
the result AND the handoff for the fix build: findings, owner rulings
(all locked 14-Aug-2026), and the build queue in order.

The class of defect here is invisible to code review: the code *looked*
correct for every one of these. Only the sheet showed the truth. That is
why this audit exists and why the fixes below are grounded in cell-level
evidence, not in reading the writers.

---

## Root causes — two, and they explain almost everything

**RC-1 · Google's `values.append` is a guess.** `sheetsClient.appendRows`
targets `A:Z` and lets Google *detect* the table. The heuristic anchors
correctly only when the header row spans the full data width with no
gaps. Feed it a ragged header and it walks.

**RC-2 · `USER_ENTERED` writes let Sheets reinterpret values.** Whatever
string the bot writes, Sheets may parse into something else: digit
strings become numbers (phones lose leading zeros), "Mar26"/"July26"
become real dates, "10:00" becomes a time. The bot then reads back the
*displayed* text, so everything works until a format changes.

And one process cause: **schemaMapper heals missing sheets but never
header WIDTH** — columns added by later features (CNET-1a, CUS-1,
customer_id on ledger entries) exist in the data but not in the header
row of sheets that predate them. That is RC-1's food.

---

## Findings

### F1 · Contacts staircase — CRITICAL, contacts invisible (fix queued)

Rows drift diagonally: row 2 at column A, row 3 starts at I, row 4 at T,
rows 5–6 at Z. Solomon, Obinna and both Mr femi rows are OUTSIDE the A:L
range the bot reads → missing from every picker and the network graph.
Cause: header row is 7 columns (A–G), data is 12 wide with a gap at H →
RC-1 walks. This was the missing half of the owner's original "approved
Mr femi but can't see him" complaint.

### F2 · Header narrower than data — same class, 4 more sheets

| Sheet | Header has | Code writes | Orphan data seen |
|---|---|---|---|
| Customers | 12 cols | 13 (`aliases`) | 4 rows, `[]` in unlabelled col M |
| Ledger_Entries | 10 cols | 11 (`customer_id`) | 26 rows of CUST- ids in col K |
| Transactions | 18 named | 19 | 18 rows of CUST- ids in unnamed col S |
| AuditLog | 5 named | 6 | 211 rows in unlabelled col F |

None of these has stair-stepped yet (their data is contiguous from
column A), but each is one gap-column away from Contacts' fate.

### F3 · Container labels are secretly dates — 6,159 cells

Every labelled `Inventory.arrival_batch` cell (2,929 × "Mar26", 3,223 ×
"July26") and 7 `DesignAssets.ArrivalBatch` cells hold real DATE values
(2026-03-26 / 2026-07-26), displaying as "Mar26"/"Jul26" only through
number format `mmmd`. Grouping works because every cell coerced
identically. **Owner ruling: LEAVE AS-IS, document the trap.** The trap,
for every future session: **never reformat Inventory column V or
DesignAssets column P, and never change how batch labels are written** —
a write that lands as text while old cells display through `mmmd` splits
one container into two in every picker. Any future migration to real
text labels is its own guarded one-off with the owner's sign-off.

### F4 · Two customer phones lost their leading zero

Customers rows 29–30: `9484774839`, `8030946228` — stored as numbers,
leading `0` gone. **Owner ruling: repair to international form `+234…`**
("for perfect integration with one-tap call on any messenger"), which is
exactly the E.164 shape `utils/phone.js` already canonicalises to —
`+2349484774839`, `+2348030946228` — written as text so it cannot
re-coerce.

### F5 · Telegram ids stored as numbers — cosmetic, low priority

`Users.user_id`, `PendingUsers.telegram_id`, `ApprovalQueue.User` (394
rows), TaskEvents, UserPrefs, Orders, BranchOpsLog, Attendance,
BaleMovements. Harmless at runtime (FORMATTED_VALUE returns plain
digits; ids are < 2^53 so no precision loss) but fragile the same way as
F3. Future writes of id-like fields go out coercion-proof; existing
cells stay.

### F6 · Stale `pending` DesignAssets rows

9006, 9031-D, 80046 (May) and 77014/77016/77018 (July) — photo approvals
that never resolved. **Owner ruling: LEAVE THEM.**

### F7 · 9037 was never uploaded — CAT-P1 correction

DesignAssets has NO rows for design 9037. The owner's two shade-card
images exist only as chat photos. So the `catalog-pages.js --restore`
step in the CAT-P1 spec is NOT needed for 9037: the owner simply uploads
both images through catalogue upload — the second gets the CAT-P1
"➕ Add as page 2" chip and the album appears. The script stays for
future genuinely-replaced pages.

### F8 · Minor notes (no action queued)

- `Settings.DIGEST_TIME` displays `10:00:00` (coerced to a time value) —
  works today; same F3-class trap if reformatted.
- Users row "Tessa Parker" has an empty branch; `warehouses` CSVs mix
  spacing/trailing commas — parsers trim, cosmetic only.
- `Transactions.SalesDate` mixes 95 date cells + 5 strings — reads are
  already safe via the SDN-2 normaliser pattern; display consistency for
  this column can ride a later pass with the owner's say-so.
- Legacy human tabs (SALES BOOK, BLACKPANTHER, Sheet68/70/71, …) are out
  of scope — the bot never reads them.

---

## Locked owner rulings (14-Aug-2026, this session)

1. Full-workbook audit: done (this document).
2. Mr femi duplicate: plain `CON-...906752ED` → `inactive`; customer-
   bound `CON-...48D9FF53` stays the live one.
3. Stranger first contact: a real-request first message is captured too —
   same polite reply, same PendingUsers row, same 10/hour cap — and the
   admin card QUOTES the first message.
4. Ignore stays a label, not a mute; fix the card's wording that promises
   otherwise.
5. Batch labels: leave as-is (F3), document the trap.
6. Phones: `+234…` text repair (F4).
7. Stale pending DesignAssets: leave (F6).
8. Identity: ONE sheet — PendingUsers becomes the Telegram identity
   register; growth by END-COLUMNS ONLY, one attribute per column, no
   JSON blobs: `link_type` (employee|customer|contact) · `link_id` ·
   `link_name` · `linked_by` · `linked_at` (land at J–N; sheet already
   has A–I with last_notified_msg_id/handled_by/handled_at).
9. Pending-user card becomes the four-button triage (layout approved):
   Onboard as employee / Link to existing customer (CUS-1 pick chips, no
   free text) / Add to network (CNET placement) / Ignore.

## Build queue — ALL SHIPPED 14-Aug-2026

1. ✅ **SHEET-FIX-1** (`cdbbaad`) — `healHeaderWidth` in schemaMapper
   (generic, guards: empty read = failed read; append-only; strict-prefix
   or hands off) + `appendRows` anchored at `A1`.
2. ✅ **SHEET-FIX-2** (`3b9dddd`) — `scripts/repair-contacts-staircase.js`
   (staircase re-lay + Mr femi dup → inactive + phone repair; dry-run
   default). **⚠️ NOT YET RUN against the live sheet — owner step below.**
3. ✅ **SHEET-FIX-3** (same commit) — E.164 phones write as TEXT so the
   `+` survives (sanitizeCell; reversed a SEC-FI1 pin, reason recorded in
   `sheetsClient.formulaGuard.test.js`). Note: the SHEET-FIX-3 items
   "updated_by stores NAME" and "no robot notes / Lagos timestamps in
   Contacts" were NOT built — superseded in priority by the phone-plus
   discovery; still open, listed below.
4. ✅ **IDR-1** (`6d74e40`) — PendingUsers J–N link columns +
   `identityService` (spec: `specs/IDR-1_IDENTITY_REGISTER.md`).
5. ✅ **IDR-2** (same commit) — four-chip triage card, first-message
   quote, every-stranger capture, solid-record link pickers.

---

## State at pause (14-Aug-2026, session close-out)

**Owner steps pending (in order):**
1. Confirm the bot redeployed (header heal runs at boot), then run
   `node scripts/repair-contacts-staircase.js` (dry-run) → `--commit`.
   Until then Solomon, Obinna and both Mr femi Contacts rows stay
   invisible to pickers/network.
2. `node scripts/format-date-columns.js --commit` (SDN-2 display half;
   read-side normaliser is live, so it is safe) — if not already run.
3. Seed the `Locations` sheet (`Kano office | Kano | store | active` …)
   — until then VRF-2's store bill-check skip does not take effect.
4. Upload 9037's two catalogue photos (second gets "Add as page 2");
   test the album picker.
5. Test the new-user triage live (fresh account → four-chip card).

**Awaiting owner ruling:**
- AuditLog column D is HEADED "Module" but the writer puts the USER ID
  there (211+ rows). Fix = header rename → needs explicit sign-off.
- Contacts writer elegance leftovers (see item 3 above): `updated_by` as
  name-not-id, human-readable Contacts timestamps, drop "CNET shadow
  node (auto)" notes text.

**Open feature discussions (owner-initiated, not started):**
- Sales approval card layout redesign + "process pipeline channel" — my
  4 clarifying questions were never answered (what "status" means on the
  card; triage vs history; Telegram channel?; what must not appear
  publicly).
- INV-SEND (invoice → WhatsApp/Telegram, low priority):
  `specs/INV-SEND_RESEARCH.md`. IDR-1's `telegramIdFor()` now provides
  the customer→chat lookup it was missing.
