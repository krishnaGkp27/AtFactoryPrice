# RET-3 — an approved return credits the buyer (shipped 02-Sep-2026) · RET-4 — the return card (shipped 04-Sep-2026)

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

## Part B — RET-4, the return card (SHIPPED 04-Sep-2026)

Owner, 02-Sep-2026, on the five queries below: **"as recommended for all
five."** Built exactly to that ruling.

One flow module, `src/flows/returnFlow.js`, session type `return_flow`,
callback prefix `rn:`. The ➖ Return Than tap picker is retired: the
↩️ **Return goods** tile (`act:return_than`, code unchanged) now opens this
card. Every card edits the tapped message in place; ⬅ Back and ❌ Cancel sit
on every screen.

```
1 · Who is returning?            2 · Which bale?                 3 · Which thans?
─────────────────────            ───────────────────────         ─────────────────────
↩️ Return goods                  ↩️ Return goods · 👤 ABBA        ↩️ … · 📦 Bale 9037
Who is returning?                Which bale is coming back?       Cashmere · Blue
[👤 ABBA · 4B + 2t]              [📦 9037 · 🏭 Kano office ·      Tick the thans coming back:
[👤 CHIMA · 1B]                    Cashmere Blue · 4t · 120 yds]  [☑ #1 · 30 yds] [☐ #2 · 30 yds]
[🔎 Type a name]                 [📦 9040 · 🏭 IDUMOTA · …]       [☐ #3 · 28 yds] [☑ #4 · 30 yds]
[❌ Cancel] [🏠 Back to menu]     [⬅ Back] [❌ Cancel]              [✅ All 4] [➡ Next]

4 · Returned on                  5 · Condition                   6 · Photo
─────────────────────            ───────────────────────         ─────────────────────
When did the goods come back?    How do the goods look?          📎 Send ONE photo of the goods
[📅 Today (04-Sep-2026)]         [✅ Good — back to stock]        — the admins see it on the card.
[Yesterday (03-Sep-2026)]        [⚠️ Damaged]                     [⏭ Skip photo]
[…five more days…]               [✂️ Cut / short]                 [⬅ Back] [❌ Cancel]
[📆 Older date — calendar]       [📝 Other — I will type it]
                                 _Recorded on the card. The than
                                  still goes back to stock._

7 · Confirm                                      Admin card (both admins, plus the photo)
──────────────────────────────────────────       ─────────────────────────────────────────────
↩️ Confirm return                                 ↩️ Return · Kano office
👤 Customer: ABBA                                 👤 ABBA
📦 Bale 9037 — Cashmere · 🏭 Kano office          📅 28-Aug-2026
Thans #1, #4 · 60 yds                             📎 Photo attached
📅 Returned: 28-Aug-2026                          🧵 9037 · Cashmere — 2t · 60 yd
⚠️ Damaged — 6 yd cut off                           #Blue → 9037/1 · 9037/4
📎 Photo attached                                 Σ 2t · 60 yd
💰 Credits ABBA ₦150,000 (60 yds × ₦2,500/yd)     💰 Credits ABBA ₦150,000 (60 yd × ₦2,500/yd)
                                                  Outstanding ₦300,000 → ₦150,000
Approving puts the stock back and credits         ⚠️ Damaged — 6 yd cut off
this customer's account.                          🔏 Dual-admin return — 0 signed so far.
Queues dual-admin approval (two admins,           ⚠️ Reverses a completed sale — verify the
per than).                                            goods physically came back.
[✅ Submit for approval] [⬅ Back] [❌ Cancel]      [✅ Approve] [❌ Reject]
```

The calendar door (`📆 Older date`) reaches the same month grid Sell Bale
uses, bounded by the existing `SALE_CALENDAR_MAX_DAYS_BACK` knob (default
180) — no new Settings key. A typed date only navigates and highlights the
grid; the tap stays the sole commit (owner rule, 21-Jul).

### The action code

