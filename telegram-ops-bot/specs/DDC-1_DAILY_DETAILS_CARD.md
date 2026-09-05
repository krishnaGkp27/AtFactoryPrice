# DDC-1 — Daily Details Card

**PROPOSAL — no implementation; awaiting owner rulings** (drafted 05-Sep-2026
from a code sweep; every file:line below was re-read on `origin/main` that day,
and re-verified after the adversarial review of the same day).

Owner, 05-Sep-2026, with a hand sketch: *"make a daily display card like the
one in the image. If it does not fit into the navigation properly, give me the
refined idea. Check if we already have any of these functionalities or if we
have to make a foundation from scratch."*

The sketch, as drawn:

```
Daily Details Card
(1) Sales Data            Kano  50 / 245        ← first = Total Cash Collected
                          Lagos 105 / 105          second = From goods supplied
                                                   (no currency on either)
(2) ~~Office~~ Expenses   [Kano 5512₦] [Lagos 10000₦] [House]
                          chips are TAPPABLE → amount details, in Naira
    ~~(3) House expenses~~  (crossed out; folded into the House chip)
(3) Outstanding           Kano 241 · Lagos 52   (value only, no currency)
```

---

## 1 · Verdict

About a third of the card exists and can be reused as-is — with one caveat
per block that the first draft of this spec missed.

Block (2) **Expenses**: the office cash book is EXP-1 —
`branchOpsService.getExpenseDayReport({ branch, date })` (:523-529) already
returns one branch's day (allowances, office items, commissions, cash-in,
`spent`, running `balance`, pending count) at read time, and
`eveningExpenseReport.formatBranchReport(rep)` (:70-102) already renders the
Naira detail card a tapped chip should open; the tap mechanism itself exists
in the morning digest (`rmd:d:<KEY>` session-free chips that edit the pushed
message in place). But the owner crossed out the word **Office**: the block is
ALL expenses, and the business has a SECOND money-out path the cash book never
sees — PAY-1 payment requests (salaries, contractor payments, marked Done by
the finance hand) live in `PaymentRequests` only (`paymentService.js` has no
`BranchOpsLog` reference; BUSINESS_RULES §13). Whether the chip includes PAY-1
money paid that day is a ruling (R13), not a reuse.

Block (1) **Sales** exists as raw rows but has no per-city, per-day cut
anywhere: sale value per day is computed only as a whole-day figure (Sales
Browser, `qty × pricePerYard` on Transactions rows, `salesBrowserFlow.js:86`)
and cash received at a sale sits unsummed on `Transactions.AmountPaid`;
grouping either by city is new code over the LOC-1 register
(`locationService.locationOf`). Two facts shape the definitions in §3: the
same sale-time cash is ALSO posted to `Ledger_Entries` as a `PAY-<ts>`
Cash/Bank debit pair indistinguishable from a standalone payment
(`inventoryService.js:443-448, 466-471, 1576-1581` → `crmService.recordPayment`
:48-56), so the ledger cannot be added on top of `AmountPaid`; and the
Inventory rate column is rewritten on every row of a bale at each approval
(`inventoryRepository.updatePrice` :671-690), so an Inventory-derived "goods
supplied" value is the bale's CURRENT rate, not the day's booked rate.

Block (3) **Outstanding** has no counterpart at all and is the biggest gap —
and not mainly a coding gap: outstanding is per CUSTOMER
(`accountingService.getCustomerLedger`), customers carry no city, ledger rows
carry no warehouse, there are TWO live customer-money ledgers in the workbook
(`Ledger_Entries`, written by the sale/payment executors; and
`LedgerTransactions` + `LedgerBalanceCache` behind the typed `/ledger`
`/balance` `/payment` doors — `ledgerTransactionsRepository.js:9`,
`telegramController.js:4362-4389` → `src/commands/ledgerCommands.js`,
`balanceService.js`), and BUSINESS_RULES §15b (locked 22-Aug-2026) says no new
bot-side report of customer money without a fresh ruling — a bot-computed
figure rendered on a bot-served web page is still bot-side. So: reuse EXP-1
and the digest chip pattern; build one small read-time "figures per city per
day" service for Sales; and put Outstanding behind an explicit ruling
wherever it is shown (it is the one block the sketch cannot have without the
owner overriding his own lock). Two owner steps gate everything: the
Locations sheet must be seeded (today every place buckets under "Unassigned",
so the card would show one row, not Kano/Lagos), and `Users.branch` must read
`Kano` / `Lagos` for every expense filer.

---

## 2 · The card, as it will appear

### 2a · Straight from the sketch (one card, three blocks — nothing added)

```
📆 *Daily Details — 05-Sep-2026*

💵 *Sales* — cash collected / goods supplied
Kano   50 / 245
Lagos  105 / 105

💸 *Expenses*
[Kano ₦5,512]  [Lagos ₦10,000]  [House ₦3,200]

📒 *Outstanding*
Kano   241
Lagos  52

[🏠 Back to menu]
```

