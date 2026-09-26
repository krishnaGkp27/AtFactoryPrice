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
charged: do not re-approve (the executor would refuse — every item already sold);
tell me the output and the missing side is posted by hand with the numbers in front
of us.

## 5. Owner steps

1. Run the checker for R-9BF6 (above) and send me the output.
2. Optional: set `SHEETS_WRITES_PER_MINUTE` on Railway if you ever want a different
   cap (default 50). Not a Settings-sheet cell: it governs the client that reads the
   Settings sheet.
3. Approve the next large sale as usual; the card should never show Google's quota
   text again. If it ever shows the new sentence, wait a minute and tap again — nothing
   is half-written.

## 6. Owed / follow-ups

- **Idempotent money side.** After the one-call flip, a refusal on a LATER step
  (Transactions, ledger, invoice) still leaves the goods sold and the request pending;
  a re-approve then refuses (every item already sold) and offers Mark-as-done, which
  posts nothing. The fix is to make those steps idempotent by request id so a
  re-approve completes them. Proposed, not built — say the word.
- **Other large loops** (a 43-bale dispatch, a 64-than return): batch them the same
  way. Ranked by realistic size in the review (spec §7).
- `updatePrice` on a sale stamps the negotiated rate on every row of the bale in that
  warehouse, **including thans sold earlier to someone else at another rate** —
  carried over unchanged from the old per-item path; it rewrites history on those
  rows and needs your ruling.

## 7. Adversarial review

Recorded below once the review completes.
