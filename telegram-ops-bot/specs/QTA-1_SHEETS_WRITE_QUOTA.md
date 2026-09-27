# QTA-1 — the Google Sheets write cap, and one write per approved sale

**Status:** SHIPPED 26-Sep-2026 (owner 24-Sep: "I have faced some backend breakdown.
Please address this issue as it may cause consistently issue").

## 1. What happened

An admin approved a bundle sale (`📋 Confirm sale — R-9BF6 · Ayubal Ansari · Paid to
Zenith · 3,750 · ⏳ Applying…`) and two minutes later the card read:

```
⚠️ Error: Quota exceeded for quota metric 'Write requests' and limit 'Write requests
per minute per user' of service 'sheets.googleapis.com' for consumer 'project_number:…'.
```

Google allows **60 write requests per minute per user** on the Sheets API, and the
bot's service account is one user for every flow, scheduler and sentinel at once.
The bundle executor sold **item by item**: for each bale or than one Inventory row
write, one BaleMovements append and one price stamp, each invalidating the cache so
the next item re-read the whole Inventory sheet. A 20-item sale made about 60
writes on its own. The client already retried a refused write five times with
exponential backoff (about a minute in total) — the burst outlived the retries.

Worse than the error: the executor posts the Transactions row, the ledger debit and
the invoice **after** the item loop. A refusal in the middle of the loop left some
thans flipped to sold with nothing behind them, while the request stayed pending.

## 2. What changed

| Layer | Before | After |
|---|---|---|
| `sheetsClient` retry | recognised `429` only as a number; the spent-retry error was Google's raw text | recognises every shape Google sends (numeric or string `429`, `RESOURCE_EXHAUSTED`, `rateLimitExceeded`, the message); when the retries are spent the admin reads **`Google Sheets is rate-limiting writes right now — wait one minute, then tap again.`** (code `SHEETS_QUOTA`, the original as `cause` for the log) |
| `sheetsClient` governor | none — every caller fired writes as fast as it could | every write (`appendRows`, `updateRange`, `batchUpdateRanges`, `addSheet`) first takes a slot from a rolling one-minute window capped at **`SHEETS_WRITES_PER_MINUTE`** (Railway env, default 50, under Google's 60); a full window **waits** for the oldest write to age out instead of sending a request Google will refuse. Slot-taking is serialised, so two admins and the schedulers share the cap fairly. `0` switches the wait off (retries only) |
| bundle sale executor | per item: `markThanSold` / `markPackageSold` (1 write) + movement append (1) + `updatePrice` (1) + a full re-read | **one** `stockEngine.sellItems` → `inventoryRepository.markItemsSold`: one Inventory read, **one** `batchUpdate` carrying every sold row (H:P, the negotiated rate in J) **and** the rate stamp on the rest of each touched bale (the old `updatePrice` contract), **one** BaleMovements append, **one** stock-events shadow |
| half-done sales | a mid-loop refusal could flip some thans and stop | the flip is one API call: Google applies it whole or refuses it whole — nothing can be half-flipped by a quota error any more |

Per-sale sheet writes, 20-item bundle: before ≈ 60 + 6; after ≈ 2 + 6 (Transactions,
ledger pair, balance cache, invoice, audit, queue status).

The guards of the writers it replaces are carried over and tested: a than that is not
`available` is never overwritten (SEC-P2 C5); each item is scoped to its own warehouse
(TRF-INT4); one physical row is never claimed twice by two items of one request; an
unknown item type is reported, not applied; the partial report, the APF-1 all-failed
refusal and `bundleReport` keep their shapes.

## 3. What did NOT change

- The single-item doors (`sell_than`, `sell_package`) still write per item — one item,
  three writes, well under the cap — and are now governed too.
- Every other executor (transfers, returns, Edit Bale, goods receipts) keeps its write
  pattern; the governor now slows a large loop instead of letting Google refuse it.
  A 100-row loop is ~2 minutes at the cap; see §6.
- Reads are not governed (Google caps them separately at 60/min/user). The batched
  sale removed the per-item re-reads that used to accompany the writes.

## 4. Was R-9BF6 half-done? — the checker

`scripts/check-sale-request.js` is read-only and prints, for one request, the queue
row, every requested item's Inventory rows today (flipped or not), the Transactions
row for that sale ref, the ledger entries whose txn id starts with the request id and
the invoice, then one reading line: **Whole**, **HALF-DONE** (thans sold to this
customer on this date with no money row behind them), **Untouched**, or **Mixed**.

```
node scripts/check-sale-request.js R-9BF6
```

If it prints HALF-DONE, the goods have left stock but the customer has not been
charged. Since QTA-2 (§8) a **bundle** in that state is finished by ONE Approve —
the executor counts the flipped thans instead of selling them again and writes the
missing book rows once. A single-door request (`sell_than` / `sell_package`) has no
resume path: do not re-approve it; tell me the output and its missing side is posted
by hand with the numbers in front of us. The checker's reading line says which of
the two applies.

## 5. Owner steps

1. Run the checker for R-9BF6 (above) and send me the output.
2. Optional: set `SHEETS_WRITES_PER_MINUTE` on Railway if you ever want a different
   cap (default 50). Not a Settings-sheet cell: it governs the client that reads the
   Settings sheet.
3. Approve the next large sale as usual; the card should never show Google's quota
   text again. If it ever shows `Google Sheets is rate-limiting writes right now — wait
   one minute, then tap again.`, the Inventory flip did NOT happen (it is one call);
   wait a minute and tap again. If a LATER step was refused the card instead shows
   `🛑 BOOKS NOT UPDATED` with the step's name (the goods are sold, that book row is
   not — re-post it by hand), and if only the request's own status could not be
   written it says `Applied and booked — …`: for a bundle, tap Approve again after a
   minute (the executor recognises the sale as already applied and only marks the
   request approved — §8); for a single door, choose ✅ Mark as done.

## 6. Owed / follow-ups

- ~~**Idempotent money side.**~~ Built as QTA-2 (§8, 27-Sep-2026) for the bundle
  door: a re-approve completes a half-done sale and writes each missing book row once.
  Still owed: the same for the single doors (`sell_than` / `sell_package` — their
  executor refuses a sold than, so a half-done single sale is still closed by hand),
  and rendering the resume on the admin's reply and the requester's notice
  (`approvalEvents` renders `bundleReport.failedItems` only — `resumedItems` /
  `resumedThans` are carried but not printed; one ask-first line).
- **The same per-item loop lives on in two other executors** and is the next
  incident waiting: RET-4 `return_thans` flips per than (2 writes each, the credit
  only after the loop — a mid-loop refusal under-credits the customer on the
  re-approve) and `revertSaleBundle` undoes per item. Batch both the way
  `markItemsSold` does. Ranked first among the owed loops.
- **Other large loops** (a 43-bale dispatch, a 64-than return): batch them the same
  way. Ranked by realistic size in the review (spec §7).
- `updatePrice` on a sale stamps the negotiated rate on every row of the bale in that
  warehouse, **including thans sold earlier to someone else at another rate** —
  carried over unchanged from the old per-item path; it rewrites history on those
  rows and needs your ruling.

## 7. Adversarial review, 26-Sep-2026 (before shipping)

Four lenses (governor · batched writer · integrity · rules), two refuters per finding,
23 findings, 22 confirmed by reproduction against the real modules. Closed in the
same change:

| # | Finding | What changed |
|---|---|---|
| 1 | a refused Transactions append AFTER the one-call flip threw the executor away: goods sold, request pending, card said "tap again" → re-approve refused (all sold) → Mark-as-done closed it with no money row | the append is collected as an H6 book failure (`Transactions row (bundle / sell_than / sell_package)`), the executor completes and the card shows BOOKS NOT UPDATED; a refusal on the final status write says `Applied and booked — … choose ✅ Mark as done` |
| 2 | the movement log received the FLIPPED copies, so every bundle sale logged `sold → sold` (DML-1 could no longer see the sale leave) | the rows as READ go to the log |
| 3 | a than item's stale legacy `baleUid` orphaned the item although the old executor never pinned on it | the uid decides between same-numbered rows only while it resolves; else number + warehouse |
| 4 | two same-numbered bales from two stores in one request collapsed into one movement / stock-events row | one movement append and one shadow per warehouse |
| 5 | retries bypassed the governor — a 429 storm re-created the burst | every attempt takes a slot |
| 6 | `Date.now()` in the governor: a clock correction could hold every write for the jump plus a minute | monotonic `performance.now()` |
| 7 | a READ that exhausted its retries said "rate-limiting writes" | reads say reads |
| 8 | a typo in `SHEETS_WRITES_PER_MINUTE` switched the governor off silently; ≥60 removed the slack | not a number → default 50 (warned once); above 60 → clamped to 60 |
| 9 | the checker matched the card's short ref on the LAST four id characters; the card mints the FIRST four | mirrors `shortRequestRef` |
| 10 | the checker judged than ROWS against request ITEMS (a whole bale sale read Mixed; a partial could read Whole) | judged per item |
| 11 | a duplicate request whose goods were sold under ANOTHER request read HALF-DONE (post by hand = double charge) | `DUPLICATE?` verdict naming the other request id |
| 12 | `getLast(2000)` hid the Transactions row of an old sale | the whole sheet |
| 13 | `markItemsSold` missing from the S53 one-door smoke lint | listed |
| 14 | the incident's shape (N items → ONE Inventory write + ONE movement append) was not pinned end to end | `test/characterization/saleBundleOneWrite.test.js` |

Recorded, not changed: RET-4 `return_thans` and `revertSaleBundle` still loop per
item (§6); a package whose rows carry no design no longer receives the negotiated rate
stamp (one refuter showed the premise is not producible by the bot); one refuted
finding (the FIFO gate has no upper bound on one write's wait — by design, a wait is
the alternative to a refusal).

## 8. QTA-2 — one Approve finishes a half-done bundle sale (27-Sep-2026)

**Owner, 26-Sep (after checking R-9BF6 on the phone: 27 of 33 thans sold to Ayubal
Ansari on 25-Sep-2026, bale 772 untouched, no Transactions row, no ledger debit, no
invoice, request still pending): "Go with your recommendation."** The recommendation
was: build the resume path so ONE Approve completes the sale, guarded so a than sold
to him that day under a different request is refused as a duplicate and never charged
twice. Built and shipped the same day.

### 8a. The one question

**Is this item's stock gone because THIS sale already took it?** An Inventory row is
*this sale's* when it is `sold`, `soldTo` = the request's customer and `soldDate` =
the request's sale date (both compared the way the rest of the bot compares them:
case-blind names, `normDay` dates). A bale item is this sale's when EVERY row of that
bale in the item's store is; a than item when its one row is. `src/services/saleResume.js`
answers it for every surface.