New action `return_thans` — **one request lists the ticked thans of ONE bale
in ONE warehouse**. Both admins sign that one request, so every than in it
still carries two signatures (DUAL-1). Signed off by the owner on
02-Sep-2026 and added to `WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS` and
`DUAL_ADMIN_ACTIONS` in `src/risk/evaluate.js`. It is deliberately **not** in
the intent-parser enum: it is a tap-flow-only action.

**Where each fact lands** (no new sheet, no new column, nothing renamed):

| Fact | Request (`ActionJSON`) | After approval |
|---|---|---|
| bale + store | `packageNo`, `warehouse` | the return lands in the warehouse the bale was SOLD from (§6 / TRF-INT4) |
| thans | `thanNos: [1, 4]` (numbers, ascending) | one `stockEngine.returnThan` per than, back to `available` |
| date | `returnedOn` | BaleMovements `MovedOn` + the Transactions row's `salesDate`; the ledger credit keeps the posting day (TIME-1) |
| condition | `condition` (`good` / `damaged` / `cut` / `other`) + `conditionNote` | AuditLog `return_thans` payload, and shown on the card. Stock status is NOT changed by condition (§6d) |
| photo | `return_photo_file_id` (one, optional) + `return_photo_type` (`photo`/`document`) | forwarded to both admins with `forwardAttachmentsToAdmins`; the id stays on the request row as evidence |
| customer | `customer`, `customerId` | the buyer is re-resolved from the sold rows at approval time, before the flip blanks `soldTo` |
| money | `pricePerYard` (booked rate, SHOWN not asked), `yards` | ONE ledger credit, `txnId` `RN-<bale>-<requestId>` |
| goods | `design`, `shade` | the Transactions row and both cards |

`pricePerYard` is computed in the flow with the same maths the executor uses
(`inventoryService._internals.returnCreditFor`), so the number on the card is
the number the ledger posts. It is the yards-**weighted** rate of the ticked
set — `rate × yards` reproduces the exact booked total even when the thans
were priced differently — and it is a **display** figure only: the executor
re-prices from each surviving row's own booked rate
(`returnCreditFor({}, results)`). Applying the card's average as the RET-3
uniform override would credit the survivors of a partial apply at a rate
nobody booked, and would pay an unpriced survivor instead of raising the
loud zero.

`return_photo_type` records HOW the picture arrived. Telegram will not
re-send a file as a different type, so a picture sent as a **File** (📎 →
File — what SHP-1 teaches, to dodge compression) carries a document
`file_id` that `sendPhoto` refuses. The request-time DM, the reminder sweep
and the inbox chip all pick their sender from this field, exactly as the
sales bill does from `sale_doc_type`; `forwardAttachmentsToAdmins` also
falls back to the other sender if the stored kind is wrong.

**Kept as ruled:** two admins sign (DUAL-1); the requester is excluded from
their own broadcast and cannot sign their own request; the return lands in the
warehouse the bale was sold from (§6 / TRF-INT4); condition never changes
stock status (§6d); a correction stays `/revert_packages` (RET-2).

**The `returned_to` seam.** Cross-warehouse returns stay out until §6 is
re-ruled. The flow is built so a `returned_to` step slots in between the
thans step and the date step: `PREV` in `returnFlow.js` and the payload gain
one entry each, nothing else moves.

**A than re-sold while the request waits is skipped, never mis-credited.** A
dual-admin request can sit pending for days. The executor re-reads the rows at
approval time and keeps only the thans that STILL belong to the customer the
request names; anything else is named on the approve reply
(`#4 (now sold to CHIMA)`) — never flipped, never credited to the first buyer.

**One printed number, two containers (§5, pending Q1).** The picker refuses a
bale number that sits in more than one container of the same store — counted
over the FULL roster, so a second container that is available, in transit or
another buyer's still trips it (the request cannot say which 9037 is coming
back). The executor is guarded independently: it groups the candidate rows
**by than number**, so a neighbour's same-numbered row is never flipped as a
second copy of the same than (which would return and credit double), and is
never printed as `⚠️ Skipped — nothing flipped` for a than that was in fact
flipped and credited. Answering Q1 (put the container on the request) would
let both guards relax.