This is the sketch and only the sketch: three blocks, tappable expense chips,
one Back row. Sales and Outstanding rows are bare numbers with **no unit
anywhere** — the sketch draws none, and the face prints raw naira integers
(en-NG grouping, `fmtQty`) so a ₦400 day reads `400`, never `0`. Expense chips
carry ₦, as drawn. The only liberty: the house formatter puts ₦ before the
digits (`₦5,512`, `fmtMoneyShort`), the sketch after (`5512₦`) — ruling R1.
A ÷1000 "₦ thousands" face is offered as an opt-in knob in §5, not a default.

A tapped expense chip edits the same message into the EXP-1 day record,
`formatBranchReport(rep)` (:70-102). Two things about that reuse are NOT free:
its header still reads **"Office expenses"** (:71 — the word the owner crossed
out) and its date is the raw ISO day (`${rep.date}`) while the card face uses
the house `DD-MMM-YYYY` (`formatDate.js:16`, TIME-1). Both are one thin
wrapper away (heading override + `fmtDate`), listed in build step 2:

```
🌇 *Office expenses — 2026-09-05 (Kano)*        ← as it renders today
                                                   (wrapper: "Expenses — 05-Sep-2026 (Kano)")
👤 Abdul ₦2,000 · Yarima ₦1,500
🧾 Fuel ₦1,512 · Water / Refreshment ₦500
━━━━━━━━━━
Spent *₦5,512* · Balance in hand *₦41,300*
_1 item(s) awaiting sign-off_

[◀ Daily Details]
```

A city with nothing filed shows the EXP-1 "⚠️ Nothing filed today" card; a
confirmed zero day shows "✅ Nothing spent today (confirmed)". A city with no
sales prints `Kano 0 / 0`; a place the register does not know prints under
`❓ Unassigned` (§6e: annotate, never hide). A chip whose `spent` includes
`pending_approval` rows (they count as spent, `branchOpsService.js:183-186`,
but can still be rejected under DUAL-1) carries a `⏳` mark so the face number
can shrink later with a visible reason — R14.

### 2b · Refined variant — RECOMMENDED

The sketch fits Telegram navigation as ONE card (it is the Business Glance
shape: header, short sections, footer). What does not fit is block (3): an
outstanding-per-city figure is a customer-money report and §15b sends those
to the website's finance data source. The refinement is therefore not a
different card but a different split, plus a handful of buttons the sketch
does not have — each marked so the owner can tell what he drew from what was
added:

```
📆 *Daily Details — 05-Sep-2026*
_tap a city for details_                  ← added, not in sketch

💵 *Sales* — cash collected / goods supplied
Kano   50 / 245
Lagos  105 / 105
[📈 Today's sales]                        ← added, not in sketch: opens the
                                             Sales Browser (day picker today;
                                             a day-preselected entry needs a
                                             small salesBrowserFlow.start({ day })
                                             extension — build step 2)

💸 *Expenses*
[Kano ₦5,512]  [Lagos ₦10,000]  [House ₦3,200]

📒 *Outstanding* — not on the bot card    ← until R6 rules; §15b
[🌐 Open /daily]                          ← added, not in sketch: LNK-1 button
                                             (the web variant ALSO needs R6 —
                                             see §4 Web row)

[🔁 Refresh]  [📈 Business Glance]        ← added, not in sketch
[🏠 Back to menu]
```

Drill-downs get `[◀ Daily Details] [💸 Office Expense]` — the second chip is
added, not in the sketch.

Why this and not three tiles in a hub: the owner asked for one glance, the
figures are three lines each, and every existing daily surface (Business
Glance, morning digest, 🌇 admin expense report) is one message. Why
on-demand first and push second: a tile ships with zero scheduler risk and
the same renderer could be reused by a push later (session-free chips) once
the numbers are trusted — the push itself is a proposed refinement (§7, R10),
not part of what was asked. Why Outstanding is off the bot card in v1: it is
the one block that needs a rule change, a customer→city rule, and an
uncached full-ledger read; parking it costs nothing and the ruling can pull it
onto the card later (the service in §6 computes it either way). The
§15b-conformant alternative is stated plainly in R6: leave Outstanding to the
finance-portal data source altogether and keep the bot card to Sales +
Expenses.

---

## 3 · What each number means — exact definitions the code can compute today

All per city per Lagos business day. The card resolves `day` ONCE
(`todayInLagos()`, `utils/dates`, TIME-1) and passes it explicitly to every
block — `getExpenseDayReport` / `getAllBranchesDayReport` default `date` to
`branchOpsService`'s own `todayInTz()` (:68, :524, :580), a different helper
that happens to agree today; the card never relies on either default. "City"
= `Locations.location` of the place, via `locationService.locationOf`
(`src/services/locationService.js:85-90`); unregistered → `Unassigned`.