| Surface | Before | After |
|---|---|---|
| `saleStockCheck.allItemsGone` (APF-2 pre-check, 🛂 inbox chips + card buttons, sentinel C8) | a half-done bundle read as *gone* → the admin was offered only **Mark as done** (posts nothing) or Reject | a bundle item that is its own sale's is **not gone**: the wizard runs and the executor resumes. Single doors are unchanged (their executor has no resume path) |
| the approval card (`approvalCards.enrichBundleItems` → `buildSaleCard`) | `⚠️ N of M item(s) marked ⚠️ have no available stock — check before approving` | when every ⚠️ item is its own sale's: `⚠️ 7 of 8 item(s) marked ⚠️ are already sold to Ayubal Ansari on 25-Sep-2026 by an earlier run of THIS request. Approve completes the sale: they are counted, not sold or charged again.`; mixed: the old line plus `N of them were sold by an earlier run of THIS request and will be counted, not sold again.` |
| the bundle executor (`inventoryService`, `sale_bundle` branch) | every already-sold item was a *failure*: the 6 free thans would have sold, the 27 would have been reported as failed, the customer charged for 180 of 990 yards | see 8b |
| `inventoryRepository.markItemsSold` | a refusal said only *why* | each refusal also carries the rows it FOUND in the item's store, so the executor needs no second read to judge them |
| `consistencySentinel` C8 | a half-done bundle pending > 1 h read as a zombie (*use Mark as done*) | `… but 7 of 8 item(s) are already sold to Ayubal Ansari on 2026-09-25 — an earlier run flipped them without the books (half-done). Open it and Approve once: the bot completes the sale without selling or charging them again.` |
| `scripts/check-sale-request.js` | HALF-DONE always said *do not re-approve* | a bundle: *Tap Approve ONCE … (QTA-2)*; a single door: post by hand. The checker now judges single-door requests too |
| the after-apply quota message (`SHEETS_QUOTA_AFTER_APPLY`) | `… choose ✅ Mark as done (no re-run)` | a bundle: `… tap Approve again — the bot recognises the sale as already applied and only marks the request approved (nothing is sold or charged twice)`; a single door: unchanged |

