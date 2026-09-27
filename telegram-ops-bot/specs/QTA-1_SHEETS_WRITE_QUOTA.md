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
the executor puts the flipped thans back and sells the whole request afresh in one
pass, writing the books once. A single-door request (`sell_than` / `sell_package`)
has no restart path: do not re-approve it; tell me the output and its missing side is
posted by hand with the numbers in front of us. The checker's reading line says
which of the two applies.

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
   written it says `Applied and booked — …` (or `Applied — … N book write(s) FAILED as
   well (…)`, naming what to post by hand): for a bundle, tap Approve again after a
   minute (the executor sees the sale is already booked and only marks the request
   approved — §8); for a single door, choose ✅ Mark as done.

## 6. Owed / follow-ups

- ~~**Idempotent money side.**~~ Built as QTA-2 (§8, 27-Sep-2026) for the bundle
  door: a re-approve restarts a half-done sale (put back, sold afresh, booked once)
  and closes an already-booked one without touching anything. Still owed: the same
  for the single doors (`sell_than` / `sell_package` — their executor refuses a sold
  than, so a half-done single sale is still closed by hand), and printing the
  restart on the admin's reply and the requester's notice (`approvalEvents` renders
  `bundleReport.failedItems` only — `restartedThans` / `alreadyBooked` are carried
  but not printed; one ask-first line).
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
invoice, request still pending): "Go with your recommendation."** A first cut
RESUMED such a sale (the 27 counted, the 6 sold). **Owner, 27-Sep: "I think it should
revert and restart for complete sale."** Rebuilt that way the same day: the flipped
thans are PUT BACK and the whole request is sold AFRESH in one clean pass.

### 8a. The one question

**Is this row's stock gone because THIS sale already took it?** An Inventory row is
*this sale's own* when it is `sold`, `soldTo` = the request's customer and `soldDate`
= the request's sale date (case-blind names; every date spelling the doors store —
`25/09/2026`, `25.09.2026`, `yesterday`, ISO — read through `normalizeSalesDate`; an
unreadable spelling is never a match). Judged **per row**, so a bale carrying a than
sold to someone else months ago still restarts its own thans. Rows are resolved the
way the sale writer resolves them (a than's `baleUid` pins between same-numbered
rows; a package is its rows in the item's store). `src/services/saleRestart.js`
answers it for every surface.

| Surface | Before | After |
|---|---|---|
| `saleStockCheck.allItemsGone` (APF-2 pre-check, 🛂 inbox chips + card buttons, sentinel C8) | a half-done bundle read as *gone* → the admin was offered only **Mark as done** (posts nothing) or Reject | a bundle item with rows of its own sale is **not gone**: the wizard runs and the executor restarts. Single doors unchanged (their executor has no restart path) |
| the approval card (`approvalCards.enrichBundleItems` → `buildSaleCard`) | `⚠️ N of M item(s) marked ⚠️ have no available stock — check before approving` | when every ⚠️ item is its own sale's: `⚠️ 7 of 8 item(s) marked ⚠️ are sold to Ayubal Ansari on 25-Sep-2026 — this request's own half-done run. Approve restarts it: they are put back and the whole request is sold afresh; nothing is charged twice (a than another approved sale covers is refused as a duplicate).`; mixed: the old line plus `N of them are this request's own half-done run: put back and sold afresh on Approve.` |
| the bundle executor (`inventoryService`, `sale_bundle` branch) | every already-sold item was a *failure*: the 6 free thans would have sold, the 27 reported as failed, the customer charged for 180 of 990 yards | see 8b |
| `inventoryRepository.markRowsAvailable` (new, behind `stockEngine.restartSaleRows`, listed in the S53 one-door lint) | — | the put-back: each row re-read fresh and flipped only if it is still that row and still sold to that buyer on that date; ONE `batchUpdate` (H:P → available, buyer and date cleared, price kept); one BaleMovements append per warehouse, kind **`correction`** (RET-2: never a customer return), dated the day of the restart; one stock-events shadow per warehouse |
| `inventoryRepository.markItemsSold` | a refusal said only *why* | each refusal also carries the rows it FOUND (kept from the first cut; the checker and tests read them) |
| `consistencySentinel` C8 | a half-done bundle pending > 1 h read as a zombie (*use Mark as done*) | `… but 7 of 8 item(s) are already sold to Ayubal Ansari on 2026-09-25 — this request's own half-done run (flipped without the books). Open it and Approve once: the bot puts them back and sells the whole request afresh, nothing charged twice.` |
| `scripts/check-sale-request.js` | HALF-DONE always said *do not re-approve*; judged bundles only | a bundle: *Tap Approve ONCE … puts the flipped thans back and sells the whole request afresh … If the reply names another request as a duplicate, Reject this one*; a single door: post by hand. Judges single-door requests too |
| the after-apply quota message (`SHEETS_QUOTA_AFTER_APPLY`) | `Applied and booked — … choose ✅ Mark as done (no re-run)` even when a book write had been refused in the same storm | names any collected book failure (`Applied — … 1 book write(s) FAILED as well (Transactions row (bundle)) — post them by hand.`); a bundle: `… tap Approve again — the bot sees the sale is already booked and only marks the request approved (nothing is sold or charged twice)`; a single door: unchanged |
| the single doors' rate stamp (`updatePrice` after the flip) | an unguarded write: a refusal threw the executor away with the than sold and the request pending | collected like the book writes (`rate stamp (sell_than / sell_package)`) |
| the sale's payment record | `crmService.recordPayment` minted `PAY-<timestamp>` — nothing tied it to the request | an approved sale's payment pair is keyed `<requestId>-PAY`, so the books check below can see it |

### 8b. What the executor does now, in order

1. Reads Inventory **fresh** and lists the items with rows of this sale's own
   (`ownRowsByItem`). None → a normal sale; no record is read, nothing is put back.
2. Some → reads the resolved queue, the pending queue (already in hand), and the
   request's book rows (`booksFor`: its Transactions row, every ledger entry whose
   txn id starts with the request id — sale debits and the `-PAY` pair — and its
   invoice). **If any read throws, nothing is written**: `ok:false` — `27 than(s) of 7
   item(s) are already sold to Ayubal Ansari on 2026-09-25 by an earlier run of this
   request, and the records needed to restart it safely could not be read (…). Nothing
   was changed — try again in a minute.` The reads have their own quota; a doubtful
   restart is worse than a minute's wait.