| # | Figure | Source the code can compute today | Included | Excluded / caveat | Unit |
|---|---|---|---|---|---|
| 1a | **Cash collected** (first Sales number) | Σ `Transactions.AmountPaid` over rows with `salesDate == day` and a sale action (`transactionsRepository.getBySalesDateRange`, `parseRow` r[16] :114; sale filter as `businessGlanceFlow.sectionSalesToday` :46-55). City: `Transactions.Warehouse` (col K, r[10] :108) is BLANK on every approved sale — the three executors omit it (`inventoryService.js:427-439, 455-462, 1558-1565`) — so city comes from `saleRefId → ApprovalQueue.actionJSON → locationService.placesInAction → locationOf` until step 3 of the build plan stamps it. That join costs one full uncached `ApprovalQueue` read per render (`approvalQueueRepository.getResolved` reads `A2:H`, :121-129). | Cash/bank typed by the approving admin at enrichment ("Amount paid"), `sell_than`, `sell_package`, `sale_bundle`. | **Sale-time cash is posted twice over**: once as `Transactions.AmountPaid`, and again as a `PAY-<ts>` Cash/Bank debit + Receivable credit pair in `Ledger_Entries` — every executor with `amountPaid > 0` calls `crmService.recordPayment` (`inventoryService.js:443-448, 466-471, 1576-1581`), which mints `PAY-${Date.now()}` (`crmService.js:51`, NOT the `saleRefId`), posts the pair dated the POSTING day (`accountingService.recordPaymentReceived` :62-78, `todayInLagos()`), and decrements `Customers.outstanding_balance` (:53-54). A standalone typed `record payment` (`inventoryService.js:704-707`) goes through the SAME `crmService.recordPayment` — same txnId shape, same "Payment received from …" narration, no warehouse, no sale link. So the ledger cannot tell sale-time cash from a standalone payment, and Σ ledger Cash/Bank debits is NOT additive to 1a. An "Other payments" line is computable only as (Σ ledger Cash/Bank debits posted `day`) − (Σ `AmountPaid` on sales POSTED `day` — the row timestamp, not a backdated `salesDate`), and only approximately (a sale posted at 23:59 whose PAY- pair lands after midnight breaks the pairing). **v1 drops the line**; R2 chooses between "sale-time cash only" and that approximation. Pre-TRF-INT4 pending `sell_than`/`sell_package` rows carry no `warehouse` in actionJSON (`inventoryService.js:174` stamps it; :420-422 comment), so historical days can bucket under `Unassigned` even after the join. A `sale_bundle` can span warehouses (each item sells in its own `siWh`, :1497-1515) yet writes ONE Transactions row with one `AmountPaid` (:1558-1565): a mixed bundle's cash goes to the `unplaced` remainder line unless R2 says split pro-rata by yards. | Naira; face shows bare number (R1) |
| 1b | **From goods supplied** (second Sales number) | Two computable readings, and they differ. **(i) Frozen, per sale row**: Σ `qty × pricePerYard` over Transactions sale rows with `salesDate == day` — `Transactions.PricePerYard` (col P, r[15] :113) is written once at approval and never rewritten; this is exactly `salesBrowserFlow.groupSales` :86. Limitation: a `sale_bundle` row holds only the FIRST design's rate (`firstPrice`, `inventoryService.js:1557`), so a multi-design bundle is mis-valued at row level (the ledger `recordSale` per design, :1567-1575, holds the true split). City via the same join as 1a. **(ii) Current state, per than**: Σ `yards × pricePerYard` over `Inventory` rows with `status == sold` and `soldDate == day`, grouped by `Inventory.warehouse` (parse :93-104; same maths as `queryEngine.soldReport` :233). Inventory rows DO carry the warehouse, so no join — but the value is at the bale's **CURRENT** rate: `inventoryRepository.updatePrice({ packageNo, warehouse })` (:671-690) rewrites column J on EVERY row of that bale, sold rows included, so when another than of the same bale is approved later at a different rate, yesterday's 1b silently changes. **Recommended: the SLG-1 way** — Inventory sold rows for `day` ∪ `BaleMovements` `sale` rows dated `day` whose than is no longer sold (the supply that a later return erased from Inventory), deduped per (day, bale), exactly as `supplyLedgerService.js:102-118` already does for the customer goods ledger — with the rate taken from the Transactions row (i) so the figure is history, not current state. | Every than/bale sold that day, at the rate booked at approval. | A sale approved with rate 0 counts as 0 (the ledger skips it too, `recordSale` :23-24). A than returned later must NOT drop out of that day's figure — reading Inventory alone repeats the defect the SLG-1 adversarial review fixed on 07-Aug-2026 (BUSINESS_RULES §12: debits from sold rows, credits ONLY from approved-return transitions in BaleMovements), and the daily card would then disagree with the customer's SLG-1 goods ledger for the same day. (The SLED-1 Supply Statement is "net as of today" by ruling — `supplyStatementService.js:14-15` — so it is the one surface that agrees with a current-state reading; the card follows the ledger, not the handover statement.) `inventoryRepository.getSoldRows` (:181-183) silently drops sold rows lacking `soldTo` or `soldDate`; the card reads `getAll` and counts such rows in the `unplaced` remainder with a `⚠️ N sold rows without date` note rather than zeroing them (CARD-4a: never silently zero). Supply requests carry NO price (`linkedSupplyService.js:60-77`) and never touch Inventory (`inventoryService.js:1582-1583` "Intimation only"; `approvalEvents.js:2418-2424` completes the request with no sold flip); SLED-1 prints the money columns as blank ruled lines by owner decision (`supplyStatementService.js:4-10`) and SLG-1 leaves them EMPTY (§12). Ruling R3. | Naira; bare on the face |
| 2 | **Expenses** per city + **House** | Office cash book: `branchOpsService.getExpenseDayReport({ branch, date })` (:523-529, `date` always passed) → `spent` on the chip, `formatBranchReport(rep)` behind it (`eveningExpenseReport.js:70-102`, header "Office expenses" :71, ISO date, pending note :98 — thin wrapper for heading + `fmtDate`, build step 2). Branch → city: the `BranchOpsLog.branch` string is `Users.branch` (col D) or, when blank, `warehouses[0]` → `manages[0]` → `'HQ'` (`resolveBranch` :83-99); the card matches it to a Locations `location` case-insensitively, else `locationOf(branch)`, else `Unassigned`. Branch list from `activeExpenseBranches()` (:560-572, last 30 days) — ruling R5. **PAY-1 payments** (`PaymentRequests`, marked Done that day by the finance hand) are a second money-out path with no city column; attributable via the requester's `Users.branch` — ruling R13 decides whether they belong on the chip at all. | Cash book: `expense` + `person_allowance` + `commission`, non-rejected; pending rows COUNT as spent (owner rule in EXP-1, `branchOpsService.js:183-186`) — the chip shows `⏳` when any are pending (R14). PAY-1 rows: only if R13 says so. | **`House` does not exist anywhere** in the cash book (kinds: `expense`, `person_allowance`, `commission`, `cash_in`, `zero_day` — `EXPENSE_OUTFLOW_KINDS` :186, `EXPENSE_RECORD_KINDS` :558). "House" DOES exist as an attendance PLACE beside "Lagos Office" and "Kano Office" (`attendanceService.js:47` LOCATIONS seed) — the owner's own vocabulary. Making House a BRANCH (`Users.branch = House`) is not "zero code": `Users.branch` is settable only from the Add-Employee chips fed by Settings `BRANCH_LIST` (`userAddFlow.js:389-413` → `branchService.getBranches` :35-39), so House must be added to `BRANCH_LIST` (which also changes the warehouse-filter step for every future employee); and `resolveBranch` drives every EXP-1 surface, so a House branch gets its own nightly 🌇 card to all admins (`eveningExpenseReport.js` sends one per `activeExpenseBranches()`), a nothing-filed reminder to its filer, an Open Branch expectation, and a running float that must be seeded. The alternative the sketch may actually mean: House = an expense CATEGORY (title keyword / `person_allowance` target) inside a city's cash book, shown as a third chip that sums those rows. Ruling R4. | Naira, ₦ shown on chip and drill-down |
| 3 | **Outstanding** per city | Nothing per city. Per customer only, and from TWO ledgers that can disagree: **(a) `Ledger_Entries`** — `accountingService.getCustomerLedger(name).outstandingAsOfToday` (:136-201); business-wide in one call `getLedgerBalance('1100').balance` (:80-85, no caller today). This is what the sale/payment executors write (`recordSale` / `recordPaymentReceived`). **(b) `LedgerTransactions` + `LedgerBalanceCache`** — `ledgerTransactionsRepository` → `ledgerService` / `transactionService` → `balanceService.getCustomerBalance`, read by the typed `/ledger` `/balance` `/payment` `/addledgercustomer` commands (`telegramController.js:4362-4389` → `ledgerCommands.js`). Whichever the card picks, "Outstanding Kano 241" may disagree with what `/balance` shows the same admin — R15 names the authoritative one (recommended: (a), the executor-written ledger). Ledger rows carry no warehouse (`ledgerRepository.js:11-25`), Customers carry no city (`customersRepository.js:13-30`). Two computable rules with no schema change — **last-supplied**: read `Ledger_Entries` once, bucket by `customer_id`, attribute each customer's WHOLE balance to the city of the warehouse that LAST supplied them (Inventory sold rows, `soldTo` + `soldDate` + `warehouse`) — a heuristic (§12: no guessing on customers): a customer supplied from both Kano and Lagos has their entire balance jump between cities on every new sale, so "Outstanding Kano" can move with no payment and no Kano sale; **per-sale**: outstanding on the CITY's sales — per Transactions sale row, unpaid = `qty × pricePerYard − AmountPaid − later payments`; no customer→city guess, but payments are not linked to sales (`PAY-<ts>`, above), so "later payments" can only be apportioned FIFO per customer. R7. | — | Blocked by §15b until ruled, on the bot card AND on `/daily` (§4 Web row). `Customers.outstanding_balance` (col G) must NOT be used: it is only decremented on payment, floored at 0 (`crmService.js:53-54`); `addToOutstanding` (:58-63) would raise it but has no caller (`grep -rn addToOutstanding src/` → only its definition and a comment at `customersRepository.js:81`), so no sale path raises col G. Ledger reads are uncached full-sheet reads (`ledgerRepository.getAll` A2:K) — one read per render, never per customer. Ruling R6 + R7 + R15. | Naira; bare on the face |

