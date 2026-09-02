# Approvals vs the floor — where the approval systems fight the real business (01-Sep-2026)

The owner asked: *"find the loopholes in the actual business use case for all the
approval systems … for proper assessment and integration with the real business
scenario. No implementation, just a complete analysis."* His named pains: returns
from customers at a different warehouse than they bought from; returned goods
going straight to another customer; returns at the office "don't look good";
and the whole return activity being too slow.

**Method.** Eight business scenarios were traced through the code as the people
involved live them (who taps, what card, who signs, what lands in which sheet).
Every loophole was then attacked twice — once for *code truth* (does the bot
really do this?) and once for *business truth* (is this a defect, or a dated
owner ruling that still fits?). A loophole that is a deliberate ruling is
reported **as a ruling**, not a bug. 74 findings: **27 verified** by both
attacks, **45 single-pass** (the session limit stopped the verifiers on the
transfer, supply, latency and money scenarios — the highest-severity of those
were re-checked by hand, and are marked), **2 dropped** as valid rulings.

---

## The verdict in one paragraph

The approval machinery is sound for the outbound direction — a sale is gated,
carded, enriched, booked and invoiced correctly. It is the **inbound and
corrective** directions that fight the floor: a return credits the customer
**₦0**, lands the goods where they were *sold* rather than where they came
back, needs **two admins per than** where the sale it undoes needed one, asks
for no date, photo or condition, and is then invisible or wrong on most of the
surfaces that report it. The supply-request door never moves the book at all.
Most of this is not the locked rules being wrong; it is the rules having been
written for the *outbound* case and never revisited for goods coming back.

---

## 1 · An approved return credits ₦0 — VERIFIED (five scenarios independently), re-checked by hand

> **Fixed 02-Sep-2026 (RET-3).** Rate on both emits, propagating post, loud zero case, credit note on the reply, read-only backfill listing. See `specs/RET-3_RETURN_CREDIT.md`.

**Story.** ABBA owes ₦300,000 for 4 thans at ₦2,500/yd. He returns 2. Abdul
raises two returns; two admins tap four times; every card says *"the return
credits this account"*. ABBA's statement the next week: still ₦300,000. ABBA
insists he owes ₦150,000. Someone "fixes" it with ➕ Record Payment ₦150,000
Cash — and now the cash book shows money that never arrived.

**Why.** `accountingService.recordReturn` computes `amount = yards × (pricePerYard || 0)`
and returns *before appending* when the amount is zero
(`src/services/accountingService.js:46-48`). The approved-return executors emit
the ledger event **without `pricePerYard`** (`src/services/inventoryService.js:461`
for `return_than`, `:475` for `return_package`). The legacy direct paths
(`:248`, `:265`) *did* pass it — this regressed when returns moved behind
approval. The emit is also fire-and-forget, so no failure ever surfaces. The
only path that credits money is `revert_sale_bundle` — whole sale, and only if
it is the newest Transactions row.

**Impact.** Wrong money on every customer who has ever returned goods through
the bot: balances overstated by the full value of returned goods, the
"Outstanding" line on the next sale card wrong, invoices never adjusted, and
the only in-bot "fix" (Record Payment) corrupting cash.

**Fix direction.** Carry a rate on the return event — ideally the rate the sale
was *booked* at (Transactions `pricePerYard` by `saleRefId`, or the persisted
enrichment), not the Inventory row's current price, which a later sale of
the same bale overwrites (§8 below) — and post through `erpEmitAsync` so a
failed credit is reported the way a failed sale debit is (H6). **No locked rule
collides.** Then a decision: whether to **backfill credits for past returns**
(they are all listed in BaleMovements, kind `return`, with the buyer in `Ref`).

## 2 · A return lands where the goods were SOLD, never where they came back — VERIFIED (four scenarios)

**Story.** Hajiya Zainab bought 2 bales of 77014 from IDUMOTA and her driver
drops them at Lagos office. The only question the bot can ask is *"which
warehouse is this return from?"* — among the warehouses the number was sold in.
The bales go back to `available @ IDUMOTA` on paper while sitting in Lagos. To
sell them from Lagos, staff raise a **transfer for a truck that never moved**:
dispatcher ticks bales he cannot see, a mandatory load photo, an admin gate, a
mandatory receipt photo of goods already on the shelf. Three queue rows, five
admin taps, four people, two staged photographs, several days. Meanwhile —
**phantom stock**: the bales are sellable at IDUMOTA and invisible at Lagos.

