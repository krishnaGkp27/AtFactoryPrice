# EDB-1 — ✏️ Edit Bale: the bale card edited in place, dual-admin, CRUD on the Inventory sheet

**Status:** SHIPPED 02-Sep-2026 (Telegram). Supersedes the split-only door in
`SPL-1_THAN_SPLIT.md` Part B; SPL-1 Part A (the 6061 data fix) is now done
*through this door*, not by script.

## The owner's words (02-Sep-2026)

> "The small quantum of change that could happen would be a bale's details
> having the difference of physical attributes coming from the sheet. We can
> make an arrangement to edit the Telegram card of bale in place, which will
> be gated through dual admin approvals. Upon making the changes it will
> create the CRUD operation on my main inventory sheet."
>
> "Since I'm not polishing the money-related activities, leave the decision
> based on credit or the statements for now."

Rulings recorded: dual-admin; label numbers are yards; money deferred; the
Inventory sheet is the single source of truth and the owner also edits it by
hand (the uid guidance below keeps that safe).

## What it does

Menu → 📦 Inventory → **✏️ Edit Bale** (admin-only) → type the bale number →
(if the number lives in two stores/containers, tap which) → **the card**:

```
✏️ Edit Bale 6061 · 9043-A · #6 · Kano office
Indent: ST/1321 · 📦 Feb26
5 thans · 166 yd  →  6 thans · 166 yd

#1 · 60 → 30 yd · 🔴 sold → Qaribullah (18-Aug-2026)
#2 · 30 yd · 🔴 sold → Ahmad (Mai Glass) (27-Feb-2026)
#3 · 25 yd · 🟢
#4 · 24 yd · 🟢
#5 · 27 yd · 🔴 sold → Qaribullah (06-Aug-2026)
🆕 #6 · 30 yd · 🟢 new

📎 Label photo: ✅ attached
⚠️ A sold than changes yards — the customer was billed for the old figure. Reconcile later; not part of this edit.
2 change(s) pending
[🧵 9043-A] [🎨 #6] [🧾 ST/1321]
[#1 · 30 yd ✎] [#2 · 30 yd]  [#3 · 25 yd] [#4 · 24 yd]  [#5 · 27 yd]
[🆕 #6 · 30 yd  ✖ drop]
[➕ Add a than]  [📎 Replace label photo]
[✅ Send for approval (2)]
[⬅ Another bale] [❌ Cancel]
```

- **Editable** (the physical attributes a label carries): design · shade ·
  indent (header, stamped on every row) · yards of each than · adding a than.
- **Not editable here:** status, customer, sale date, price (sales / returns /
  finance), warehouse (transfers), *removing* a than (see Deferred).
- **Tap-first:** yards chips are the lengths already in the bale; a typed
  number is the fallback, validated (1–2000, one decimal). Shade offers the
  catalogue's tab numbers when the design has a shade book.
- **Evidence:** the label photo is required before ✅ Send
  (`EDIT_BALE_PHOTO_REQUIRED`, default 1) and reaches the approvers first.
- **Approval:** one `edit_bale` action, in `ALWAYS_APPROVAL_ACTIONS` and
  `DUAL_ADMIN_ACTIONS`; requester cannot self-approve; inbox category
  📦 Stock intake. The card shows before → after per row, built from the SAME
  plan the executor applies.
- **Executor** (`baleEditService.apply`): re-reads the bale and **refuses if
  any row moved** since the proposal (sold, transferred, edited — APC-1),
  then: header cells stamped on every row, changed yards on their rows,
  `UpdatedAt` set, new thans **appended at the bottom** with the next free
  number, a generated `bale_uid` and every intake field copied from their
  bale-mates. One AuditLog row (`edit_bale`) with the change list and the
  label file id. Both admins and the requester get the "what changed" line.

## Identity and the owner's hand edits (verified in code)

- Identity for counting, pickers, statements, audits is
  `design | printed number | container` (`baleIdentity.baleKey`) — **not** the
  uid. A hand-added row is recognised by those three cells.
- A blank `bale_uid` is tolerated on read (`BAL-LEGACY-<row>` is substituted).
  The uid is used only to pin in-transit rows to an open transfer, in the
  Postgres mirror column, and as the sale cart's per-than key.
- Therefore, hand edits stay safe if rows are **appended, never inserted**
  (the synthetic uid is row-position based) and **in-transit rows are left
  alone**. This door obeys both.

## Deferred (owner's call)

- **Removing a than.** A physical delete shifts every row beneath it (row-
  addressed writes, legacy uids); a `removed` status would leak into every
  "all statuses" reader (opening pairs, the roster). Until the owner picks the
  shape, a bale with too many rows is reported, not edited.
- **Money.** A sold than whose yards shrink leaves the customer billed for the
  old figure. The card and the approval reply say so; nothing is credited.
  Picks up with the financial reconciliation.
- A **suspect-than scan** (thans ≥ 2× their bale-mates' median) for the owner
  to check against labels before the next audit — small script, on request.

## Test steps (owner, 3 minutes)

1. Inventory → ✏️ Edit Bale → type `6061` → the card shows 5 thans · 166 yd.
2. Tap `#1 · 60 yd` → tap `30 yd` → tap ➕ Add a than → `30 yd` → the card reads
   6 thans · 166 yd with the ⚠️ sold-yardage note.
3. 📎 Label photo → send the photo of the bale label → ✅ Send for approval (2).
4. Second admin approves the card *✏️ Edit bale 6061 …* → reply says
   "Bale 6061 corrected — 1 row(s) updated, 1 than(s) added. Now 6 thans · 166 yd".
5. Sheet: than 1 = 30 yd (still sold to Qaribullah), a new than 6 = 30 yd
   available at the bottom with a `BAL-…-6061-…` uid. Details of Bale 6061 in
   the bot shows 3/6 available, 79 yd.

Rollback of a wrong edit: another edit through the same door.