**Where the sketch's numbers are ambiguous — named plainly.**

- `Kano 50 / 245`: a `/` pair everywhere else in the bot is done-of-total
  (attendance `marked/total`, §16 `doneB / totalB`); here it is two
  independent totals. The sketch draws no unit and its figures are
  placeholders; the face follows the sketch (raw naira, no unit line) unless
  R1 opts into thousands — in which case the header must say so once.
- "From goods supplied" is not a fork in this business's vocabulary:
  BUSINESS_RULES §12 says *"the Inventory sheet is the record of what they
  were SUPPLIED (sold rows: soldTo + soldDate per than)"*, the SLG-1 supply
  ledger and the SLED-1 Supply Statement (`supplyStatementService.js:48-56`,
  `status === 'sold'` rows) both read sold rows as "supplies", and a supply
  request's dispatch never touches Inventory. So 1b = value of the day's
  supplied (sold) rows is the house meaning. The only real question is whether
  goods dispatched under a supply request but not yet booked as a sale should
  appear as a quantity-only line (no money exists for them). R3.
- "Total cash collected" can mean cash at sale time (has a city) or all money
  that came in that day including payments against old debts (has no city,
  and — see 1a — cannot be separated from sale-time cash in the ledger). R2.
- "Outstanding Kano 241" can be naira owed by Kano-supplied customers, the
  unpaid remainder of Kano's own sales, or a count of customers owing; no
  card counts customers-with-balance, so one of the first two is assumed.
  R6/R7.