**Why.** `markThanAvailable` / `markPackageAvailable` write the row's own
`than.warehouse` back (`inventoryRepository.js:548`, `:581`); the return
request carries only the source warehouse (`telegramController.js:8771`);
there is no "received at" field anywhere.

**Ruling.** BUSINESS_RULES §6 / TRF-INT4 (02-Aug-2026): *"Sales, returns, and
transfers act only on rows in their own warehouse."* The rule is about which
rows an action may **flip** (the source bale) — a fine rule — but it was never
written for where returned goods may **land**. As worded it forces a fake
transfer for every cross-store return. **This needs the owner's word, not a
workaround:** a "returned to" place on the return request; the executor flips
the source-scoped rows *and* sets the landing warehouse; BaleMovements records
`sold @ IDUMOTA → available @ Lagos office` (§6d was built to hold exactly
this; FromState already carries the origin for transfers).

## 3 · Returns are dual-admin, per THAN, while the sale they undo is single-admin — VERIFIED; ruling collision

**Story.** Two thans back = two full flows (the picker takes one than per
request; the whole-bale door is typed-only and flips *every* sold than of the
bale, so "2 of 4" has no single-request shape). Four admin taps, two
first-signoff broadcasts, two "needs a SECOND" pings to every admin. The
thans sit on the counter as "sold" — unsellable to a walk-in — until the second
admin is free. The original sale of all four took one tap.

**Ruling.** DUAL-1 (12-Jul) put every Inventory write under two admins;
DUAL-1a (14-Jul) carved the sale family out *because two-admin latency was
blocking live sales* and stated "returns/reverts stay dual (they roll back
approved sales)". The owner's own reasoning for sales now applies to returns
— and worse: **`/revert_packages` performs the identical stock flip with no
approval at all** (RET-2, 07-Aug), so the second signature on a return guards
only the ledger credit — **which is ₦0 (item 1)**. The stronger gate sits on
the everyday act and protects nothing.

**Fix direction.** Two separate decisions: (a) a **multi-than, customer-first
return door** — pick the customer, tick her sold thans/bales, one request, one
approval chain — touches no gate and removes most of the pain on its own;
(b) an owner re-ruling on the gate: single non-requester admin like sales
(with the evidence in item 4 as the safeguard), or dual per *request* not per
than, or dual only when the credit exceeds a Settings threshold. **Measure
first:** `ApprovalQueue` has `CreatedAt` and `ResolvedAt` on every row —
median hours-to-resolve per action, split single vs dual, is one sheet formula
away and should decide this.

## 4 · A return has no date, no photo, no condition — the "doesn't look good" problem has nowhere to be recorded — VERIFIED

**Story.** ABBA's than #6 comes back with 6 yd cut off, creased and
shop-soiled. Abdul cannot say so: no date step, no photo step, no condition
step. The second admin signs two days later; every record (BaleMovements, the
supply ledger credit, the DML-1 movement ledger) is dated the approval day —
so the ledger shows the goods leaving to OKESON *before* they came back from
ABBA. The than re-enters stock as a 25-yd `available` than at full price,
indistinguishable from fresh, and the next customer gets it.

**Why.** The queued payload is `{action, packageNo, thanNo, warehouse}`
(`telegramController.js:8771`); no `on` is passed, so the business day falls
back to today (`baleMovementLog.js:39-42` says so in its own comment); the
executor rewrites H..P with the same warehouse, price and no condition.

**Fix direction.** Give the return door the discipline the sale door already
has (§9b): 📅 return date (calendar + BACKDATED stamp), mandatory photo of
what came back, receiver, and a **condition chip** — saleable / damaged /
short-yardage (measured) / re-bale. A non-saleable condition needs a status
the sale pickers exclude: **a new status value or a write-off event, which is
a new action code — owner sign-off under §11**; §6d forbids new Inventory
columns, so condition lives in status or BaleMovements/Postgres.

