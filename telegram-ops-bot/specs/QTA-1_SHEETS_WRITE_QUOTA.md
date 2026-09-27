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
   written it says `Applied and booked — …` (or `Applied — … N book write(s) did not
   land as well (…)`): for a bundle, **post nothing by hand** — tap Approve again
   after a minute and the executor closes it, writing only a missing book row, or
   restarts it if no book row landed (§8); for a single door, post the named writes
   by hand and choose ✅ Mark as done.

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
*this sale's own* when it is `sold`, on the request's sale date, to the request's
customer under ANY spelling that customer is registered with (canonical name or a
CUS-2 alias). Every date spelling the doors and the sheet store (`25/09/2026`,
`25.09.2026`, `25-Sep-2026`, ISO) is read through `normalizeSalesDate`; a relative
word (`yesterday`) or anything only `Date.parse` could guess is **unreadable** — it
never owns a row and never clears a claim. Judged **per row**, so a bale carrying a
than sold to someone else months ago still restarts its own thans; rows are resolved
the way the sale writer resolves them (a than's `baleUid` pins between same-numbered
rows; a package is its rows in the item's store); a row named twice (a bale whole
and one of its thans) is claimed once. `src/services/saleRestart.js` answers it for
every surface.

| Surface | Before | After |
|---|---|---|
| `saleStockCheck.allItemsGone` (APF-2 pre-check, 🛂 inbox chips + card buttons, sentinel C8) | a half-done bundle read as *gone* → the admin was offered only **Mark as done** (posts nothing) or Reject | a bundle item with rows of its own sale is **not gone**: the wizard runs. Single doors unchanged (their executor has no restart path) |
| the approval card | `⚠️ N of M item(s) marked ⚠️ have no available stock — check before approving` | `⚠️ 7 of 8 item(s) marked ⚠️ are sold to Ayubal Ansari on 25-Sep-2026 — this request's own half-done run. Approve restarts it: they are put back and the whole request is sold afresh; nothing is charged twice (a than another approved sale covers is refused as a duplicate).`; mixed: the old line plus `N of them are this request's own half-done run: put back and sold afresh on Approve.` |
| the bundle executor (`inventoryService`, `sale_bundle`) | every already-sold item was a *failure*: the 6 free thans sold, the 27 reported failed, the customer charged for 180 of 990 yards | see 8b |
| `inventoryRepository.markRowsAvailable` (new, behind `stockEngine.restartSaleRows`, listed in the S53 one-door lint) | — | the put-back: each row re-read fresh, flipped only if it is still that row and still sold to that buyer on that date, a row named twice once; ONE `batchUpdate` (H:P → available, buyer and date cleared, price kept); one BaleMovements append per warehouse, kind **`restart`** (BUSINESS_RULES §6d — neither a return nor a correction, so the Supply Ledger and DML-1 keep ONE supply), dated the restart day; one stock-events shadow per warehouse (event `correction` — that table's event list is closed) |
| `inventoryRepository.markItemsSold` | read the 5 s Inventory cache | reads **fresh** — a snapshot taken before the put-back would refuse every row the put-back just made available; each refusal also carries the rows it found |
| `consistencySentinel` C8 | a half-done bundle pending > 1 h read as a zombie (*use Mark as done*) | `… are already sold to Ayubal Ansari on 2026-09-25 by this request's own earlier run. Open it and Approve once: the bot finishes it — puts them back and sells the whole request afresh, or, if that run already booked the sale, only closes it. Nothing is charged twice.` |
| `scripts/check-sale-request.js` | HALF-DONE always said *do not re-approve*; judged bundles only; the payment pair counted as a sale debit | per state: a pending bundle with no book → *Tap Approve ONCE … puts the flipped thans back and sells the whole request afresh*; with a book row → *Approve once: it only closes it and writes the missing book row*; WHOLE but still pending → *Approve once, it only closes it*; no longer pending → hand posting; a single door → hand posting. Every bundle line says *Post nothing by hand*. Judges single-door requests too; `<id>-PAY` is not a sale debit |
| the after-apply quota message (`SHEETS_QUOTA_AFTER_APPLY`) | `Applied and booked — … choose ✅ Mark as done (no re-run)` even when a book write had been refused in the same storm | names any write that did not land; a bundle: **`Post nothing by hand.`** `Wait one minute, then tap Approve again — the bot checks what was written: it closes the request and writes only a missing book row, or, if no book row landed, puts the thans back and books the sale itself.` (a hand row carries no request id, so the bot could not see it and would write it again); a single door: `Post those by hand, then wait one minute … Mark as done` |
| the single doors' rate stamp (`updatePrice` after the flip) | an unguarded write: a refusal threw the executor away with the than sold and the request pending | collected like the book writes (`rate stamp (sell_than / sell_package)`) |
| the sale's payment record | `crmService.recordPayment` minted `PAY-<timestamp>` — nothing tied it to the request | an approved bundle's payment pair is keyed `<requestId>-PAY`, so a restart sees it and never records it twice |

### 8b. What the executor does now, in order

1. Reads Inventory **fresh**, and the customer's spellings (Customers, cached). Lists
   the items with rows of this sale's own (`ownRowsByItem`) and the rows of its items
   sold ON its date to someone else (`foreignSameDayRows`). Neither → a normal sale:
   nothing more is read, nothing is put back.
2. Otherwise it reads the resolved queue (the pending queue is already in hand) and,
   when it has own rows, the three book sheets ONCE (`readBooks`: Transactions
   column O, ledger txn ids `<id>-…`, Invoices) and the Customers row. **If any read
   throws, nothing is written**: `ok:false` — `27 than(s) of 7 item(s) are already
   sold to Ayubal Ansari on 2026-09-25 by an earlier run of this request, and the
   records needed to finish it safely could not be read (…). Nothing was changed —
   try again in a minute.`
3. **The request's own SALE books exist** (its Transactions row, a ledger debit
   `<id>-<design>`, or its invoice — the `<id>-PAY` pair alone is not a sale book) →
   the earlier run reached the books. Checked FIRST, so a booked request always
   closes. Nothing is put back or sold; the own rows are the sale as booked; any
   other item is reported `not part of the sale already booked under this request —
   raise a fresh request if it is still to be sold`. Each book row that run never
   wrote is **written now, keyed to the request** (Transactions row; the ledger debit
   of each design not yet debited; the invoice, for the sale as booked) at the rates
   that run booked with when the row carries them; a found invoice is delivered again.
   A typed amount paid is never recorded on this path (that run may have recorded it
   under an older reference) — the reply says to check the statement and record it via
   💰 only if missing. The enrichment stays as booked. Audit `sale_bundle_already_booked`.