- Day boundary: sales carry a TAPPED `salesDate` that may be backdated (§9b);
  ledger rows carry the POSTING day (`recordSale` / `recordPaymentReceived`
  stamp `todayInLagos()` at write). Recommendation: business day =
  `salesDate` / `soldDate` for blocks 1a-1b, `BranchOpsLog.date` for 2,
  posting day only for any ledger-derived line R2 admits. R8.

---

## 4 · Navigation

| Item | Proposal |
|---|---|
| Tile | `daily_details` · label **📆 View Daily Details** (verb-first per audit W-1; the neighbours "Business Glance" / "Sales Browser" are still noun-first until Wave 2 lands — R9 may pick "Daily Details" for consistency) |
| Hub | `hub: null` — top level beside 🛂 Approvals and 📈 Business Glance (`activityRegistry.js:179,182`), because it is a first-open admin screen, not a branch-manager routine; the 🌅 Daily hub (`:35`, tiles `:300-302`) is the manager's Open Branch / Office Expense door and is gated by `Departments.allowed_activities`. Not listed in any department CSV; gated in the flow's `start()` like Business Glance. |
| Callback prefix | **`dly:`** — verified free (`grep -rn "'dly:" src/` = 0; also `ddc:` and `dtl:` free; `dcd:` free but collides visually with the live `dcat:`). Add to the CLAUDE.md registry when wired. |
| Chips | `dly:e:<i>` expense drill for city *i* · `dly:sum` back to the card (both in 2a). 2b adds `dly:refresh` · `dly:s` today's sales — opens the Sales Browser at its day picker today (`salesBrowserFlow.start(bot, chatId, userId, messageId)` takes no day, :164-170; the pure `_internals.salesForDay(dayIso)` :95 is not a UI entry), so landing on the card's day needs a small `start({ day })` extension, part of build step 2 · `dly:o:<i>` outstanding drill (only once R6 allows). City index *i* = position in the card's own city order (Locations `listLocations()` order, `Unassigned` last, `House` after the cities) so every payload stays far under 64 bytes; the handler recomputes from the key alone (session-free, the MORN-1b pattern `morningDigestFlow.js:66-116`) so the same chips would work on a pushed copy after any session expiry. |
| Renderer | `flowKit.makeRenderer` on `session.flowMessageId` for the tile path; `bot.editMessageText` on `callbackQuery.message.message_id` for a pushed path — identical text builder. |
| Footer | 2a: `[🏠 Back to menu]` only (`menuNav.backToMenuRow`, `act:__back__` is session-free). 2b adds `[🔁 Refresh]` and `[📈 Business Glance]`. Drill-downs: `[◀ Daily Details]`; 2b adds `[💸 Office Expense]`. |
| Controller wiring | one registry entry, one `act:daily_details` case, one prefix-dispatch line (`{ prefixes: ['dly:'], handle: … }` beside `bgl:` at `telegramController.js:7563`) — a surgical controller edit, owner go required (CLAUDE.md scope rule 2). |
| Who may see it | Admins (`auth.isAdmin`) + **the PAY-1 finance hand** — the single active member of the Finance DEPARTMENT in the Users sheet, resolved by `paymentService.financeHead()` (:56), the owner-maintained definition locked in BUSINESS_RULES §13 and the one the pending-tasks table tells the owner to set. NOT `config.access.financeIds` (FIN-V1, env `FINANCE_IDS`): that is the legacy gate on typed `check_balance` (`telegramController.js:4789-4796`) and silently collapses to ALL admins when unset (`config/index.js:277-278`). Two "Finance" definitions now coexist — flagged for a cleanup ruling (R12). Never managers (they see their own branch in 🌅 Open Branch), never linked marketers/customers (§16: no warehouse fact, no price). |
| Push (proposed refinement, not asked for) | `DAILY_CARD_TIME` in `DIGEST_TIMEZONE`, same minute-tick + catch-up discipline as `eveningExpenseReport.tick` (:169-201); one message per recipient; registered in `server.js` beside the two existing daily schedulers (:611-616). Audience: the 🌇 report today goes to `config.access.adminIds` only (`eveningExpenseReport.js:158`), so sending the card to admins + the finance hand is a widening — R12. Whether it sits beside or replaces the 🌇 admin expense report is R10, undecided. |
| Web (proposed refinement, not asked for) | `/daily` as a fifth `SESSION_PAGES` entry (`server.js:168-173`) + a fourth button on the 📊 Dashboard card (`web_dashboard` case `telegramController.js:10369-10426`), fed by one new read endpoint on the §6 service. Suits ranges (week/month) which do not belong on a Telegram card. **It is NOT automatically the home for Outstanding under §15b**: §15b says the website receivables view is *"fed from another data source, meeting the bot's data at a point on the site"* and extends the SLG-1 Option B lock; `bucketOutstandingByCity` computed in the bot and rendered on a bot-served page is still a bot-side customer-money report, so it needs R6 exactly as the card does. |