3. `planRestart` decides row by row:
   - a row another **PENDING** sale request of the same customer and day covers →
     the whole restart is **blocked**: `… another PENDING sale request (R-PPPP) for the
     same customer and day covers bale 6210/5 — decide that request first (approve or
     reject it), then tap again. Nothing was changed.` (the D-4 danger: an identical
     request whose own status write was refused would otherwise be invisible);
   - a row an **APPROVED** one covers (not undone by an approved
     `revert_sale_bundle`; a request whose sale date is unreadable still counts) →
     that sale's: left sold; the item, if nothing of it can sell, is refused as
     `already sold to Ayubal Ansari on 2026-09-25 under request R-DDDD — a duplicate,
     not sold again`;
   - every other own row → **put back**.
4. **Any book row already carries the request** → the earlier run reached the
   books. Nothing is put back, sold, booked or invoiced; the own rows are counted as
   the sale as booked, any other item is reported as `not part of the sale already
   booked under this request — raise a fresh request if it is still to be sold`, a
   book side the earlier run never wrote is reported through the BOOKS NOT UPDATED
   channel (`missing — … post it by hand (nothing is re-run)`), a typed amount paid is
   NOT recorded again (`check the customer statement and record the 50,000 via 💰 if
   it is missing`), the enrichment the earlier run booked with stays on the row, and
   the request is marked approved. Audit `sale_bundle_already_booked`.
