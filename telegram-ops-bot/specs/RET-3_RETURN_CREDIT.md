# RET-3 — an approved return credits the buyer (shipped 02-Sep-2026) · RET-4 — the return card (layout, awaiting go)

Owner, 02-Sep-2026: *"make it simple … make the foundation and structure in such
a way that we can add to it going forward. Dual admin per than is important.
Date, photo and condition on the return card are required. Let me know the
layout before implementation."*

## Part A — RET-3, shipped

**Defect.** The approved-return executors posted the ledger event without a
rate, and `accountingService.recordReturn` skips the row when the amount is
zero. Stock came back; the customer's debt stayed. (Audit theme 1,
`docs/APPROVAL_BUSINESS_AUDIT_2026-09-01.md`.)

**Rate source, in order** (`inventoryService.returnCreditFor`):

1. `pricePerYard` on the request — the slot the return card fills once it
   asks for or shows a rate. Empty today.
2. The sold Inventory row's own price. The sale executor stamps the enriched
   sale rate onto the row, so this is the booked rate unless a price edit
   followed the sale. Transactions could not be the source: it has no bale
   column to look up by.
3. Nothing → the stock still flips, and the missing credit is reported as a
   book failure on the approve reply (🛑 line) and in AuditLog
   (`erp_hook_failed`), never a silent ₦0.

A whole-bale return of thans priced differently credits the exact sum (the
ledger row carries the weighted rate that reproduces it).

**What else changed.**

- The credit rides the propagating emitter (`erpEmitAsync`), like the sale
  debit it undoes: a failed ledger write is reported, not swallowed.
- The approve reply says what was credited, to the admin and to the requester
  (`result.creditNote`): *↩️ Credited ₦75,000 to ABBA (30 yds × ₦2,500/yd).*
- The Transactions return row now carries warehouse, customer name, customer
  id, request id and rate (existing columns; nothing renamed).
- Foundation for RET-4: a request's `returnedOn` reaches the BaleMovements
  `MovedOn` date and the movement's business day. Absent, today.
- `scripts/list-uncredited-returns.js` (read-only, `--csv`) lists every past
  approved return with no ledger credit, priced at the bale's rate today, so
  the owner can decide about a backfill with the numbers in front of him.
  **No backfill is written by anything.**

Tests: `test/unit/services/returnCredit.test.js` (7),
`test/unit/scripts/listUncreditedReturns.test.js` (2), smoke S54.15.

**Owner steps.** Run `node scripts/list-uncredited-returns.js` once; tell me
whether past returns get credited (all, some, none). Approve one small return
live and check the customer's statement moves.

## Part B — RET-4, the return card. Proposed layout — say go, or change it

One flow module (`src/flows/returnFlow.js`, callback prefix `rn:`), replacing
the ➖ Return Than tap flow. The typed `/return` preview stays and hands into
the same confirm card. Every card edits in place; ANCH-1 keeps it at the
bottom.

```
1 · Who is returning?            2 · Which bale?                 3 · Which thans?
─────────────────────            ───────────────────────         ─────────────────────
↩️ Return goods                  ↩️ Return · ABBA                 ↩️ Return · ABBA · Bale 9037
Customer with goods out:         Bales sold to ABBA:              Kano office · D1 Blue
[ABBA · 3 bales]                 [📦 9037 · Kano office ·         Tick the thans coming back:
[CHIMA · 1 bale]                   D1 Blue · 4 sold]              [☑ #1 30yd] [☐ #2 30yd]
[MUSA · 2 bales]                 [📦 9040 · IDUMOTA · …]          [☐ #3 28yd] [☑ #4 30yd]
[🔎 type a name]                 [⬅ Back] [❌ Cancel]              [All 4] [Next ➡]
[❌ Cancel]                                                        [⬅ Back] [❌ Cancel]

4 · Returned on                  5 · Condition                   6 · Photo
─────────────────────            ───────────────────────         ─────────────────────
When did it come back?           How do the goods look?           Send one photo of the goods
[Today] [Yesterday]              [✅ Good — back to stock]         (the admins see it on the card)
[📅 Pick a date]                 [⚠️ Damaged]                      or
[⬅ Back] [❌ Cancel]              [✂️ Cut / short]                  [Skip photo]
                                 [📝 Other — I will type it]       [⬅ Back] [❌ Cancel]
                                 [⬅ Back] [❌ Cancel]

7 · Confirm                                      Admin card (both admins, same text + the photo)
──────────────────────────────────────────       ─────────────────────────────────────────────
↩️ Confirm return                                 Return Request · REQ a1b2c3
👤 ABBA                                           👤 ABBA · Bale 9037 · Kano office · D1 Blue
📦 Bale 9037 · Kano office · D1 Blue              Thans #1, #4 · 60 yds
Thans #1, #4 · 60 yds                             📅 Returned 28-Aug-2026 · ⚠️ Damaged
📅 Returned 28-Aug-2026                           📎 photo attached
⚠️ Damaged                                        💰 Credits ABBA ₦150,000 (60 yds × ₦2,500/yd)
💰 Credits ABBA ₦150,000 (60 × ₦2,500/yd)         Outstanding now ₦300,000 → after ₦150,000
Queues dual-admin approval (two admins,           Raised by Abdul · 1 of 2 signed: —
per than).                                        [✅ Approve] [❌ Reject]
[✅ Submit] [⬅ Back] [❌ Cancel]
```

**Where each new fact lands** (no new sheet, no new column, nothing renamed):

| Fact | Request (`ActionJSON`) | After approval |
|---|---|---|
| date | `returnedOn` | BaleMovements `MovedOn` (RET-3 already honours it); ledger row date stays the posting day (TIME-1) — see query 3 |
| condition | `condition` (`good` / `damaged` / `cut` / `other`) + `conditionNote` | AuditLog `return_*` payload; the stock_events shadow payload (Postgres). Stock status is NOT changed by condition today — see query 2 |
| photo | `return_photo_file_id` (Telegram file id, like `sale_doc_file_id`) | forwarded to both admins on the card (`forwardAttachmentsToAdmins`); the id stays in the request row as evidence |
| rate / credit | `pricePerYard` (shown, not asked — the booked rate) | RET-3 credit; the card's "Credits" line is the same number the ledger will post |

**Kept as ruled:** two admins sign (DUAL-1), the requester cannot sign their
own (excluded from the broadcast), the return lands in the warehouse the
bale was sold from (§6 / TRF-INT4), condition never changes stock status
(§6d), a correction stays `/revert_packages` (RET-2).

**Queries — answer in one line each, or say "as recommended":**

1. **One request for several thans, or one request per than?** Today: one
   per than. Recommended: one request listing the ticked thans (new action
   code `return_thans`, needs your sign-off), both admins sign it once, each
   than still carries two signatures. Fewer taps for the same guarantee.
2. **Damaged goods.** Recommended for now: condition is recorded and shown,
   the than goes back to `available` like any return. Later, if you want
   damaged goods held out of sale, that is a new status (§6d ruling) and a
   write-off door — separate task.
3. **Date.** Recommended: `returnedOn` dates the movement and the Transactions
   row; the ledger credit keeps the posting day (statements stay in posting
   order, TIME-1). Alternative: back-date the credit too.
4. **Photo.** Recommended: optional (Skip allowed), one photo. Alternative:
   required when condition ≠ Good.
5. **Cross-warehouse returns** (goods come back to a different store) stay
   out of this card. They need the §6 ruling first; the card is built so a
   "returned to" step can be inserted between 3 and 4 later.