---

## 5 · Settings knobs (Settings sheet; defaults in `settingsRepository.DEFAULTS`) — all proposed, none decided

| Key | Default | Meaning |
|---|---|---|
| `DAILY_CARD_UNIT` | `naira` | Face numbers on Sales/Outstanding rows: `naira` (raw integers, en-NG grouping, no unit line — as drawn) or `thousands` (÷1000, rounded, header line "₦ thousands"; a refinement — note a ₦400 day then rounds to `0`, so the knob also switches on a `<1` marker). Drill-downs always print full ₦. R1. |
| `DAILY_CARD_CASH_SOURCE` | `sale` | `sale` = Σ `AmountPaid` on the day's sale rows (has a city). `ledger` = Σ Cash/Bank debits POSTED that day (no city — rendered as ONE business-wide "All money in (ledger)" line that REPLACES the per-city first number, never sits beside it): it counts every payment posted, sale-time cash included (§3 row 1a), so the two values are alternative readings, not addends. No "Other payments" line in v1. R2. |
| `DAILY_CARD_CITIES` | `` (empty) | Optional CSV to fix the row order / restrict rows (`Kano,Lagos`). Empty = every Locations `location` that has any figure, alphabetical, `Unassigned` last, `House` after the cities. |
| `DAILY_CARD_OUTSTANDING` | `0` | `1` renders block (3) in the bot. Stays 0 until R6; the web page honours it too (§4 Web row). |
| `DAILY_CARD_PUSH_ENABLED` / `DAILY_CARD_TIME` | `0` / `20:00` | Only if R10 says build a push: scheduled copy at HH:MM `DIGEST_TIMEZONE`; catch-up window reuses `EXPENSE_REPORT_CATCHUP_MINUTES`. The 🌇 per-branch cards (`EXPENSE_REPORT_ENABLED`) are untouched by this spec; if the owner later prefers one evening message, that is his separate switch. |

No per-city expense knobs: the branch list is data (`Users.branch`), not config.

---

## 6 · Foundation — the shared per-city per-day figures service

`src/services/dailyFiguresService.js` — read-time only (rule 5b / §10): no new
sheet, no new column, nothing persisted, no city guessed (§6e; the
`/kano/i` fallback in `warehouseAuditFlow.locationOf` :126-134 is NOT copied —
it predates LOC-1; retiring it is a separate ruling, R11b).

```
getDayFigures({ day, includeOutstanding = false })      // day passed explicitly by every caller
→ { day,
    cities: [ { city, label,
                sales:    { cashCollected, goodsValue, saleCount, yards },
                expenses: { spent, balance, pendingCount, filed, report },   // report = getExpenseDayReport shape
                outstanding: number | null } ],
    unplaced: { cashCollectedNoCity, goodsValueNoCity, soldRowsWithoutDate,
                mixedBundleCash },                                            // honest remainder lines
    totals:   { cashCollected, goodsValue, spent, outstanding|null } }
```