5. Otherwise the put-back: `stockEngine.restartSaleRows` (one write, a correction
   under the request's authority, the approving admin as actor). Audit
   `sale_bundle_restarted` (rows, skipped rows, duplicates). A refusal here throws
   before anything changed.
6. The one batched sale write (`sellItems`) then sells every item — the put-back
   rows and the never-touched ones alike — at today's rate, one movement row per
   bale. A refusal here leaves the rows **available** and the request pending: the
   next Approve is a plain sale.
7. APF-1 still refuses a request in which every item failed, now naming every
   item's reason (a duplicate names the request that has it). The books follow once:
   Transactions row, ledger debit per design, the payment pair keyed to the request,
   the invoice.

R-9BF6 after this ships: Approve → wizard (both rates, payment, multiplier) → 27 thans
put back (BaleMovements: `sold @ Kano office → available @ Kano office · correction ·
Ayubal Ansari`), then all 33 sold in one write (`available → sold · sale`), the reply
reports 8 bales / 33 thans / 990 yd; ONE Transactions row (990 yd), ledger debits for
9037 (900 yd) and 9006 (90 yd), one invoice; every row carries the rate entered today.

### 8c. Adversarial review, 27-Sep-2026 (three lenses, on the first — resume — cut)

Data shapes · money idempotency · surfaces. Every confirmed finding is closed by the
rebuild or a same-day edit:

| # | Finding (on the resume cut) | Closed by |
|---|---|---|
| 1 | the three "never booked twice" reads failed OPEN (a refused Transactions / ledger / invoice lookup → a second row, debits, invoice, payment; the reply said BOOKS NOT UPDATED while they were posted twice) | `booksFor` throws → `ok:false`, nothing written (8b step 2) |
| 2 | a package item on a bale with ANY row not this sale's (a than sold to someone else in July, `in_transit`) could never resume: 150 yd flipped, never booked, request approved; the card steered to Mark-as-done | ownership per ROW; the July than stays Zakirullah's, the rest restarts |
| 3 | the duplicate check saw APPROVED rows only: an identical request whose status write was refused (pending, booked) was invisible → both requests booked | a PENDING cover BLOCKS the restart by name |
| 4 | the payment was gated on the Transactions row, two independent writes: double or lost payment | payment pair keyed `<id>-PAY`; a booked close never re-records and says so |
| 5 | `priorTxn ⇒ books complete` was false after a partial first run (a transfer's `in_transit` bale refused, the rest booked) → items sold later with no row | a booked close sells nothing more; the other items are named for a fresh request |
| 6 | `itemRows` ignored `baleUid` / picked all twins where the writer picks one → pre-read and writer disagreed | rows resolved the writer's way |
| 7 | `normDay` handed `yesterday` / `25.09.2026` back unchanged → an approved duplicate with such a date was missed (double charge) and a request with such a date never resumed | `dayOf` = `normalizeSalesDate` first; an unreadable date on the OTHER request cannot clear it |
| 8 | a than item of another request marked a whole pending bale a duplicate | coverage per row (`coversRow`) |
| 9 | the card / chips / sentinel asserted "THIS request" without the duplicate check | worded as the request's own run with the duplicate refusal named; the executor is the guard |
| 10 | the APF-1 refusal dropped the per-item reasons | the message lists every item's reason |
| 11 | single doors: `updatePrice` was an unguarded write after the flip → a refusal left the than sold, the request pending, and Mark-as-done then closed it with no books | collected as `rate stamp (…)` |
| 12 | after-apply message claimed "booked" over a collected book failure | names the failed writes |
| 13 | resumed thans had no movement row (the earlier append never landed) | the restart logs the correction and the fresh sale |
| 14 | the re-entered rates could overwrite the enrichment the books were made with | not persisted on a booked close |

Recorded, not changed: the admin's reply and the requester's notice print
`failedItems` only (`approvalEvents`, ask-first — the restart is on the card before
and in the audit trail after); `✎ Change customer` on the re-run rewrites
`aj.customer` so the earlier rows no longer match (they then fail as sold elsewhere —
the safe direction); two DIFFERENT requests selling the same bale at the same moment
run under different mutex keys (pre-existing since QTA-1; the restart's put-back →
sell window is a second or two); the Drive bill upload repeats on a re-approve.

### 8d. Tests

`test/unit/services/saleRestart.test.js` (date spellings, ownership per row, the
writer's row resolution, `claimsRow`, `planRestart`, `booksFor`, the single-door
exemption), `test/unit/services/inventoryService.saleBundleRestart.test.js` (the
R-9BF6 shape end to end: restart, duplicate, pending block, booked close with the
missing sides named, unreadable records → nothing written, normal sale, all-flipped,
per-row bale, sold elsewhere, a refused sale write after the put-back, all-duplicate
refusal with reasons, the request-keyed payment, the after-apply wording, the
single doors' guarded rate stamp), `inventoryRepository.markItemsSold.test.js`
(`markRowsAvailable`), `stockEngine.test.js` (`restartSaleRows`),
`saleBundleCard.test.js` (the legend), the sentinel C8 case, the checker's reading.