### 8b. What the executor does now, in order

1. Reads Inventory once and lists the items that are already this sale's
   (`resumableItems`). None → a normal sale; the resolved queue is never read.
2. Some → reads the resolved ApprovalQueue (`getResolved`) for the duplicate check.
   **If that read throws, nothing is written**: `ok:false` — `7 item(s) were already
   sold to Ayubal Ansari on 2026-09-25 by an earlier run of this request, and the
   earlier sales could not be read to rule out a duplicate (…). Nothing was changed —
   try again in a minute.` (A half-charged sale is worse than a minute's wait.)
3. The one batched write (`sellItems` → `markItemsSold`) sells whatever is available.
4. Each refusal is classified (`classifyFailed`):
   - **resumed** — its rows are this sale's and no OTHER approved sale request
     (`sale_bundle` / `sell_package` / `sell_than`, same customer, same day, not undone
     by an approved `revert_sale_bundle`) covers the bale or than. Counted into the
     totals (thans, yards, per-design yards for the ledger) exactly as if sold now.
   - **duplicate** — such a request exists. Reported as a failed item:
     `already sold to Ayubal Ansari on 2026-09-25 under request R-DDDD — a duplicate,
     not sold again`. Not counted, not charged.
   - **failed** — anything else (sold to someone else, another day, unknown number):
     the old reason, unchanged.
5. The books are written **once**. When any item resumed: a Transactions row already
   carrying this request (`findBySaleRef`) → no second row and no second payment
   record; a ledger debit already carrying `<requestId>-<design>` (`findByTxnId`) →
   that design's debit is skipped; an invoice already issued for the request
   (`getByRequestId`) → none re-issued; and the enrichment the earlier run booked with
   stays on the row (the re-entered rates are not persisted over it). An audit row
   `sale_bundle_resumed` records the resumed items and whether the earlier run had
   reached the books.
6. APF-1 still refuses a request in which every item FAILED (duplicates count as
   failed); a request whose every item RESUMED proceeds to the books — that is exactly
   the "flipped everything, then died before the books" shape.

R-9BF6 after this ships: Approve → wizard (customer, both rates, payment, multiplier)
→ the card's reply reports 8 bales / 33 thans / 990 yd recorded; Inventory gains the 6
thans of 772; ONE Transactions row (990 yd), ledger debits for 9037 (900 yd) and 9006
(90 yd), one invoice; the 27 earlier thans are neither re-flipped nor re-charged.

### 8c. Not done / owed

- The admin's reply and the requester's notice print `failedItems` only; the resume
  is on the card (before) and in the audit trail (after), not in the reply. One
  ask-first line in `approvalEvents` (render `bundleReport.resumedItems`).
- The single doors (`sell_than` / `sell_package`) can be half-done the same way (flip
  written, `updatePrice` or the Transactions append refused) and still close by hand.
- After a `SHEETS_QUOTA_AFTER_APPLY` on a bundle the Mark-as-done chip is no longer
  offered (the stock reads as the sale's own); the admin walks the wizard once more
  and the executor books nothing twice. Acceptable; a "books done — just mark it"
  shortcut would need the APF-2 pre-check to read Transactions (ask-first).

### 8d. Tests

`test/unit/services/saleResume.test.js` (classification, warehouse scope, reverted
sales, the single-door exemption), `test/unit/services/inventoryService.saleBundleResume.test.js`
(the R-9BF6 shape end to end through the executor: resume, duplicate, books already
written, unreadable queue → nothing written, all-resumed, sold elsewhere, enrichment
not overwritten, the after-apply wording per door),
`test/unit/repositories/inventoryRepository.markItemsSold.test.js` (refusals carry
rows), `test/unit/repositories/transactionsRepository.findBySaleRef.test.js`,
`test/unit/services/saleBundleCard.test.js` (the legend), the sentinel C8 case and the
checker's reading.