Reads, once each per call: `Inventory` (`inventoryRepository.getAll`, cached
`_allCache`) → sold rows for `day` (own filter, not `getSoldRows`, so dateless
sold rows are counted in `unplaced`); `BaleMovements`
(`baleMovementsRepository.getAll`) → `sale` rows dated `day` whose than is no
longer sold, the SLG-1 union (`supplyLedgerService.js:102-118` is the reused
shape); `Transactions` (`getBySalesDateRange(day, day)`) → `AmountPaid` and
`PricePerYard` per sale row; `ApprovalQueue` resolved rows (`getResolved`,
full `A2:H` read) only while sale rows lack a warehouse (dropped after build
step 3); `BranchOpsLog` (`branchOpsLogRepository.getAll`) → `buildDayReport`
per branch from ONE read (today `getExpenseDayReport` re-reads the sheet per
branch — add `getAllBranchesDayReport({ date })` to `branchOpsService`, pure
pieces already exist; `date` always passed); `PaymentRequests` only if R13
admits PAY-1 money; `Locations` (`locationService.allPlaces`, 60 s cache) →
city of every place; `Ledger_Entries` (`ledgerRepository.getAll`, uncached)
ONLY when `includeOutstanding` and only if R15 confirms it as the
authoritative ledger (the `LedgerTransactions` stack is not read).

Pure, tested roll-ups beside it: `bucketSalesByCity(soldRows, movementRows,
txRows, places)`, `bucketExpensesByCity(branchReports, places)`,
`bucketOutstandingByCity(ledgerRows, soldRows, places, rule)` (`rule` =
`last-supplied` | `per-sale`, R7), `formatFace(n, unit)`. Formatting: `fmtQty`
(bare) for the face, `fmtMoneyShort` for ₦ — both in `src/utils/format.js:53-62`;
`fmtDate` for the day; nothing new invented.

Reusers: the Telegram card (tile; push if R10), the `/api/ops/daily` endpoint
if the web page is built, and — once it is a section — the morning digest
(`CATEGORIES` in `morningDigest.js`) and the 🌇 admin expense report, so the
daily surfaces agree to the naira because they read one function.

---

## 7 · Build plan (each step shippable, smallest first)

**Asked for — the card and the foundation answer.**

0. **Owner, no code** — seed the `Locations` sheet (pending task 0c) so Kano
   office / IDUMOTA / … carry a `location`; set `Users.branch` to `Kano` or
   `Lagos` for every expense filer (blank rows land under a warehouse name or
   `HQ`). If R4 = branch: add `House` to Settings `BRANCH_LIST`, add the House
   filer with `Users.branch = House`, seed that float with one ➕ Cash
   received, and accept the nightly House 🌇 card + reminder that follow
   (§3 row 2). If R4 = category: nothing to seed.
1. **Foundation, dark** — `dailyFiguresService` + `branchOpsService.
   getAllBranchesDayReport` + pure unit tests + smoke check (fixtures
   day-aware). No UI, no controller edit, no visible change.
2. **Tile** — `src/flows/dailyDetailsFlow.js` (`SESSION_TYPE`
   `daily_details_flow`, prefix `dly:`), blocks (1)+(2), expense drill-downs
   through a thin wrapper over `formatBranchReport` (heading "Expenses — …",
   `fmtDate` day, `⏳` chip mark); registry entry + `act:` case + dispatch
   line (owner go for the controller); characterization test via
   `controllerHarness`. CLAUDE.md registry updated. If 2b: also the
   `salesBrowserFlow.start({ day })` extension for `[📈 Today's sales]`
   (small, its own commit).

**Refinements the agent proposes — each needs its own go (CLAUDE.md: one task
= one commit; executor / controller edits need explicit instruction).**

3. **Stamp the warehouse on approved sale rows** (R11a) — three one-line
   additions (`warehouse: aj.warehouse` on `sell_than` / `sell_package`; on
   `sale_bundle` the single `siWh` when all items share one, else `mixed`) in
   `inventoryService.executeApprovedAction`. Column K already exists;
   Transactions rows then carry their place and the ApprovalQueue join
   disappears. Approval-executor edit.
4. **Push** (R10) — `DAILY_CARD_PUSH_ENABLED` / `DAILY_CARD_TIME` scheduler
   reusing the tick/catch-up code shape; session-free chips already work.
   Beside the 🌇 admin expense report, not replacing it, unless the owner says
   otherwise after comparing one evening side by side.
5. **Outstanding** (R6/R7/R15) — `bucketOutstandingByCity`, the
   `DAILY_CARD_OUTSTANDING` knob, and §15b amended in the same change
   (BUSINESS_RULES.md, one paragraph naming this card as the ruling). Applies
   to the bot card and to `/daily` alike.
6. **Web `/daily`** — `SESSION_PAGES` entry, `/api/ops/daily` read endpoint
   on the same service, LNK-1 button; carries ranges. Outstanding on it only
   under step 5's ruling.