### Files

* `src/flows/returnFlow.js` (new) — the seven cards, `rn:` namespace.
* `src/controllers/telegramController.js` — four surgical insertions: the
  `rn:` route, the tile case, the photo guard, the typed-text block.
* `src/risk/evaluate.js` — `return_thans` in the three policy lists + the
  human label map.
* `src/services/inventoryService.js` — the `return_thans` executor branch.
* `src/repositories/inventoryRepository.js` — one optional `opts.baleUid`
  filter in `findThan` (§5 duplicate guard; ignored when absent).
* `src/services/approvalCards.js` — `buildReturnThansCard` + the
  `buildCardFromActionJSON` branch, so the DM, the reminder sweep and the
  approvals inbox all rebuild the SAME card from the queue row.
* `src/flows/approvalsInboxFlow.js`, `src/services/approvalReminder.js` — the
  returns category and the photo re-forward.
* `src/services/consistencySentinel.js` — C2 counts a `return_thans` row as an
  approved return (without it the sentinel would accuse every RET-4 return).
* `src/services/activityRegistry.js` — the tile reads ↩️ Return goods.
* `scripts/list-uncredited-returns.js` — an `RN-<bale>-` credit now counts.

Tests: `test/unit/flows/returnFlow.test.js`,
`test/unit/services/returnThansExecutor.test.js`,
`test/unit/services/approvalCardsReturnThans.test.js`,
`test/characterization/returnGoodsCard.test.js`,
`test/characterization/returnThanTapFlow.test.js` (retargeted to the new
door), plus additions to the evaluate, sentinel and
list-uncredited-returns tests, and smoke S54.16.

### After shipping — owner steps

1. Approve **one small return** live, end to end: open ↩️ Return goods, pick a
   customer, a bale, tick one than, date it, mark the condition, send a photo,
   submit. Check that BOTH admins get the card **and** the photo, that one
   signature is not enough, and that after the second signature the customer's
   statement moves by the amount the card promised and the movement is dated
   the day you said the goods came back.
2. Decide whether the legacy `rt*` tap handlers (now dead) are deleted now or
   with TG-8.
3. Answer the three rulings below.

### Rulings this build needs

* **Q1 — should a return name the container as well as the bale number and the
  store?** The picker treats a printed number in a different container as a
  different bale (§6c), but the request itself carries only the number and the
  store. Today, if the SAME printed number sits twice in one store, the card
  refuses to raise the return and tells you to call an admin. One extra field
  on the request would close that; it costs no sheet column and no rename.
* **Q2 — eight thans of one bale write EIGHT lines in the movement history**,
  not one, so the Movement Ledger shows eight return lines for what you did
  once. Fine as it is, or shall the eight become one line? (The second needs a
  change to the stock engine, so it needs your go.)
* **Q3 — a TYPED return still raises the OLD kind of request.** "Return than 2
  from Bale 5801" typed in chat goes down the pre-RET-4 path: **no date, no
  condition, no photo**, one than per request. The date, condition and photo
  exist on the ↩️ Return goods card only. Leave the typed door alone until
  TG-8, or have it hand into the new card now?

### The five queries, and the ruling

Owner's answer, 02-Sep-2026: **"as recommended for all five."**

1. **One request for several thans, or one request per than?** → one request
   listing the ticked thans (`return_thans`), both admins sign it once, each
   than still carries two signatures.
2. **Damaged goods.** → condition is recorded and shown; the than goes back to
   `available` like any return. A held-out-of-sale status is a separate ruling
   and a separate door (§6d).
3. **Date.** → `returnedOn` dates the movement and the Transactions row; the
   ledger credit keeps the posting day (TIME-1).
4. **Photo.** → optional (Skip allowed), exactly one.
5. **Cross-warehouse returns** → out of this card; the `returned_to` seam is
   built for the day §6 is re-ruled.
