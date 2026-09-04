# SPL-1 — A than that is really two: the correction, and the door so it never needs a hand-edit again

**Status:** SUPERSEDED 02-Sep-2026 by `EDB-1_EDIT_BALE.md` — the owner generalised the split into "edit the bale card in place"; Part A (6061) is done through that door, Part B is that door.
**Case:** bale 6061 · design 9043-A · shade 6 · Kano office. Label: 6 pcs / 166. Sheet: 5 rows / 166 —
than 1 recorded as 60 yd and sold to Qaribullah (18-Aug); physically two 30-yd pieces, of which he took ONE.
The other 30 yd is still in the bale, unrecorded.

## Owner rulings (this thread)

1. Qaribullah has 30 yd; the bale holds the other 30 → stock is under-recorded by 30 yd, he was billed 60.
2. The correction is **dual-admin** (it rewrites a sold record and touches money).
3. Label numbers are **yards** regardless of the printed "MTRS" — no unit repair.
4. The Inventory sheet is the single source of truth; the owner edits it directly and will hand over
   the sheet so corrections are made in its own row format. `bale_uid` stays internal.

## What `bale_uid` actually touches (so direct sheet edits are safe)

Verified in code, not assumed:

- **Identity for counting, grouping, pickers, statements, audits is NOT the uid.** It is
  `design | printed number | container` (`baleIdentity.baleKey`). A hand-added row is recognised by
  those three cells alone.
- **A blank `bale_uid` is tolerated on read** — the repository substitutes `BAL-LEGACY-<row>` for it.
  The uid is used for exactly three things: pinning in-transit rows to an open transfer (transfer
  service + sentinel check C3), the Postgres mirror column, and the bundle-sale cart's per-than key
  (session-only).
- **Therefore, when editing the sheet by hand:**
  - append new rows at the **bottom**, never insert mid-sheet — the synthetic legacy uid is
    row-position based, so inserting shifts every blank-uid row beneath it and would break any
    open transfer that pinned one;
  - never edit a row whose status is `in_transit`;
  - a blank `bale_uid` on a new row is fine; a generated one (`BAL-YYYYMMDD-<bale>-<4 chars>`, the
    bot's own format) is better and costs nothing — Part A will write one.

## Part A — the data correction for 6061 (on the owner's sheet)

Three writes, in the sheet's own row shape:

| Row | Change |
|---|---|
| than 1 (sold, Qaribullah, 18-Aug) | `Yards` 60 → **30**. Everything else untouched. |
| **new** than 6 (appended) | `PackageNo` 6061 · `Indent` ST/1321 · `Design` 9043-A · `Shade` 6 · `ThanNo` **6** · `Yards` **30** · `Status` available · `Warehouse` Kano office · `PricePerYard` 3500 · `DateReceived`/`arrival_batch`/`grn_id`/`ProductType`/`design_category` copied from its bale-mates · `bale_uid` generated. |
| Qaribullah's money | one **credit** of 30 yd × ₦3,500 = **₦105,000** on `LedgerTransactions`, reference `ST-6061-1`, description naming the label photo as evidence — the same channel RET-3 credits through. |

Why only these: the Supply Statement (SLED-1) and the Movement Ledger are computed from sold
Inventory rows at read time, so the quantity side corrects itself the moment the row changes;
only the persisted money debit needs its matching credit. Than numbers 2–5 are never renumbered
(rule 1: nothing a user has seen changes).

Done once via a dry-run script the owner reads before `--commit`, with the label photo filed as
evidence — not by hand, so the bale_uid and the credit are written in the bot's own formats.

## Part B — the door: ✂️ Split a Than (bot, dual-admin)

Tap-first, no typing, rides the existing pipeline:

1. Admin tile **✂️ Split a Than** (Inventory hub) → pick bale (typed-number search or picker) → pick
   the than → **how many pieces** (chips 2·3·4) → **yards per piece** as chips that must add up to
   the row's yards (the last piece auto-completes) → if the than is **sold**: "how many of these
   pieces did the customer take?" (chips) → **send the label photo** (rule 3: image → operator →
   approval) → confirm card.
2. Queues one `split_than` action (new code — needs sign-off, listed in `ALWAYS_APPROVAL` +
   `DUAL_ADMIN`). The card shows before/after rows, the customer, and the money delta.
3. Executor: rewrites the original row's yards, appends the new than rows (next free than numbers,
   generated uids, bale-mates' intake fields), marks pieces the customer took as sold to them on
   the original sale date, and — when the sold yardage shrinks — posts the correction credit
   through the sale emitter. One audit row; the label photo archived as evidence.
4. Read-only scan `scripts/list-suspect-thans.js`: every than at least **twice** the median of its
   bale-mates, per warehouse, with the bale's row count — the list the owner checks against
   physical labels before the next audit (9043-A's +7 bundles will be on it).

Out of scope: merging thans, changing designs or shades, anything on the website.

## Decisions still open

- D1 The credit's `txn_type` label on Qaribullah's ledger ("sale correction" vs reusing the
  return type) — affects how it reads on his statement.
- D2 Should the scan also DM admins daily (like the bale audit), or stay a script the owner runs?