Nothing in steps 1–2 touches approval semantics, `evaluate.js`, or a sheet
column; step 3 is the only executor edit; step 5 is the only rule change.

---

## 8 · Open rulings for the owner (one line each, with the recommended answer)

| # | Question | Recommended |
|---|---|---|
| R1 | Face numbers: raw naira as drawn (no unit anywhere), or ₦ thousands with a one-line header note (refinement)? And is `₦5,512` (symbol first, house style) acceptable on the expense chips instead of the sketch's `5512₦`? | Raw naira, as drawn; ₦ first on chips. |
| R2 | "Total cash collected" = cash entered at sale approval (per city, `Transactions.AmountPaid`), or every Cash/Bank debit posted that day (ledger, no city, and it CONTAINS the sale-time cash again — §3 row 1a)? If standalone payments matter on this card, accept the posting-day subtraction as an approximation, or wait for the `record payment` door to carry a city? A mixed-warehouse bundle's cash: `unplaced` line, or split pro-rata by yards? | Sale-time cash per city; no "Other payments" line in v1; mixed bundles to `unplaced`. |
| R3 | "From goods supplied" = value of the day's supplied (sold) rows — the house meaning (§12) — at the rate booked at approval (Transactions.PricePerYard), history-preserving the SLG-1 way (a later return does not erase the day). Should goods dispatched under a supply request but not yet booked as a sale appear as a quantity-only line? | Yes to the definition; no supply-request line in v1 (no money exists for it; SLED-1/SLG-1 print none). |
| R4 | What is **House**: a branch (`Users.branch = House` — needs `House` in `BRANCH_LIST`, gets its own nightly 🌇 card, reminder, Open Branch expectation and float), or a category inside a city's cash book (title keyword / `person_allowance` target, summed into a third chip, no new branch)? "House" is already an attendance place in the owner's vocabulary. | Owner's call with those consequences visible; category is the smaller change. |
| R5 | City rows from the derived branch list (anything filed in 30 days) or from Settings `BRANCH_LIST`? A silent branch drops off the derived list. | Derived list ∪ Locations cities, so a silent city still shows `0`. |
| R6 | §15b: does this sketch supersede it for ONE aggregate outstanding-per-city figure — on the bot card, on a bot-computed `/daily` web page (still bot-side under §15b's wording), or neither (Outstanding stays with the finance-portal data source and the card is Sales + Expenses)? | Neither in v1; amend §15b only if you want it on the card or the page. |
| R7 | If Outstanding is shown anywhere: a customer's WHOLE balance to the city that LAST supplied them (derived; the balance jumps cities on every cross-city sale), the unpaid remainder of each CITY's own sales (per Transactions row; payments apportioned FIFO because they are not linked to sales), or a new `location` column appended to Customers? | Per-sale attribution if the card is about the city's day; last-supplied only if it is about the customer book — owner picks the meaning. |
| R8 | Day boundary: tapped `salesDate` / `soldDate` (business day, may be backdated) for sales, posting day for any ledger-derived line? | Yes — business day for sales and expenses, posting day only for ledger lines. |
| R9 | Tile: top level beside Business Glance labelled **📆 View Daily Details**, or inside 💰 Finance / 🌅 Daily; and verb-first or noun-first? | Top level, verb-first. |
| R10 | (Refinement) After the tile: build a 20:00 push of the card at all? If so, beside the 🌇 admin expense cards or replacing them? | Tile first; decide the push after a week of tapping the tile. |
| R11a | (Refinement) May the three sale executors stamp `warehouse` onto the Transactions row (column K exists, blank today)? | Yes — removes the ApprovalQueue join. |
| R11b | (Refinement, unrelated flow) May `warehouseAuditFlow`'s `LOCATION.<warehouse>` + `/kano/i` heuristic (:126-134) be retired in favour of LOC-1? | Later, its own task. |
| R12 | Audience: admins + the PAY-1 finance hand (Users.department = Finance, `paymentService.financeHead`)? That is wider than the 🌇 report (admins only). And should FIN-V1's env `FINANCE_IDS` gate on `check_balance` be folded into the same department definition (cleanup)? | Admins + finance hand; yes, fold FIN-V1 later. |
| R13 | Does the Expenses chip include PAY-1 payments marked Done that day (attributed by the requester's `Users.branch`), or only the office cash book? The owner crossed out "Office". | Cash book only in v1, with a `+ ₦N paid out (PAY-1)` line below the chips if you want both visible. |
| R14 | Chip whose `spent` includes pending (rejectable) rows: `⏳` mark on the chip, or bare number with the note only behind the tap? | `⏳` on the chip (annotate, never hide). |
| R15 | Which customer-money ledger is authoritative for this card: `Ledger_Entries` (executor-written) or `LedgerTransactions` (typed `/balance`)? The two can disagree today. | `Ledger_Entries`; note the typed `/balance` door reads the other. |