4. **Stranded rows** — rows of its items sold on its date to someone else that no
   other sale request (approved, pending, or rejected-but-booked, any customer)
   explains → refused: `27 than(s) of this request (bale 771/1…) are sold on 2026-09-25
   to AYUBAL ANSARI, not to Musa, and no other request explains them — an earlier run
   of this request probably sold them before the customer was changed. If so, set the
   customer back to AYUBAL ANSARI and approve again; otherwise Reject this request.
   Nothing was changed.` (✎ Change customer on a re-run would otherwise leave those
   rows sold and unbooked behind an approved request.)
5. **A row another PENDING sale of the same customer and day covers** → blocked. If
   that request carries this sale's books: `… another PENDING request, R-BBBB, already
   carries this sale's books (it covers bale 771/1). Approve R-BBBB first — it closes
   without selling anything again — then Reject this one.` Otherwise: `… another
   PENDING sale request, R-PPPP, for the same customer and day covers the same thans
   (bale 6210/5). If the two are twins, Reject one of them and Approve the other; if
   R-PPPP is a different sale, decide it first.`
6. **A row an APPROVED sale covers** (same customer under any spelling, same or
   unreadable day, not undone by an approved `revert_sale_bundle`) — **or a REJECTED
   one whose sale books exist** — is that sale's: left sold; the item, if nothing of
   it can sell, is refused as `already sold to Ayubal Ansari on 2026-09-25 under
   request R-DDDD — a duplicate, not sold again`.
7. Every other own row is **put back** (`stockEngine.restartSaleRows`, one write,
   kind `restart`, the approving admin as actor; audit `sale_bundle_restarted`), then
   the one batched sale write (`sellItems`, fresh read) sells every item at today's
   rate. A put-back row the sale then cannot take (another request or a transfer took
   it in between) is named `put back by the restart, then not available to sell again
   … check bale 771`; if NONE can be taken the request stays pending with nothing
   booked (`the 33 than(s) of this request's earlier run were put back (they are
   available again) but the sale could not take them … Approve again`) — never the
   "already sold — Mark as done" card, which would close it unbooked.
8. APF-1 still refuses a request in which every item failed, naming every item's
   reason. The books follow once: Transactions row, ledger debit per design, the
   payment pair `<id>-PAY` (skipped when it already exists), the invoice.

R-9BF6 after this ships: Approve → wizard (both rates, payment, multiplier) → the 27
thans put back (BaleMovements `sold → available · restart · Ayubal Ansari`, dated the
tap day), all 33 sold again under the sale date 25-Sep-2026 (`available → sold ·
sale`), the reply reports 8 bales / 33 thans / 990 yd; ONE Transactions row (990 yd),
ledger debits for 9037 (900 yd) and 9006 (90 yd), the payment pair if one was
entered, one invoice; every row carries the rate entered at the tap.

### 8c. Adversarial review 1, 27-Sep-2026 (three lenses, on the first — resume — cut)

Data shapes · money idempotency · surfaces. Every confirmed finding is closed by the
rebuild or a same-day edit:

| # | Finding (on the resume cut) | Closed by |
|---|---|---|
| 1 | the "never booked twice" reads failed OPEN (a refused lookup → a second row, debits, invoice, payment) | every read fail-closed (8b step 2) |
| 2 | a package item on a bale with ANY row not this sale's could never resume: flipped, never booked, request approved | ownership per ROW |
| 3 | the duplicate check saw APPROVED rows only: an identical pending request was invisible | a PENDING cover blocks by name (step 5) |
| 4 | the payment was gated on the Transactions row: double or lost payment | payment pair keyed `<id>-PAY` |
| 5 | `priorTxn ⇒ books complete` was false after a partial first run | a booked close sells nothing more; missing rows are written, the other items named for a fresh request |
| 6 | `itemRows` ignored `baleUid` / picked all twins where the writer picks one | rows resolved the writer's way |
| 7 | `normDay` handed `yesterday` / `25.09.2026` back unchanged | `dayOf` (8a) |
| 8 | a than item of another request marked a whole bale a duplicate | coverage per row |
| 9 | the card / chips / sentinel asserted "THIS request" without the duplicate check | worded as the request's own run with the duplicate refusal named |
| 10 | the APF-1 refusal dropped the per-item reasons | every item's reason listed |
| 11 | single doors: an unguarded `updatePrice` after the flip | collected as `rate stamp (…)` |
| 12 | after-apply message claimed "booked" over a collected book failure | names the writes that did not land |
| 13 | resumed thans had no movement row | the restart logs the put-back and the fresh sale |
| 14 | re-entered rates could overwrite the enrichment the books were made with | not persisted on a booked close |

### 8d. Adversarial review 2, 27-Sep-2026 (four lenses on the restart build, three refuters each)

Money · data shapes · surfaces · rules. 31 findings, 14 confirmed by a majority of
refuters (most with reproductions against the real modules); several surface/rules
refuters were cut short by a usage limit, so their findings were judged here by
reading the code. Closed in the same change:

| # | Finding | What changed |
|---|---|---|
| 1 | a booked request blocked by its pending twin; rejecting the booked one let the twin put its rows back and book the sale a second time | sale books are checked FIRST (a booked request always closes); a REJECTED request whose sale books exist still claims its rows; the block names which request carries the books |
| 2, 9, 10, 11 | the put-back logged as a §6d `correction` read as "sale erased" to the Supply Ledger (a later return left a credit with no debit, net negative) and as an unpaired IN leg to DML-1 (every balance before the restart day one bale short) | movement kind `restart` (§6d), which both readers ignore; fixtures for both ledgers (`supplyLedger.test.js`, `designMovement.test.js`) |
| 3 | `markItemsSold` read the 5 s cache: a snapshot from before the put-back refused every put-back row; the APF-1 card then offered Mark as done over rows now available and unbooked | fresh read; after a put-back an all-refused sale stays pending with its own message; a partly refused one names the rows |
| 4 | the supply ledger lost a restarted sale's debit after a later return | as 2 |
| 5, 12 | the after-apply message said "post them by hand" AND "tap Approve again": a hand row carries no request id, so the re-tap booked everything again | a bundle is told to post NOTHING; the next Approve writes whatever is missing, keyed to the request |
| 6 | the payment pair alone closed a request as "booked" with nothing else written | sale books only; a payment-only request restarts and skips the payment |
| 7 | the booked close discarded the invoice it had in hand | the found (or newly issued) invoice is returned and delivered |
| 8 | an approved same-day sale under an ALIAS of the customer was invisible → its rows re-sold and re-booked | ownership and claims by every registered spelling |
| 13 | the blocked / unreadable results reach the admin as "⚠️ Approved but execution failed" and DM the requester "approved but could not be completed" | **not changed — `approvalEvents` is ask-first.** The message itself says `Nothing was changed`; owed below |
| 14 | two pending twins blocked each other with "approve or reject it", and Approve was refused both ways | the message says: twins → Reject one, Approve the other |

Also closed from the unverified list: ✎ Change customer stranding the earlier rows
(step 4); a row named twice counted and put back twice; C8 and the checker wording
for a request whose books ARE written; the checker advising Approve on a request no
longer pending; `dayOf` shifting under a non-UTC clock or reading `yesterday`.

### 8e. Not done / owed

- **`approvalEvents` rendering (ask-first).** A blocked, unreadable or all-refused
  restart reaches the admin as `⚠️ Approved but execution failed: …` and DMs the
  requester that the request was approved. Nothing was approved and nothing changed.
  The executor could flag these (`retry` / `blocked`) and the reply render them as a
  plain line with no requester DM. The admin's reply also never mentions the restart
  (`bundleReport.restartedThans`) or the booked close (`alreadyBooked`).
- A request that was booked, then had its goods RETURNED, then re-approved: its own
  rows are no longer sold, so the executor does not read the books and would sell
  and book it again. Needs a book read on every bundle approval (three sheet reads);
  judged too costly for so rare a shape — recorded.
- The single doors (`sell_than` / `sell_package`) still have no restart path.
- Two DIFFERENT requests selling the same bale at the same moment run under
  different mutex keys (pre-existing since QTA-1); the put-back → sell window is a
  second or two.

### 8f. Tests

`test/unit/services/saleRestart.test.js` (date spellings, spellings sets, ownership
per row, the writer's row resolution, the once-per-row claim, foreign same-day rows,
`claimsRow` pending / booked / any, `planRestart` with blocked / duplicate / stranded,
`readBooks`), `test/unit/services/inventoryService.saleBundleRestart.test.js` (the
R-9BF6 shape end to end: restart, duplicate, pending block, booked close writing the
missing rows and delivering the invoice, payment-only books, booked-first ordering,
the booked twin and its rejected copy, the alias duplicate, the stranded customer
change, unreadable records → nothing written, normal sale, all-flipped, per-row
bale, sold elsewhere under another request, a refused sale write after the put-back,
an all-refused re-sale after the put-back, all-duplicate refusal with reasons, the
request-keyed payment, the after-apply wording, the single doors' guarded rate
stamp), `inventoryRepository.markItemsSold.test.js` (`markRowsAvailable`),
`stockEngine.test.js` (`restartSaleRows`), `supplyLedger.test.js` and
`designMovement.test.js` (a restarted sale stays one supply), `saleBundleCard.test.js`
(the legend), the sentinel C8 case, the checker's readings.