## 5 · The people signing a return are signing blind — VERIFIED

The tile path sends a thin summary (`Return Than / Bale / Than / Design /
Warehouse`) instead of the RET-1 card; the approvals-inbox rebuild shows
neither the than number nor the buyer (two ABBA requests and a MUSA request
on the same bale are identical rows); the reminder says only "return than —
@ Kano office". The RET-1 card itself is written in the pre-CARD-3 grammar the
owner called redundant, prints the *warehouse's* shelf stock ("Currently
available there: 21 thans, 630 yds") where the admin reads it as the size of
the return, and promises a credit that does not happen. The requester's
receipt says "admin approval" when two are needed.

**Fix direction.** Route every return surface through one CARD-3-shaped card
(`↩️ Return · Kano office / 👤 ABBA / 🧑 Abdul · 📅 28-Aug / 📎 photo /
🧵 9043-B · Cashmere — 2t · 60 yd / #B → 1234/1 · 1234/2 / sold 20-Aug ref …`),
add a return branch to `buildCardFromActionJSON` and the reminder, and make
the requester text state the real gate. No collision.

## 6 · After a return, the history lies — VERIFIED (six findings)

- **Partial return zeroes the supply ledger.** Supplied 4, returned 2: the
  Supply Ledger reads *supplied 2, returned 2, net 0* — the two thans ABBA
  still holds vanish. The debit side dedupes on bale-day and skips the
  movement-log sale rows whenever any than of that bale-day is still sold
  (`supplyLedgerService.js:118-171`); return rows carry `yards: 0` because
  BaleMovements has no yards column. **A second return of the same bale
  drives it negative.**
- **Returning a pre-03-Aug sale goes negative outright.** No `sale` movement
  exists for anything sold before the movement log was born; the return
  blanks `soldTo`; the credit still counts. **Most of the owner's backlog is
  June/July sales.** A one-off backfill (one `sale` movement per legacy sold
  row) must precede the backlog.
- **The customer's paper keeps claiming the goods.** No credit note; the
  invoice link still says UNPAID for the full amount; the Supply Statement
  PDF (SLED-1, "net as of today" — a ruling) shows the delivery as 5 thans
  when 8 were signed for; Customer Supplies, Supply Details and My Products
  all read `getSoldRows()` and drop the returned thans.
- **The re-sale re-prices the first buyer's thans.** Every sale executor runs
  `updatePrice` on the whole bale, sold rows included
  (`inventoryRepository.js:639-656`), so OKESON's ₦1,450 rewrites ABBA's
  ₦1,500 on the five thans he kept — and any later credit is computed at the
  wrong rate.
- **The return's Transactions row names nothing** — no bale, no customer, no
  warehouse, no `saleRefId` — so sales reports keep counting the sale in
  full and the return cannot be netted against it.
- **Rate chips anchor on a reversed sale** ("ABBA — ₦1,500" offered on the
  re-sale).

## 7 · Corrections: the approved undo tells a lie, the honest undo has no approval — VERIFIED

**Story.** Bale 6422 was approved on 12-Aug as sold to Musa when it went to
Bello. The two-admin door (`revert_sale_bundle`) executes as a **return**:
Musa's supply ledger gains "Return — 1 bale" for goods he never brought back,
and the signing admin cannot tell it from a genuine return. The honest door
(`/revert_packages`, kind `correction`) takes **no approval** and touches
**no money**: Musa's ₦ debit stays, the Transactions row stays "approved",
the invoice stays "issued". And the revert door only works on the **newest
Transactions row, and only if it is a `sale_bundle`** — process one return and
every earlier sale is locked out of it.

**Also:** missing, stolen or damaged goods have **no truthful record** — the
blind count can flag and unflag, but Inventory keeps listing the two ghost
bales and every picker offers them (`stockEngine` has no loss/adjust event;
WAU-3 explicitly deferred corrections).

**Fix direction.** One approved "this record was wrong" door with an explicit
choice — *goods came back* (return) vs *record was wrong* (correction) —
carried on the queue row, honoured by `stockEngine`, and the correction branch
reversing Ledger_Entries, marking the Transactions row and voiding the
invoice; keyed by `saleRefId`/invoice, any sale family, any age. Plus a
dual-admin `stock_write_off` event. **Both are new action codes — owner
sign-off. RET-2 ("correction needs no approval") vs DUAL-1 ("every Inventory
write is dual") is a standing contradiction only the owner can settle.**

## 8 · The supply-request door never moves the book — SINGLE PASS, core fact corroborated by the DML-1 research

- **Goods leave on a card.** Accept flips the row to approved/`completed`; the
  executor branch is a no-op comment (`inventoryService.js` "Intimation only");
  no Inventory, Transactions, BaleMovements or ledger write exists. The bales
  stay "available" until someone remembers to re-enter the whole thing as a
  sale — double entry, double approval, or never.
- **"Completed" means the warehouse boy tapped Accept**, not that goods left;
  the request then vanishes from 🚚 Pending Supply and reads as supplied in
  the Sales Browser.
- **The admin's Approve tap is invisible until a warehouse boy is picked** —
  two admins can both approve, two hands can both be assigned the same bales.
- **"Feasible" is confirmed by the Dispatch department, who are not at the
  rack and see only totals**; nothing is reserved, so two requests can promise
  the same ten bales.
- **Three of four waiting points have no reminder** (only `admin_review` is
  swept); a linked marketer's tap can be queued with **nobody notified** when
  Dispatch is empty (a truthy `{routed:false}` object passes an `if (!stage1)`
  check — `linkedSupplyService.js:94`), then blocks their next tap.
- The request collects a payment mode and a bill that go nowhere.

**Fix direction.** Make the request **end in the sale door**: at release the
hand ticks the physical bales that left (DBP-1's picker is already signed
off), and that one approval executes the sale with customer/seller/date
pre-filled and the request id stamped on the rows. Consistent with §2/§4
(bale identity; physical truth wins). SRF-2's release step is the owner's
own pending ask.

## 9 · Transfers, as trucks actually behave — SINGLE PASS

- **Receiver can only accept-all or reject-all.** The truck carries 869, the
  card says 867: Received puts 867 in Kano (it is in IDUMOTA) and leaves 869
  in IDUMOTA (it is in Kano); Reject sends all five records home while all
  five sit in Kano. The 02-Aug repair was a one-off script.
- **A parked package leaves its bales sellable at the source** — TRF-18
  (non-admin dispatch waits for admin review) "does not move stock", so a
  bale on the truck can be sold from IDUMOTA and silently dropped from the
  transfer at approval. Collides with §5 ("in transit exists in NEITHER
  stock"). Owner to rule that a parked package *holds* stock.
- **Goods on the destination floor are unsellable until the ONE named
  receiver taps and photographs** — an absent receiver stalls sales for days,
  nobody is nagged (`approvalReminder.js:48` excludes transfers), and the
  admin's on-behalf tap demands a photo he does not have.
- **Hand-carried moves and wrong-branch returns have no door** — the sheet
  learns only through the full four-person truck chain, run after the fact.
- Short dispatch closes the order short with no remainder; arrival is dated
  the tap day; the dispatcher's ticks live in a 30-minute in-memory session
  that a real load outlasts and any deploy wipes; send-back discards every
  tick and demands a new photo of a truck that left.

## 10 · Latency and gates — SINGLE PASS; two items need no code at all

- **Reminders are OFF in production.** `APPROVAL_REMINDER_HOURS=0` was set on
  14-Jul after the first sweep flooded admins with a 41-row backlog;
  `DIGEST_APPROVALS` ships 0. The max-age guard now prevents that flood.
  **Owner action, no deploy:** set `REMINDER_HOURS_ADMIN` (e.g. 6) and
  `DIGEST_APPROVALS=1` in Settings.
- **The dual gate degrades on admin headcount, not reachability**: one
  travelling admin freezes every employee-raised dual action (GRN, payment,
  return, sample) for the trip — no timeout, no delegation.
- **Intake is dual**: a Friday container is unsellable until Monday's second
  signature — the exact off-book weekend the system was built to end.
- **Approving a sale is a four-step data-entry wizard** whose card buttons are
  wiped on the first tap; walking away strands the request.
- **Money in waits on two admins** (`record_payment`) while the same naira
  entered as `amountPaid` inside a sale needs one.
- **After 14 days a request goes silent and nothing expires it**; a duplicate
  raised months later is flagged only inside a 10-minute window.

## 11 · Money beyond returns — SINGLE PASS

- **No refund or credit-note door**: a paid sale that is reverted leaves the
  customer owed ₦255,000 with no way to record the refund; CRM floors the
  balance at 0; the invoice prints "BALANCE ₦0".
- **The customer's own portal drops every return credit** —
  `extLedgerService` recognises only narrations beginning `Sale:` and
  `Payment received from`; a `Return:` row is discarded and the running
  balance recomputed without it. The office and the customer will disagree
  the day item 1 is fixed.
- **Three customer balances, and the wrong one is shown to the people who
  decide**: `Customers.outstanding_balance` is never debited by sales and
  floored at 0 (typed "what is Musa's balance" → ₦0 against a ₦255,000
  debt); `LedgerBalanceCache` is fed only by the typed `/payment`;
  Ledger_Entries is the de-facto truth. H4/P7, open since 07-Jul.
- **A receipt approval is not a payment**: money in takes two unlinked doors
  and three signatures, with no link between the slip and the credit.
- **The invoice is a frozen snapshot** — never voided, credited or updated,
  though its own header claims it is recomputed from the ledger.

---

## Rulings that now fight the business — decisions only the owner can make

| Ruling | Date | What it was for | What it now does |
|---|---|---|---|
| §6 / TRF-INT4 — returns act only in their own warehouse | 02-Aug | one action never flips same-numbered bales in two stores | forces a fake transfer for every cross-store return |
| DUAL-1 / 1a — returns and reverts stay dual, per request | 12/14-Jul | a single admin should never roll back a sale alone | two admins per **than**, guarding a credit that is ₦0; `/revert_packages` does the same flip with none |
| RET-2 — a correction needs no approval | 07-Aug | distinguish an admin's undo from a customer return | the honest undo is ungated and leaves money and invoice untouched |
| TRF-18 — a parked package does not move stock | 05-Aug | non-admin dispatch waits for admin eyes | bales on the truck stay sellable at the source (contradicts §5) |
| §6d — no new Inventory columns | 03-Aug | keep the Inventory sheet clean | no place for a damaged / on-hold condition |
| SLED-1 — statement is net as of today | 31-Jul | show the customer what they hold | a signed 8-than delivery prints as 5 with no return line |

## What I would do, in order

1. ~~**Fix the ₦0 credit**~~ SHIPPED 02-Sep (RET-3) — a defect, not a design question: the rate on two
   emits, async posting, a test that asserts the credit amount. Then list
   every past return (BaleMovements kind `return`) so the owner can decide
   whether to backfill credits.
2. **Owner, no code:** turn reminders on in Settings; delete the four retired
   tabs; run the latency measurement below.
3. **Rebuild the return door** — customer-first, multi-than, "returned to"
   place, date, condition, photo, one request, one card grammar. Needs the
   §6 and DUAL-1 rulings above.
4. **Corrections and write-offs** — the approved "record was wrong" door and a
   `stock_write_off` event (two new action codes, sign-off).
5. **Supply request ends in the sale** (release step + bale tick).
6. **Transfers:** partial receipt, parked package holds stock, any hand at the
   destination may receive, stage reminders.
7. **One customer balance** (Ledger_Entries), portal parses returns, a refund
   door, invoices live.

**The measurement to run before ruling on any gate.** In `ApprovalQueue`,
per action code in `ActionJSON`, median and 90th-percentile of
`ResolvedAt − CreatedAt` in hours, split by whether the action is in
`DUAL_ADMIN_ACTIONS`. If dual actions resolve materially slower than single
ones, DUAL-1a's own reasoning has already decided the question.

---

*Verification status. Items 1–7: every finding survived two adversarial
attacks (code truth and business truth). Items 8–11: single analyst pass; the
₦0 credit, the return-warehouse pinning, the supply executor no-op and the
reminder settings were re-checked by hand. Two candidate findings were dropped
as valid, dated rulings. Full per-scenario walkthroughs and the 74 raw findings
are in the session record.*
