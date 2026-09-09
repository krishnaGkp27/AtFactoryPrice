# CUR-1 — Currency display: releases A and B SHIPPED 09-Sep-2026 (build steps 1–9)

> **Status (09-Sep-2026).** Rulings R1–R18 and doubts D1–D6 closed by the
> owner "as recommended" (08-Sep); the 09-Sep integrity amendment
> (`docs/BUSINESS_RULES.md` §17) added that the sheet holds BASE figures
> only and the multiplier is stored separately. **Release A — build steps
> 1–5 of §8 — is shipped**, together with the CUR-2 multiplier on the
> Settings-fulfilled path. **Release B — steps 6, 7 and 9 (the wizard's
> Step 5 in `approvalEvents.js`, the `telegramController.js` sweep, deleting
> the `format.js` shims, S-CUR in fail mode) — waits for the owner's live
> check below and his go.** What release A ships and how to check it live:
> §11. One correction to the plan text below, kept as written for the
> record: there is NO label variable (`SALE_UNIT_LABEL` / `saleUnit()` /
> "a unit printed once" — R14) — that reading was superseded by the
> multiplier ruling (R2b, R12b). `money.saleHeader(word)` returns the bare
> word and `money.saleLegend()` returns `''`; they are kept only as the one
> seam a label could ever come back through.

Owner, 08-Sep-2026 (recorded as `docs/BUSINESS_RULES.md` §17): *"keep the
expenses in naira, with the symbol of naira intact at all the places. But
whatever invoices we are generating through our sale, or any updation in sheet
which changes our inventory sheet, must be without the currency symbol or
unit. Hence, this will be upon management to decide what value will fit in (I
think we have a Railway variable)."*

This document is the cumulative plan the §17 entry says is pending. It is
built on a verified site table (≈380 rows, ≈330 unique `file:line` anchors,
every one re-read against the working tree at commit `d41d4e0a`). Nothing in
the code has changed. Companion documents: `specs/INV-2_INVOICE_DESIGN_PROMPT.md`
(the invoice redesign in flight — it carries the one hard conflict),
`docs/CUSTOMER_PAYMENT_DOOR_2026-09-08.md` §7 (groundwork table; its Q13 is
answered here as rulings R5–R7), `docs/BUSINESS_RULES.md` §6b, §12 (SLG-1
Option B), §13 (PAY-1), §15b, §17.

---

> **Release B shipped 09-Sep-2026 (steps 6, 7, 9):** `approvalEvents.js`
> chips / acks / Outstanding lines bare; the controller's 60 money sites on
> `money.sale` / `money.saleRate` (`test/characterization/controllerMoney.cur1.test.js`);
> the daybook and trial balance kept on `fmtMoney` (R5a); `fmtMoneyShort`,
> `currencySymbol`, `DEFAULT_CURRENCY` deleted from `format.js`; S-CUR in
> **fail** mode. Still open: the §17 closing sentence awaiting the owner's
> verbatim yes; three input prompts still say `(NGN)` by R18.

## 1 · Verdict

**Three sides, one lever, one real risk.**

| Side | Meaning | Unique sites | Of which need an edit |
|---|---|---|---|
| **A — expenses** | keep `₦` everywhere | ≈95 (≈80 in `src`, the rest fixtures and docs) | **0 to comply**; ≈25 optional swaps to the shared expense helper so the lint can prove the side is inert |
| **B — sale invoices + Inventory-changing outputs** | bare number; no unit by default — a unit is printed once, from the env, only when management sets one (R12b) | ≈210 (≈190 in `src`) | ≈130 — the other ≈60 are already bare (sheet writes, sale cards, SLG-1 pages) or verified money-free |
| **C — undecided in §17** | customer statement, payment card, return credit, ledger narrations, balance replies, DDC-1, landed cost, catalogue prices, task incentives | ≈75 | all of them, once ruled; this plan recommends **B for every C family except task incentives (→ A), ledger narrations (keep the stored code) and trial balance / daybook (keep as today, R5a)** |

**The mechanism that makes this a config decision rather than 330 edits.**
Side A never touches the env: `officeExpenseFlow`, `dailyBranchOpsFlow`,
`branchOpsService`, `eveningExpenseReport`, `paymentService`, `paymentFlow`,
`paymentCards` reference neither `config.currency`, `CURRENCY`, `fmtMoney`
nor `fmtMoneyShort` (grep-verified); their `fmtNgn` helpers wrap the
locale-only `fmtQty` and add `₦` inline. Side B, by contrast, reaches the env
through exactly one door — `src/utils/format.js:19` `DEFAULT_CURRENCY =
config.currency` — plus a handful of private copies (`invoiceService.js:32`
`NGN = '₦'`, `invoiceWebController.js:38`, `inventoryService.js:47`,
`salesBrowserFlow.js:63`, `soldBalesFlow.js:67`, `supplyDetailsDesignFlow.js:121`,
three closures in `approvalEvents.js:753/920/1974`). Because the two sides
already use disjoint helpers, the shared formatter can be **re-defined as the
sales-side formatter with zero expense fallout**, and the private copies fold
into it. The build is a helper module, a lint, and a mechanical sweep — not a
redesign.

**The biggest risk** is not code; it is a document. The invoice redesign brief
in flight (`specs/INV-2_INVOICE_DESIGN_PROMPT.md:49-50`) restates INV-1's
locked rule 3 — *"all money is ₦ per yard"* — and tells the designer to bake
`₦` into every cell. If the design is finalised before that line is amended,
the delivered layout violates §17 on the one surface the owner named
explicitly. Second risk, in code: **old invoices relabel themselves.**
`lines_json` and totals are frozen bare numbers
(`src/repositories/invoicesRepository.js:51-53`); the label is added at read
time, so a change to the env re-labels every past invoice at `/i/<token>` and
on re-download (ruling R3).

---

## 2 · The rule as a decision table

The test for a surface is not *where the money comes from* but *what the
document is*. Side A = money leaving the office (cash book, payouts, payment
requests). Side B = a sale document, or the printed result of an approval that
writes the Inventory sheet (rates, stock values, credits at a booked rate).
Side C are the surfaces §17 left open; each carries the recommended side and
one line of reasoning.

### Side A — keep `₦`, always, regardless of the env

| Surface | Anchors | Why A |
|---|---|---|
| EXP-1 office cash book: filing wizard, chips, review card, admin approval card, submitted/undo replies | `src/flows/officeExpenseFlow.js:140-621` (17 inline `₦`), executor reply `src/services/inventoryService.js:1207` | The owner's words: expenses in naira, symbol intact |
| 🌅 Open Branch daily card and status panel | `src/flows/dailyBranchOpsFlow.js:167-323` | Cash float and the day's expenses |
| 20:00 finance report | `src/services/eveningExpenseReport.js:61-97` | Expense report |
| Cash-book validation errors | `src/services/branchOpsService.js:117,214,429` | Expense side; today inconsistent (two bare, one `₦`) — align to `₦` |
| PAY-1 payment requests: request card, finance card, approval summary, paid/declined DMs, executor reply | `src/services/paymentService.js:37` `fmtNaira`; `src/flows/paymentFlow.js:347-505`; `src/services/paymentCards.js:36,65`; `inventoryService.js:1623` | Money leaving the business (§13) |
| Task incentives (amount prompts, task cards, payout queue, paid DMs, gantt marker) | `src/flows/taskFlow.js:70,1018,1146,1301-1309,1358,1621,2167,2305,2318,2544,2548,2774,3145-3290`; `web/gantt.html:235` | A payout to a person — the same class as an allowance. **Today the only expense surface whose symbol is DERIVED from the env** (`fmtMoneyShort` aliased at `taskFlow.js:51`) and the only one that PERSISTS `config.currency` (`taskFlow.js:1329`, `incentivesRepository.js:36,66`). Must be pinned |
| Identifiers that carry the unit in their NAME | `PAYMENT_THRESHOLD_NGN` (`settingsRepository.js:26`), `PaymentRequests.amount_ngn` (`paymentFlow.js:365`), `GoodsReceipts.lc_ngn_per_yard` (`schemaMapper.js:266`) | Locked names (scope rule 4); never renamed |
| Data fields holding a currency code | banking `mono.js:76`, `stub.js:21,32,43`; forex `stub.js:12-13`; `costRegistry.js:33` | Codes, not display |

### Side B — bare number, thousands grouping; a unit printed ONCE from the env only when management sets one

| Surface | Anchors | Why B |
|---|---|---|
| Customer sale invoice — PDF, web copy, Telegram caption | `src/services/invoiceService.js:32,230-233,242-243,260,289,306`; `src/controllers/invoiceWebController.js:38,67,68,75,122,126,127,130` | Named by the owner |
| Sale approval wizard: buyer chips with last rate, rate chip, rate/amount prompts, acks, "Paid in full" chip | `src/events/approvalEvents.js:359,627,654,695,699,838,876,882,960,1016` | The rate written to `Inventory.pricePerYard` and `Transactions` |
| Price update: wizard card, typed replies, submitted card, admin summary | `telegramController.js:2242,2288-2289,4646,4660,4662,8560,8566`; generic card `approvalCards.js:836` (the `Price`/`Amount` pair, printed raw by the `:844-846` loop — already bare) | An update that changes the Inventory sheet |
| Edit Bale, Check Stock, bale card, Stock Value, container values, allocation total, supply reports, rankings, purchase pattern, customer 360 values | `telegramController.js:297,331,335,345,571,632-684,698,1301-1322,1438-1464,1547-1561,3066,3178-3242,4554,6064-6065,6187-6188,6432`; `supplyDetailsReport.js:133-301`; `supplyDetailsDesignFlow.js:121,133`; `soldBalesFlow.js:67,508,516`; `salesBrowserFlow.js:63,270,282,303,458`; `warehouseAuditFlow.js:1169` | Inventory rate × yards, read from the sheet. Rates and stock values are §17's words; the sales-history analytics (rankings, purchase pattern, customer 360 sale values, sales design/customer reports, container/allocation values) are an extension of them — R17 makes it explicit |
| Reports engine (the AI data context `:281-286` is a refinement — §5) | `queryEngine.js:32,49,83,93,121,141,240`; `analytics.js:96,97,108,117` | Same values (R17) |
| Catalogue price badge (recommended B, listed C in §17) | `fieldCatalog.js:73` via `pricingService.resolveSalePrice` | It IS the Inventory selling rate |
| Landed cost — the sealed NGN rate (recommended B — a genuine call, R8); the FX pair stays hardcoded | `landedCostService.js:124,125`; `landedCostFlow.js:271,340,342,351`; `inventoryService.js:1223` | Finalisation writes `GoodsReceipts` (`goodsReceiptsRepository.js:157`; `landedCostService.js:20` Q5 — Inventory NOT touched, `:285`), and the number is read at pricing time as the base for the sale rate (`pricingService.js:82`, `rateSuggestionService.js:137`). It is ALSO what the business PAID — USD goods + freight/duty × FX — so an expense-side (A) reading is equally natural; §17 does not list it (CPD §7 `:427` does, as open). USD input lines (`landedCostService.js:114-123`, `landedCostFlow.js:231-238`) keep `$`: a foreign cost, not the home unit. The rate is fractional by construction (`landedCostService.js:90`, 4 dp) — `saleRate(n, { fraction: 2 })`, never the integer default |
| Rate suggestions | `rateSuggestionService.js:186` | Feeds the sale rate |
| Sheet writes — already compliant, no change | `inventoryService.js:300,437,460,684,809`; `invoicesRepository.js:20-53`; `inventoryMirrorService.js:33`; `ledgerRepository.js:39`; `ledgerBalanceCacheRepository.js:57`; `bundleSaleService.js:266` | Bare numbers already |
| Sale doors and cards that print no money — no change | `sellBaleFlow.js:487`, `snapSaleFlow.js:386`, `bundleSaleFlow.js:1161-1171`, `approvalCards.buildSaleCard:193`, `linkedSupplyService.js` | DSP-1 removed the seller-side value line; any future rate line is B |
| SLG-1 / SLED-1 / web pages — no change | `supplyStatementService.js:91-148`, `supplyLedgerWebController.js:137-182`, `supplyLedgerFlow.js:88`, `supplyLedgerService.js:9`, `web/movement.html:225`, `web/ops.html`, `web/allocations.html`, `/api/sl/*` (`apiController.js:618`) | Money-free by owner lock; when finance fills the columns they inherit the bare rule |

### Side C — the open families, each with the recommended side

| Family | Anchors | Recommended | One-line reasoning |
|---|---|---|---|
| **C1 Customer statement / balance replies** (typed `/ledger`, `/balance`, show_ledger, check_customer, check_balance, Customer 360 timeline payment lines) | `ledgerCommands.js:41,77,118`; `telegramController.js:724,4781,4782,4800,4870-4875` | **B** | Every figure is a sale, return or receipt posting — the receivables mirror of the invoice; it must read in the invoice's unit convention, never `₦` |
| **C1b Trial balance and daybook** | `telegramController.js:4884-4886` (daybook), `:4899-4902` (trial balance) | **Keep as today** (R5a) | Book-keeping reports over ALL accounts — cash/bank debits, receivables, revenue — neither an invoice, nor an Inventory-changing output, nor the customer statement §17 names. They straddle both sides (cash and bank movements sit on the expense side of the owner's split). Recommended: leave them on `fmtMoney` until the finance portal takes them (SLG-1 Option B / §15b) |
| **C2 Customer payment IN** — record-payment card, receipt flow prompts/echo/summary, receipt approval card and decision DMs, payment-recorded replies, branchOps pointer subject | `approvalCards.js:488,493,494`; `telegramController.js:151,178,3603,3627,3646,4831,4843,9499,9561,9569,9642,9647,9683`; `approvalEvents.js:2287` | **B** | Credits the same customer ledger the invoice feeds; changes no cash book. This is CPD §7 Q13; PAY-1's outgoing cards (`paymentCards.js`) are a different feature and stay A |
| **C3 Return credit line** — requester card, admin card, executor credit notes, backfill script | `returnFlow.js:520`; `approvalCards.js:453-454,461`; `inventoryService.js:47,495,517,647`; `scripts/list-uncredited-returns.js:31,101,104` | **B** | Reverses a sale at the booked Inventory rate and flips stock — an Inventory-changing approval's output; today it is printed THREE different ways for one number |
| **C4 Post-approval outstanding line** ("📒 … Outstanding as of today") and the wizard's Outstanding line | `approvalEvents.js:646,1119,1974` (closures `:753,:920,:1974`) | **B** | Printed as the direct output of a sale approval; §15b keeps this surface, it does not fix its format |
| **C5 Ledger narrations (persisted)** — `Sale: … \| Cash NGN 5000`, `Payment received from X: NGN 60000 via Bank` | `accountingService.js:12,32,71`; read back by `extLedgerService.js:358-372` (`_entryCustomer`) and `accountingService.js:127` `narrationNames` (caller `:169`) | **Keep the code, forward-only** | It is stored data, not display; both matchers anchor on `to <name> \|` / `Payment received from <name>:`, never on the token, so either choice is safe — keeping it avoids rewriting history semantics (no sheet mutation). **Transactions:** the sheet carries no unit column at all (`transactionsRepository.js:11` HEADERS — `PricePerYard`, `AmountPaid` are written bare) — no change, nothing to rule; §17's fourth bullet closes on that fact |
| **C6 Customer-master money** — credit limit on cards/chips, "Owes ₦…" on the removal card, add-contact card (already bare) | `approvalCards.js:305,760`; `telegramController.js:997,1893,2048,8361`; `salesWorkflowView.js:372` | **B** | A sales-side master field (gates sales); `approvalCards.js:305` already prints it bare |
| **C7 Sales workflow ledger balances** | `salesWorkflowView.js:238,257,373` | **B** | Same balance as C1 on a sales card |
| **C8 DDC-1 daily card** (proposal) | `specs/DDC-1_DAILY_DETAILS_CARD.md` R1, `:260` `DAILY_CARD_UNIT` | **Split as already drawn, one header to align** | Its own R1 ("raw naira as drawn, ₦ first on expense chips") matches §17 in `naira` mode: sales/outstanding rows bare, expense chips `₦`. Its `thousands` mode prints a "₦ thousands" header over the Sales/Outstanding rows — a `₦` on a sales surface. That header must read `<saleUnit()> thousands` (`thousands` when no label is set); the expense chips and drill-downs keep `₦` |
| **C9 Landed cost** | see side B table | **B** (sealed rate, 2 dp) / **A-neutral** (`$` inputs) / FX pair **keep hardcoded** | Written to `GoodsReceipts`, not Inventory; read at pricing time as the base for the sale rate; also the cost the business PAID — A or B is a genuine call, the owner rules (R8) |
| **C10 Catalogue prices** | `fieldCatalog.js:73` (the MG-2 group-price badge — `marketerOverlay.js:10`, `specs/marketing-group-catalog.md:187` — is not built yet and inherits B when it lands) | **B** | Inventory selling rate on a sales surface |
| **C11 Task incentives** | see side A table | **A** | A payout; and it needs pinning or the env flips its symbol |
| **C12 `/api/settings.currency`** | `apiController.js:59` | **B** (keep, add the label) | The field the website would read to label money; nothing consumes it today |

---

## 3 · Conflicts with locked rules

1. **INV-1 decision 9 (`specs/INV-1_CUSTOMER_INVOICES.md:26-27`) locks the
   column headers `Description | Cost ₦ | Payments ₦`; INV-1 §2 (`:102`)
   describes the status strip as `PART-PAID ₦x of ₦y`. §17 says the invoice
   carries no symbol.** Two ways out: (a) exempt the invoice from §17 — not
   available, the owner named "invoices we are generating through our sale"
   first; (b) amend decision 9 so the column STRUCTURE, the red payment rows
   and DEBIT BALANCE stay locked, and the header carries the env label once,
   when management has set one (`COST | PAYMENTS` by default; `COST NGN |
   PAYMENTS NGN` once a label is set — R12b).
   **Recommend (b)** with a one-line supersession note citing §17.
2. **INV-2 rule 3 (`specs/INV-2_INVOICE_DESIGN_PROMPT.md:49-50`) — *"420 yds
   @ ₦1,450/yd … all money is ₦ per yard"*, plus `:26`, `:32-35`, `:74`,
   `:86`, `:108` — is the design brief in flight.** (a) let the design land
   and strip the symbol afterwards — wastes the designer's pass and risks the
   PDF layout being re-laid from the mockup; (b) amend the brief NOW to
   *"bare number; `/yd` names the divisor; the unit appears once, in the
   column header, from the env; absent by default"*. **Recommend (b), before the
   design is finalised** (ruling R1). The mockups
   `specs/inv1-mockups/template-final-hybrid.html:33-41` (and `template-a-ledger`,
   `template-b-band`) carry the same 19 literals and `invoiceService.js:195` says the
   PDF mirrors that file; INV-1 decision 9 (`:29`) names `template-final-hybrid`
   as the owner-picked template reference, so refreshing them is part of R1,
   not an implicit go.
3. **§6b (`docs/BUSINESS_RULES.md:211-212`) — *"all money is Naira per
   yard"*.** (a) keep as written, treat "Naira" as the accounting unit only;
   (b) reword to *"all money is per yard; the unit is management's (§17)"*.
   **Recommend (b)** — the sentence is about yards being the divisor, not
   about the symbol. §6b sits under "Recorded 31-Aug-2026 at the owner's
   request" (`:190`): rewording a locked sentence is the owner's call, not a
   session's (scope rule 0 lets a session ADD a ruling, not rewrite one) —
   gated on R16, not on R1.
4. **§15b — customer money views live on the website; the bot keeps only the
   surfaces it already has (payment cards, typed statement, enrichment
   outstanding line).** No conflict: CUR-1 adds no surface and removes none.
   But the C1/C2/C4 families ARE §15b's kept list, so their side must be
   ruled here (R5–R7), not inferred.
5. **SLG-1 Option B (§12) — the supply ledger's Debit/Credit/Balance columns
   stay empty for the finance portal.** No conflict; when the portal fills
   them it reads `/api/settings.currency` (`apiController.js:59`) for the
   label and prints bare numbers. State it, do not build it.
6. **§13 PAY-1 — `₦50,000` badge line, `PAYMENT_THRESHOLD_NGN`.** No
   conflict; A side, untouched.
7. **Relabel-on-env-change vs "the number on the card is the number the
   ledger posts" (RET-3 discipline).** Old invoices re-render with the new
   label. Freezing the unit per invoice needs a new trailing column on
   `Invoices` — a schema change, owner sign-off (R3).
8. **DDC-1 R1** — consistent with §17 in its default `naira` mode; its opt-in
   `thousands` mode (`specs/DDC-1_DAILY_DETAILS_CARD.md:260`) prints a
   "₦ thousands" header over the sale rows, which must take the CUR-1 label
   instead (`<saleUnit()> thousands`, or `thousands`) — see C8. The expense
   chips keep `₦`.

---

## 4 · The mechanism

### 4.1 One money module — `src/utils/money.js`

Two entry points, so every caller states which side it is on and the lint can
check it. `src/utils/format.js` keeps `fmtQty` (bare digits, ≈230 callers)
and `_localeNumber`; `fmtMoney` / `fmtMoneyShort` / `currencySymbol` become
deprecated shims over the new module during the sweep and are deleted in the
last step.

| Export | Renders | Rule |
|---|---|---|
| `expense(n, { fraction = 0 })` | `₦12,345` · `₦1,512.50` | Literal `₦`, never the env. `en-NG` grouping. Integer by default (PAY-1 rounds); `fraction: 2` for the cash book (today's `fmtNgn` = `fmtQty(n,{maxFraction:2})`) |
| `sale(n, { fraction = 0 })` | `12,345` | Bare. `en-NG` grouping. Integer by default; `fraction: 2` only where the caller allows kobo (the invoice web copy prints 2 dp today — recommend integers there too, to match the PDF; R10) |
| `saleRate(n, { fraction = 0 })` | `1,450/yd` · `1,512.50/yd` | Bare rate with the divisor named — the INV-2 rule-3 shape without the symbol. Integer by default; `fraction: 2` for the landed-cost sites (today's `toFixed(2)` at `inventoryService.js:1223`; `landedCostService.js:131-134` prints 2–4 dp) |
| `saleUnit()` | `''` (default) · `'NGN'` · `'₦'` | The once-printed label, from the env contract below — empty unless management sets one |
| `saleHeader(word)` | `COST NGN` · `COST` | Column-header composer for the invoice and any table; empty label → bare word |
| `saleLegend()` | `amounts in NGN` · `''` | The one legend line a report may carry (generalises `telegramController.js:297` `buildReportLegend`) |
| `code()` | `'NGN'` | The accounting code (`CURRENCY`) — narrations, FX pair quote leg, incentive rows, `/api/settings` |

Rules baked into the module, not into callers: the symbol `₦` appears in
exactly one file in `src` outside the A allowlist — this one. No entry point
ever puts the unit *inside* a number string on side B; the unit is a separate
call the caller places once (header, legend, chip title), never inline.

### 4.2 The env contract

The owner pointed at the Railway variable. Today that is `CURRENCY`
(`src/config/index.js:91`, default `'NGN'`), and it already has three jobs
that are **not** display: it is persisted into ledger narrations
(`accountingService.js:32,71`), it names the accounting code the FX pair is
quoted in (`landedCostService.js:169` hardcodes `forex.rate('USD', 'NGN')`,
matching the manual `ForexRates` rows `landedCostFlow.js:271-273` tells the
admin to add — not a bug: if the quote leg followed `CURRENCY` and the code
ever changed, the lookup would fail outright, so it stays hardcoded unless
R8 says otherwise), and it is stored per incentive row (`incentivesRepository.js:66`).
Both `config/index.js:91` and `format.js:19` collapse a blank to `'NGN'`, and
`currencySymbol('')` returns a lone space, so **a blank `CURRENCY` is not a
clean "no unit" today** — unsetting the variable changes nothing. §17 lists
"what a blank `CURRENCY` means (no symbol vs a separate knob)" as OPEN; the
owner spoke of one existing variable, singular. That is a ruling (R2a/R2b),
not a table cell — the table below shows the plan's preferred shape (R2b).

Proposed contract (R2b) — two variables, both Railway, both restart-only:

| Variable | Meaning | Allowed | Default | Blank |
|---|---|---|---|---|
| `CURRENCY` | the accounting CODE (unchanged meaning) | ISO 4217 code | `NGN` | R2a/R2b decide (today: treated as `NGN`) |
| `SALE_UNIT_LABEL` (new) | the label printed ONCE on side-B documents, IF management wants one | any string ≤ 8 characters, e.g. `NGN`, `₦`, `N` | unset → **no label anywhere** (bare — the literal reading of §17) | unset/blank → no label; `NONE` accepted as an explicit synonym for blank |

The default is bare. The owner's words are "without the currency symbol OR
UNIT"; "management to decide what value will fit in" can mean management
picks a printed label, or equally that management sets the accounting code
only and documents carry no unit at all. The plan does not choose between
those readings — R12b asks it — so a label prints only when management sets
one, and until then every side-B surface reads exactly as `NONE` would.

Why two variables and not one (R2b, the plan's preference): a sentinel on
`CURRENCY` alone (`CURRENCY=NONE`, or blank = no unit) would stamp the
sentinel into ledger rows and incentive rows and change the FX pair's name.
The label is display; the code is data. The one-variable alternative (R2a:
blank `CURRENCY` = no unit) is workable but costs three pins — the FX pair
`landedCostService.js:169`, the narrations `accountingService.js:32,71`, the
incentive rows `incentivesRepository.js:66` would each need their own literal
`'NGN'` — and it is put to the owner, not ruled out.

**Where the label is printed (once, never inline):**

| Surface | Placement (once management sets a label) | Unset (default) or `NONE` |
|---|---|---|
| Invoice PDF | column headers `COST <label>` / `PAYMENTS <label>` (`invoiceService.js:242-243`) — the slot that already gives the bare cells at `:263/:273/:280` their unit; keeps INV-1 rule 9's columns | `COST` / `PAYMENTS` |
| Invoice web copy | `<th>Rate (<label>)</th><th>Cost (<label>)</th>` (`invoiceWebController.js:122`) — today the web page has NO unit anywhere except the symbol | `Rate` / `Cost` |
| Telegram reports (Stock Value, sales reports, purchase pattern, ranking, analytics, queryEngine) | the existing legend line `_… · amounts in <label>_` (`telegramController.js:297`) | legend omits the fragment |
| Approval cards and wizard chips | no label at all — the card title names the object (`💰 Credits ABBA 150,000 (60 yds × 2,500/yd)`); `/yd` names the divisor | same |
| Invoice Telegram caption, status strip, DEBIT BALANCE line | bare; the table header above carries the unit | same |
| AI data context | `INVENTORY DATA SUMMARY (currency: <code>)` header (`queryEngine.js:286`); the per-number prefixes at `:281-283` are model input, not a printed output — a refinement, recommended untouched (§5) | `(currency: NGN)` from `code()` — the model still needs a unit |
| `/api/settings` | add `saleUnitLabel` beside `currency` (`apiController.js:59`) | `""` |

**Restart-only env vs a Settings-sheet knob (CLAUDE.md feature-recipe rule 4).**
Rule 4 puts tunables in the Settings sheet so a supervisor can change them in
one cell with no deploy. That rule is for *business knobs* — thresholds, days
back, toggles someone adjusts week to week. The unit of the books is not a
knob: it is deployment identity (like `BASE_URL`); `src/config/index.js:91`
reads `process.env.CURRENCY` once at process start, and `format.js:19`,
`accountingService.js:12`, `inventoryService.js:20` and every module that
caches `DEFAULT_CURRENCY` copy it at module load (the three
`approvalEvents.js:753/920/1974` closures read `config.currency` per call,
but `config` itself never re-reads the env, so they are restart-only too);
and a change re-labels every old invoice. A restart-only env change is the
*safer* shape here: it is deliberate, it lives in the Railway dashboard where
management already holds the other secrets, and it cannot be flipped by a
mis-typed cell mid-day. It is also exactly what the owner said. Rule 4 is
honoured for the pieces that ARE knobs and already live in Settings
(`PAYMENT_THRESHOLD_NGN`, DDC-1's proposed `DAILY_CARD_UNIT`). If the owner
prefers a no-deploy switch, the alternative is one Settings key
`SALE_UNIT_LABEL` read per render (not cached) — offered inside R2b, not
recommended.

### 4.3 Decimals and grouping — one rule per side

- Grouping is `en-NG` everywhere (digit style, not currency). Seven lines in
  five files use the server-default locale today and are aligned in passing:
  `inventoryService.js:1207`, `officeExpenseFlow.js:518`, `branchOpsService.js:117,214,429`,
  `dailyBranchOpsFlow.js:323`, `telegramController.js:9561`.
- Side A: integers for PAY-1 (`fmtNaira` rounds), up to 2 dp in the cash book
  (as today). Side B: integers by default for values. `pricePerYard` is
  `parseFloat` (`inventoryRepository.js:57,99`) and nothing rounds it, so
  "integer rates" is a display choice that holds because the sheet holds
  integers in practice — not a data guarantee. Landed-cost rates are
  fractional by construction (`landedCostService.js:90`, 4 dp) and keep 2 dp
  via `saleRate(n, { fraction: 2 })` (`inventoryService.js:1223`,
  `landedCostFlow.js:342,351`). The invoice web copy's 2 dp
  (`invoiceWebController.js:39`) is the remaining outlier — R10.

---

## 5 · The full site table, grouped by file, with the target helper

Legend: **A** `money.expense` · **B** `money.sale` / `saleRate` / `saleHeader` /
`saleLegend` · **C→B** undecided, recommended B · **C→A** recommended A ·
**keep** no change · **code** `money.code()` · **del** delete. Line numbers are
the verified anchors at `d41d4e0a`.

### Invoice (owner-named surface)

| File:line | Today | Target |
|---|---|---|
| `src/services/invoiceService.js:27` | `fmtQty` aliased as `fmtMoney` (bare) | `money.sale` (B) |
| `:32` | `const NGN = '₦'` | **del**; `money.saleUnit()` for headers only |
| `:230,:232,:233` | status strip `₦x settled` / `₦x received of ₦y` / `₦x due` | bare (B) |
| `:242,:243` | `COST ₦` / `PAYMENTS ₦` | `money.saleHeader('COST')` / `('PAYMENTS')` (B) — the once-printed label |
| `:260` | `@ ₦rate/yd` | `money.saleRate(l.rate)` (B) |
| `:263,:273,:280` | bare cells | keep |
| `:289` | `DEBIT BALANCE ₦x` | bare (B) |
| `:306` | caption `Total ₦x · Paid ₦y · Balance ₦z` | bare (B) |
| `:29-30` | DejaVu fonts | keep (see §7) |
| `:160,:166-188` | numbers | keep |
| `src/repositories/invoicesRepository.js:20-26,:51-53` | bare cells | keep; R3 decides a `unit_label` trailing column |
| `src/controllers/invoiceWebController.js:38-40` | local `fmtMoney` → `₦` 2 dp | **del**; `money.sale` (B, R10 for dp) |
| `:67` | `₦rate/yd` | `money.saleRate` (B) |
| `:68,:75,:126,:127,:130` | `₦` cells and totals | bare (B) |
| `:122` | `<th>Rate</th><th>Cost</th>` | `Rate (<label>)` / `Cost (<label>)` via `saleHeader` (B) |
| `:66` | `yds` | keep |
| `specs/INV-1_CUSTOMER_INVOICES.md:26,:102` | `Cost ₦ \| Payments ₦`, `₦x of ₦y` | supersession note (conflict 1) |
| `specs/INV-2_INVOICE_DESIGN_PROMPT.md:26,:32-35,:49-50,:74,:86,:108` | `₦` throughout | rewrite rule 3 and the field notes (conflict 2) |
| `specs/inv1-mockups/template-*.html` | 19 `₦` literals across the three files | refresh with the header-label shape (part of R1 — INV-1 decision 9 `:29` names `template-final-hybrid` as the template reference) |

### Shared formatters and config

| File:line | Today | Target |
|---|---|---|
| `src/utils/money.js` (new) | — | the module of §4.1 |
| `src/utils/format.js:19-20,:66` | `DEFAULT_CURRENCY` / `CURRENCY` export | keep as `money.code()` source during the sweep; then `money.js` reads config directly |
| `:21-29,:36` | `SYMBOLS`, `currencySymbol` | **del** at the end (the only shared path that turns a code into `₦`) |
| `:45` `fmtMoney` | `NGN 1,500` | shim → `money.sale` + legend expectation; **del** at the end |
| `:54` `fmtMoneyShort` | `₦1,500` | shim; A callers re-pointed to `money.expense` first; **del** at the end |
| `:59` `fmtQty` | bare | keep |
| `src/config/index.js:91` | `currency` | keep; add `saleUnitLabel: process.env.SALE_UNIT_LABEL` |
| `.env.example:45`, `SETUP.md:82,:126`, `TESTING.md:17,:59,:74,:126`, `codebase_overview.md:316,:338,:437` | `CURRENCY=NGN` docs | document both variables and the `NONE` sentinel; TESTING expectations go bare |
| `src/controllers/apiController.js:59` | `currency` | add `saleUnitLabel` (B) |
| `railway.json` | no variable | nothing — set in the dashboard |

### Sale approval cards and the enrichment wizard

| File:line | Today | Target |
|---|---|---|
| `src/services/approvalCards.js:193` buildSaleCard | no money | keep |
| `:305` credit limit (bare) | bare | keep (C6 precedent) |
| `:453-454` return credit + rate | inline `₦` ×2 | `money.sale` + `saleRate` (C3→B) |
| `:461` Outstanding → after | inline `₦` ×2 | `money.sale` (C4→B) |
| `:488,:493,:494` payment card | inline `₦` ×3 | `money.sale` (C2→B) |
| `:760` Owes | inline `₦` | `money.sale` (C6→B) |
| `:836` generic `Price`/`Amount` pair, printed raw by the `:844-846` loop | raw value | `money.sale` for grouping (B) — **with a caveat**. The generic renderer cannot know its side, and `buildCardFromActionJSON` (`:819-829`) has NO branch for `request_payment`, `record_office_expense` or `register_payment_account`; the second signer's inbox (`approvalsInboxFlow.js:741,754`), the reminder sweep (`approvalReminder.js:104`), the ops API (`apiController.js:410`) and `telegramController.js:237` all rebuild A rows through this fallback. Verified inert TODAY only because no A actionJSON carries a key named `amount` or `price`: `request_payment` → `amount_ngn` (`paymentFlow.js:379`), `record_office_expense` → `total_amount` + `items` (`branchOpsService.js:242-244`), `register_payment_account` → no figure — those rows show no amount at all through the fallback (a pre-existing gap, not CUR-1's). Either leave `:836` raw, or make the list side-aware by action code (A set → `money.expense`); S-CUR rule 5 pins the inbox rebuild of a `request_payment` row |
| `src/events/approvalEvents.js:359` buyer chips `— ₦rate/yd` | inline `₦` | `money.saleRate` (B) — **ask-first file** |
| `:627` rate chip | inline `₦` | `saleRate` (B) |
| `:646` Outstanding line | inline `₦` | `money.sale` (C4→B) |
| `:654,:699,:882,:960,:1016` prose "Naira" in INPUT prompts ("reply with rate per yard (Naira per yard)", "amount received (Naira)") | literal word | **keep** — refinement block below (R18); a prompt names the unit the admin must type, it prints no money |
| `:695,:876` Paid-in-full chip and ack | inline `₦` | `money.sale` (B) |
| `:838` rate ack | inline `₦`, no grouping | `saleRate` (B) |
| `:753-754,:920-921,:1974` three `fmt` closures | `${CURRENCY} n` | **del**; `money.sale` (C4→B) |
| `:1119,:1975` outstanding reply | via closures | `money.sale` (C4→B) |
| `:1899` creditTail | from `inventoryService.fmtNgn` | follows C3 |
| `:2287` receipt prompt `(NGN)` | literal | **keep** — input prompt, refinement block below (R18) |
| `:1128` deliver | no money | keep |

### Inventory executors and return credits

| File:line | Today | Target |
|---|---|---|
| `src/services/inventoryService.js:20` `CURRENCY` | own copy | **del**; `money.code()` where needed |
| `:47` `fmtNgn` | inline `₦` | **del**; `money.sale` (C3→B) |
| `:64-66` `formatMoney` (exported `:1969`, no caller) | code form | **del** |
| `:495,:517,:647` credit notes | `fmtNgn` ×5 | `money.sale` + `saleRate` (C3→B) |
| `:300,:437,:460,:684,:809` sheet writes | bare | keep |
| `:704` record_payment branch | delegates | keep |
| `:1207` record_office_expense reply | inline `₦`, default locale | `money.expense` (A) |
| `:1223` landed cost finalized | inline `₦`, `toFixed(2)` | `money.saleRate(n, { fraction: 2 })` (C9→B, R8) — the rate is 4 dp by construction; the integer default would truncate it |
| `:1623` payment approved | `fmtNaira` | `money.expense` (A) |
| `:1815` INVOICED_ACTIONS | trigger | keep |

### Sale-side flows and services

| File:line | Today | Target |
|---|---|---|
| `src/flows/returnFlow.js:40,:520` | `fmtMoneyShort` ×2 | `money.sale` + `saleRate` (C3→B) |
| `src/flows/salesBrowserFlow.js:63` `ngn()` | inline `₦` | **del**; `money.sale` (B) |
| `:270,:282,:303,:458` | `ngn()` | `money.sale` (B); `:316` keep |
| `src/flows/soldBalesFlow.js:67` `fmtNgn` | inline `₦` | **del**; `money.sale` (B) |
| `:508` `@ ₦rate = ₦amount` · `:516` total | `fmtNgn` | `saleRate` / `sale` (B) |
| `src/flows/supplyDetailsDesignFlow.js:121-122` local `fmtMoney` | inline `₦` (shadows shared name) | **del**; `money.sale` (B) |
| `:133` money suffix | local | `money.sale` (B) |
| `src/services/supplyDetailsReport.js:133,135,227,235,239,266,301` | injected `valStrRow`/`valStrShort` | unchanged call shape; the injected helpers change in the controller |
| `src/flows/bundleSaleFlow.js:174` `fmtNgn` | dead (`:173` `fmtQty` beside it is live — `:1164`) | **del** |
| `src/services/salesFlowService.js:12,:198` re-export | dead | **del** |
| `src/services/fieldCatalog.js:16,:73` | `fmtMoneyShort` | `money.saleRate` (C10→B) |
| `src/services/rateSuggestionService.js:186` | inline `₦` | `saleRate` (B) |
| `src/flows/warehouseAuditFlow.js:220,:1169` | inline `₦` + local `fmtQty` | `saleRate` (B) |
| `src/flows/salesWorkflowView.js:36,:238,:257,:372,:373` | `fmtMoneyShort` aliased | `money.sale` (C6/C7→B) |
| `src/services/queryEngine.js:13,:32,:49,:83,:93,:121,:141,:240` | `fmtMoney` | `money.sale` + one `saleLegend()` per report (B) |
| `:281-283` AI context prefixes | `${CURRENCY}n` inside the `dataContext` string fed to the model | **keep** — model input, not a printed output; refinement block below (R18) |
| `:286` AI header | `(currency: NGN)` | keep, from `money.code()` (B) |
| `src/ai/analytics.js:7,:96,:97,:108,:117` | `fmtMoney` | `money.sale` + legend (B) |
| `:131` re-export | dead | **del** |
| `src/services/landedCostService.js:124` FX label | literal `NGN` | `money.code()` in the pair label (C9→B) |
| `:125` NGN landed/yd | inline `₦` | `saleRate` with `code()` in the label (C9→B) |
| `:169` `forex.rate('USD','NGN')` | hardcoded pair, matching the `ForexRates` rows `landedCostFlow.js:271-273` asks for | **keep hardcoded** — a finance-integration behaviour change, not a bug; only if R8 says the pair should follow `code()` |
| `:114-123` USD lines | `$` | keep |
| `:289` `ngnPerYard` in the finalize return value | bare | keep |
| `src/repositories/goodsReceiptsRepository.js:157` `lc_ngn_per_yard` sheet write (`:55` locked header, `:86` reader; read back by `landedCostService.js:153`) | bare | keep (locked column name) |
| `src/flows/landedCostFlow.js:271-273` help text | literal `NGN` | `money.code()` (C9→B) |
| `:339/340` FX rate `₦x/$` · `:342` sealed rate · `:351` preview | inline `₦` | `money.sale` / `saleRate` (C9→B) |
| `:231-238,:255` USD | `$` | keep |
| `src/services/pricingService.js:82`, `rateSuggestionService.js:137`, `access/capabilities.js:50-52` | reads / JSDoc | keep |
| `src/services/inventoryMirrorService.js:33`, `bundleSaleService.js:266`, `linkedSupplyService.js` | bare / none | keep |

### Ledger, statements, customer master

| File:line | Today | Target |
|---|---|---|
| `src/services/accountingService.js:12` | own `CURRENCY` | `money.code()` (C5 keep) |
| `:32,:71` narrations | `NGN <n>` persisted | keep the code, forward-only (C5); verify `extLedgerService.js:358-372` (`_entryCustomer`) and `accountingService.js:127` `narrationNames` (caller `:169`) still match — they anchor on names, not the token |
| `src/repositories/transactionsRepository.js:11` HEADERS | no unit column; `PricePerYard`, `AmountPaid` bare | keep — nothing to rule (closes §17's Transactions bullet) |
| `:88,:111,:136` | numbers | keep |
| `src/services/extLedgerService.js:390` | bare JSON | keep |
| `src/services/balanceService.js:17`, `ledgerService.js:17`, `ledgerRepository.js:39`, `ledgerBalanceCacheRepository.js:57` | numbers | keep |
| `src/commands/ledgerCommands.js:13,:41,:77,:118` | `fmtMoney` | `money.sale` + one legend on `/ledger` (C1→B) |
| `src/services/crmService.js:8,:65` | re-export, dead | **del** the re-export |
| `scripts/list-uncredited-returns.js:31,:101,:104` | local `ngn()` | `money.sale` / `saleRate` (C3→B); CSV branch `:94` already bare |

### The controller (ask-first — every line here needs the owner's go)

| File:line | Today | Target |
|---|---|---|
| `src/controllers/telegramController.js:247-253` | imports `CURRENCY`, `currencySymbol`, `fmtMoney`, `fmtMoneyShort`; `CURRENCY_SYMBOL` dead | import `money`; **del** `CURRENCY_SYMBOL` |
| `:297` `buildReportLegend` | `amounts in ${CURRENCY}` | `money.saleLegend()` (B) — the pattern everything else adopts |
| `:331,:335,:345` `valStr*` | `fmtMoney` / `fmtMoneyShort` | `money.sale` (B) — flips every supply report at once |
| `:571` Base rate tail | `fmtMoney` | `saleRate` (B) |
| `:632,:634,:644,:670,:684` sales design/customer reports | `fmtMoneyShort` | `money.sale` (B) |
| `:698,:1301,:1304,:1322` customer 360 sale values | `fmtMoney` | `money.sale` (B) |
| `:724` timeline payment line | `fmtMoney` | `money.sale` (C1→B) |
| `:997` `credit=₦0` · `:2048` `₦ 0`/`₦ 50k` chips · `:1893`, `:8361` credit limit | inline `₦` / `fmtMoney` | `money.sale` (C6→B) |
| `:1438,:1448,:1464` purchase pattern · `:1547,:1556,:1561` ranking | `fmtMoneyShort` | `money.sale` (B) |
| `:2242,:2288,:2289,:4646,:4660,:4662,:8560,:8566` price update | `fmtMoney` + `/yard` | `saleRate` (B) |
| `:3066,:3178,:3180,:3186,:3189,:3228,:3232,:3236,:3238,:3242` Check Stock / Stock Value | `fmtMoney` ×9, `fmtMoneyShort` ×1 | `money.sale` / `saleRate`; subtitle gains the legend (B) |
| `:4554` bale card price | `fmtMoney` | `saleRate` (B) |
| `:6064,:6065,:6187,:6188,:6432` container / allocation values | `fmtMoney` / `fmtMoneyShort` | `money.sale` (B) |
| `:3627,:3646,:9569,:9642,:9647,:9683` `NGN ` + `fmtQty` · `:9561` inline `₦` | literals | `money.sale` (C2→B) — the seven printed outputs move together |
| `:151,:3603,:9499` receipt prompt `Enter the payment amount received (NGN):` | literal | **keep** — input prompt, refinement block below (R18) |
| `:178,:4831,:4843` payment recorded / which customer | `fmtMoney` | `money.sale` (C2→B) |
| `:4781,:4782,:4800` check_customer / check_balance · `:4870-4875` statement | `fmtMoney` | `money.sale` + one legend per reply (C1→B) |
| `:4884-4886` daybook · `:4899-4902` trial balance | `fmtMoney` (`DR NGN 1,500 \| CR …`) | **keep as today** pending R5a — all-accounts book-keeping reports that straddle both sides (C1b) |
| `:6021,:6181,:8359` | comments | keep |

### Expense side (A) — optional swaps so the lint can prove inertness

| File:line | Today | Target |
|---|---|---|
| `src/services/paymentService.js:37-40` `fmtNaira` | inline `₦` | keep the export; body → `money.expense` |
| `:128,:172,:176,:182` | key name / input tolerance / error text | keep |
| `src/flows/paymentFlow.js:322,:347,:365,:404,:433,:462,:464,:485,:502,:505`; `src/services/paymentCards.js:36,:65` | `fmtNaira` | keep |
| `src/flows/officeExpenseFlow.js:103` `fmtNgn` (bare) + 17 inline `₦` (`:140-621`) · `:643` undo `logger.info` line | inline | `money.expense(n,{fraction:2})` — behaviour-identical (A); the log line may stay literal |
| `:375,:447,:448,:451` prose `(NGN)` / "no ₦ symbol" | literals | keep |
| `:518` validation | default locale | `money.expense` (A) |
| `src/flows/dailyBranchOpsFlow.js:79` + `:167-267` | same pattern | `money.expense` (A) |
| `:323` validation (bare) | inconsistent | `money.expense` (A) |
| `src/services/branchOpsService.js:117,:214,:429` | mixed | `money.expense` (A) |
| `:44,:47,:260,:269,:438` | comments / sheet / log | keep |
| `src/services/eveningExpenseReport.js:61` `ngn()` + `:78-97` | inline `₦` | `money.expense` (A) |
| `src/flows/taskFlow.js:51` | `fmtMoneyShort` aliased as `fmtMoney` | `money.expense` (C11→A) — **the pin** |
| `:1018,:1358,:1621,:2305,:2318,:3148,:3164,:3179,:3223,:3280,:3290` | via the alias with the row's currency | `money.expense` (A) |
| `:70,:1146,:1301,:1308,:1309,:2167,:2544,:2548,:2774` | inline `₦` | keep |
| `:1329` `currency = config.currency` persisted | env-derived | literal `'NGN'` (an expense-side constant), R11 |
| `src/repositories/incentivesRepository.js:36,:66` | default `config.currency` | same pin (A) |
| `src/repositories/settingsRepository.js:26` | `PAYMENT_THRESHOLD_NGN` | keep |
| `web/gantt.html:235`, `apiController.js:965` | `₦` marker / boolean | keep |
| `src/integrations/**` (`mono.js:76`, `stub.js`, `forex/stub.js`, `costRegistry.js:33`) | codes | keep |

### Input prompts and the AI data context — refinement, recommended untouched (R18)

These NAME the unit the admin must type, or feed the model; none prints a
rendered money figure of an invoice or an Inventory-changing update, so §17
does not reach them. Stripping the unit from a prompt leaves the admin typing
a number with no stated unit; stripping per-number units from the AI context
can degrade answers. The plan already keeps `officeExpenseFlow.js:375,:447`
for the same reason. Listed here so they are not swept by mistake:

| File:line | Text | Target |
|---|---|---|
| `src/events/approvalEvents.js:654` | `Unit: … (Naira per …) … reply with rate` | keep |
| `:699,:882,:1016` | `amount … (Naira)` | keep |
| `:960` | `valid number for rate (Naira per yard)` | keep |
| `:2287`; `telegramController.js:151,:3603,:9499` | `Enter the payment amount received (NGN):` | keep |
| `src/services/queryEngine.js:281-283` | `${CURRENCY}${d.value}` inside `dataContext` | keep (`:286` header stays on `code()`) |

If the owner wants the prompts bare too, each becomes `money.saleUnit()` in
the parenthetical (empty label → drop the parenthetical) — one line each,
no other change.

### Comment and JSDoc lines carrying `₦` — lint-excluded, listed so the sweep is a closed list

`grep -rn "₦" src web server.js` at `d41d4e0a` returns 100 lines (106
occurrences); the tables above anchor 76 of them plus the `officeExpenseFlow.js:643`
log line. The remaining 23 are comments or JSDoc and are excluded by S-CUR
rule 1 (which must therefore strip `^\s*\*` block-comment lines and `/** */`
as well as `//`): `paymentService.js:17,:36,:124`; `inventoryService.js:492,:626`;
`risk/evaluate.js:140`; `dailyBranchOpsFlow.js:21`; `landedCostFlow.js:333`;
`supplyDetailsDesignFlow.js:35`; `soldBalesFlow.js:21,:36`; `taskFlow.js:13,:49,:998,:1140`;
`taskStateMachine.js:146`; `officeExpenseFlow.js:15`; `salesBrowserFlow.js:8,:173`;
`access/capabilities.js:52`; `approvalEvents.js:309`; `format.js:11,:50`
(`format.js:22` is covered by `:21-29` above). `src/risk/evaluate.js` and
`src/flows/taskStateMachine.js` appear nowhere else in this table — comment-only.

### Verified money-free (no change; listed so the sweep can skip them with confidence)

`src/services/morningDigest.js`, `src/flows/businessGlanceFlow.js`,
`src/flows/procurementPlanView.js`, `src/flows/stockByShadeFlow.js`,
`src/flows/myProductsFlow.js:22`, `src/flows/marketerCatalogFlow.js`,
`src/flows/sellBaleFlow.js:487`, `src/flows/snapSaleFlow.js:386`,
`src/flows/reminderConfigFlow.js`, `src/services/approvalReminder.js`,
`src/flows/attendanceFlow.js`, `src/flows/attendanceReportFlow.js`,
`src/flows/allocateMarketerFlow.js`, `src/ai/intentParser.js`,
`src/services/unitDisplayService.js:130`, `web/ops.html`, `web/allocations.html`,
`web/movement.html:225` (yards only), the SLG-1/SLED-1 set in §2.

### Docs and generators

| File:line | Target |
|---|---|
| `docs/BUSINESS_RULES.md:211-212` §6b | reword (conflict 3) — **only on R16**, step 8 |
| `:680-701` §17 | fill the four "open until CUR-1 reports" bullets from §10 — **after R2a/R2b, R4–R9 are answered**, step 8 (the Transactions bullet closes on `transactionsRepository.js:11`: no unit column) |
| `:297` §6d "never a silent ₦0" | keep the wording — a rule, not a render |
| `docs/CUSTOMER_PAYMENT_DOOR_2026-09-08.md:409-443` | cross-link now; mark Q13 answered only once R5–R7 come back (step 8) |
| `specs/DDC-1_DAILY_DETAILS_CARD.md` R1, `:260` | note the `thousands` header takes the CUR-1 label (`<saleUnit()> thousands` / `thousands`); expense chips keep `₦` |
| `ROADMAP.md:142` TG-10 (`⏸ Deferred`) | the `fmtMoney` half is resumed by step 9 — a deferred roadmap item, owner go; `genId` / `editOrSend` stay deferred |
| `scripts/build-edit-bale-test-script.py:137` `Price: NGN 3,500/yard` | `Price: 3,500/yard`; regenerate `docs/EDB-1_TEST_SCRIPT.pdf` |
| `scripts/make-pay1-test-pdf.py:224-249` | keep (A) |

---

## 6 · Tests

### Assertions that change (side B, and side C if ruled B)

| File | Lines | Count | Change |
|---|---|---|---|
| `test/unit/controllers/invoiceWebController.test.js` | `:59` | 1 | `/₦82,000/` → `/82,000/` + a new match on `Cost (NGN)` |
| `test/unit/services/invoiceService.test.js` | `:94-96` | +2 new | today only `%PDF-` and size are checked — **nothing pins the PDF's money today**. Add a renderer seam (`_internals.renderText(invoice)` returning the strings the PDF draws) and pin `COST NGN`, bare cells, `1,450/yd`, and the absence of `₦` |
| `test/unit/services/fieldCatalog.test.js` | `:48-50` | 3 | `₦1,500/yd` → `1,500/yd`; `:43` negative survives |
| `test/characterization/fieldRoles.myProducts.test.js` | `:95-96` | 2 | same; `:124` negative survives |
| `test/characterization/dispatchCustomerAtApproval.test.js` | `:262-263`, `:280` | 3 | rate chips and Outstanding go bare |
| `test/characterization/supplyDetailsDesignFlow.test.js` | `:163` | 1 | admin sees the figure, not `₦`; `:155` employee negative must be re-pinned on the digits (see below) |
| `test/characterization/salesBrowser.test.js` | `:137,:149,:229` | 3 | bare; `:247` negative re-pinned on digits |
| `test/unit/services/approvalCardsReturnThans.test.js` | `:56,:57,:63` | 3 | C3/C4 → bare |
| `test/unit/flows/returnFlow.test.js` | `:550` | 1 | C3 → bare |
| `test/unit/services/returnCredit.test.js` | `:71,:81,:92` | 3 | C3 → bare |
| `test/unit/services/returnThansExecutor.test.js` | `:134,:316,:330` | 3 | C3 → bare |
| `test/unit/services/approvalCardsExtra.test.js` | `:21-23` | 3 | C2 → bare |
| `test/unit/services/personRemoval.test.js` | `:69` | 1 | C6 → bare; `:148` unchanged |
| `test/unit/utils/format.test.js` | `:16-22` (`currencySymbol` ×4), `:28-38` (`fmtMoney` ×5), `:44-49` (`fmtMoneyShort` ×3) | 12 → replaced | every assertion on the three deleted helpers goes with step 9; move to `test/unit/utils/money.test.js`: `expense`, `sale`, `saleRate` (incl. `fraction: 2`), `saleUnit` under unset / `NGN` / `₦` / `NONE`, `saleHeader`, `saleLegend`, `code` |
| **Total** | | **≈12 (B) + ≈15 (C→B) + 12 helper** | |

### Negatives that must be RE-PINNED, not left vacuous

A `!/₦/` assertion is today's proxy for "money hidden from this role". Once
side B prints no `₦` for anyone, those assertions pass for the wrong reason.
Re-pin each on the digits the role must not see:
`scripts/smoke.js:7161` (S41.5 → `!/60,000/ && !/88,750/`),
`test/characterization/supplyDetailsDesignFlow.test.js:155`,
`test/characterization/salesBrowser.test.js:247`,
`test/unit/services/fieldCatalog.test.js:43`,
`test/characterization/fieldRoles.myProducts.test.js:124`,
`test/characterization/soldBalesSupplyCard.test.js:108` (already digit-free by
design; add a digit negative). The money-free-page negatives survive as they
are: `test/unit/services/supplyLedger.test.js:115`,
`test/unit/services/designMovement.test.js:218`,
`test/unit/controllers/extSupplyApi.test.js:129`,
`test/unit/controllers/extSupplyParity.test.js:146`, `smoke.js:5527,:7134,:8132-8133`.

### Side A tests — must stay green untouched

`test/unit/services/paymentService.test.js:163,171,172`;
`test/characterization/paymentFlow.test.js:192,193,229,238,278,326,327`;
`test/characterization/expenseDailyRecord.test.js:146,186-190`;
`test/unit/flows/taskTeamList.test.js:50-51`;
`test/unit/controllers/opsTasksGantt.test.js:36`;
`scripts/smoke.js:376,380,468,554,562` (incentive `NGN`), `:4013,:4112-4113,:4332,:4473`
(forex pair). The `smoke.js:468` config stub (`currency:'NGN'`) stays — it is
what keeps the task state-machine test deterministic.

### Fixtures

`test/unit/services/extLedger.test.js:49` and
`customerLedgerScope.test.js:51` carry `NGN 60000` narrations — they document
the persisted template and stay (C5 keep). Add one fixture each with the
label variants (`SALE_UNIT_LABEL=₦`, `=NONE`) for the invoice renderer seam
and for `saleLegend`.

### The smoke lint — `S-CUR` (new section in `scripts/smoke.js`, modelled on S4)

1. **No `₦` literal in `src/` outside `src/utils/money.js` and the side-A
   allowlist** (`officeExpenseFlow`, `dailyBranchOpsFlow`, `branchOpsService`,
   `eveningExpenseReport`, `paymentService`, `paymentFlow`, `paymentCards`,
   `taskFlow`) — comments excluded: the lint strips `//` lines AND
   `^\s*\*` block-comment lines / `/** */` JSDoc (23 of the 100 `₦` lines are
   comments — the closed list in §5). Warn mode in step 2, fail mode from step 9.
2. **Side-B files must not import `money.expense`, `fmtNaira`,
   `fmtMoneyShort`, or contain the words `Naira` / `'NGN'` as display
   literals** (the accounting `code()` call is allowed).
3. **Side-A files must not import `money.sale*`, `CURRENCY`,
   `DEFAULT_CURRENCY` or `config.currency`** — this is the proof that a
   change to the env cannot move an expense figure.
4. **`fmtMoney` / `fmtMoneyShort` / `currencySymbol` have zero callers** once
   step 9 deletes them.
5. **The inbox rebuild of a `request_payment` row still shows `₦`** — a
   characterization test through `approvalsInboxFlow` →
   `buildCardFromActionJSON` — and no key named `amount` / `price` is added to
   the generic field list at `approvalCards.js:836` without a side check.

---

## 7 · The invoice PDF glyph — a bonus outcome

pdfkit's built-in Helvetica (WinAnsi) has no U+20A6 `₦`; `invoiceService.js:29-30`
embeds DejaVu Sans / Sans-Bold so the symbol prints at all, and INV-2 `:32-35`
records that the result LOOKS like a struck-through zero (the Naira glyph's
double bar), which the reviewer mistook for a void mark. Under this plan the
symbol leaves the document, so the "struck-through ₦0" disappears from the
PDF as a side effect — no font work. DejaVu stays: INV-2 §Visual language
locks the two faces, and the em-dash / middle-dot typography needs them. The
one caveat: whatever management puts in `SALE_UNIT_LABEL` must exist in
DejaVu or it prints as a box — `₦`, `NGN`, `N` all do. `money.js` should log a
warning at startup when the label contains a character outside a small safe
set (Latin letters, digits, `₦ $ € £`) — a refinement, not part of the
sweep. The web copy is unaffected (system font).

---

## 8 · Build plan — smallest shippable steps

Each step is one commit; gates are `npm test`, `npm run smoke` at `$0`,
`npm run lint` at 0 errors. Steps 1–5 need no ask-first file. Steps 6 and 7
touch `approvalEvents.js` and `telegramController.js` — owner go required per
CLAUDE.md scope rule 2 and the ask-first list.

| # | Step | Files | Gate | Ask-first? |
|---|---|---|---|---|
| 1 ✅ A | **Docs first — only what R1 covers.** Amend INV-2 rule 3 and field notes, INV-1 decision 9 supersession note, refresh the three mockups (R1 names them); CPD §7 gets a cross-link only | `specs/INV-2_*`, `specs/INV-1_*`, `specs/inv1-mockups/*.html`, `docs/CUSTOMER_PAYMENT_DOOR_*` (link only) | none (docs) | no — but R1 must be answered first |
| 2 ✅ A | **`src/utils/money.js`** + `test/unit/utils/money.test.js` + `config.saleUnitLabel` + `.env.example` + S-CUR lint in **warn** mode. `format.js` exports become shims | `src/utils/money.js`, `src/utils/format.js`, `src/config/index.js`, `scripts/smoke.js`, `.env.example` | tests green; every existing test still passes because the shims are behaviour-identical | no |
| 3 ✅ A | **Pin side A.** `taskFlow` + `incentivesRepository` → `money.expense` and the literal `'NGN'` for stored currency (R11); `fmtNaira` body → `money.expense`; optional swaps in the EXP-1 files; locale fixes | `src/flows/taskFlow.js`, `src/repositories/incentivesRepository.js`, `src/services/paymentService.js`, `src/flows/officeExpenseFlow.js`, `src/flows/dailyBranchOpsFlow.js`, `src/services/branchOpsService.js`, `src/services/eveningExpenseReport.js` | side-A tests unchanged and green; S-CUR rule 3 clean | no |
| 4 ✅ A | **The invoice** — PDF, web, caption, renderer seam and its new pins; `apiController` `saleUnitLabel` | `src/services/invoiceService.js`, `src/controllers/invoiceWebController.js`, `src/controllers/apiController.js:59`, both invoice tests | new PDF text pins; `invoiceWebController.test.js:59` re-pinned | no |
| 5 ✅ A | **Flow modules and services on side B** (and C families ruled B by R4–R9): sales browser, sold bales, supply details design, field catalog, rate suggestions, warehouse audit, sales workflow view, queryEngine, analytics, landed cost, inventoryService (`fmtNgn`, `formatMoney`, `:1207`, `:1223`, credit notes), returnFlow, ledgerCommands, accountingService `code()`, dead re-exports, backfill script, EDB-1 generator | the files named in §5 outside the two ask-first files | ≈20 assertions re-pinned; negatives re-pinned on digits | no |
| 6 ⏳ B | **Approval cards and the enrichment wizard** — `approvalCards.js` (not ask-first) and `approvalEvents.js` (ask-first): chips, prompts, acks, the three closures, outstanding lines, receipt prompt | `src/services/approvalCards.js`, `src/events/approvalEvents.js` | `dispatchCustomerAtApproval`, `approvalCardsExtra`, `approvalCardsReturnThans`, `personRemoval` re-pinned | **yes — approvalEvents** |
| 7 ⏳ B | **Controller sweep** — imports, `buildReportLegend`, `valStr*`, every `fmtMoney`/`fmtMoneyShort` line, the ten receipt literals, `CURRENCY_SYMBOL` deletion | `src/controllers/telegramController.js` | characterization tests green; `supplyDetailsReport` unchanged | **yes — controller** |
| 8 ✅ A (docs) | **Docs/generators follow-through**: TESTING.md expectations, SETUP.md, codebase_overview, regenerate `docs/EDB-1_TEST_SCRIPT.pdf`; **and the rulings-gated doc edits** — §17 open bullets filled (after R2a/R2b, R4–R9), CPD Q13 marked answered (after R5–R7), §6b reworded (only if R16 = yes), DDC-1 thousands-header note | docs, `scripts/build-edit-bale-test-script.py`, `docs/BUSINESS_RULES.md`, `docs/CUSTOMER_PAYMENT_DOOR_*`, `specs/DDC-1_*` | PDF regenerated; each doc edit cites the ruling that closed it | §6b only on R16 |
| 9 ⏳ B | **Cleanup — resumes the deferred TG-10 money half (owner go)**: delete `fmtMoney`, `fmtMoneyShort`, `currencySymbol`, `SYMBOLS` from `format.js`; S-CUR to **fail** mode; ROADMAP TG-10 row updated (`fmtMoney` done; `genId` / `editOrSend` still deferred) | `src/utils/format.js`, `scripts/smoke.js`, `ROADMAP.md` | S-CUR rules 1–5 at 0 | yes — a deferred roadmap item, not housekeeping |

Steps 4 and 5 can ship and be tested live before 6 and 7 are approved; the
shims keep the un-swept surfaces exactly as they are today, so the bot is
never half-changed in a way the owner can see.

**Release split (09-Sep-2026).** ✅ A = shipped in release A; ⏳ B = release
B, after the owner's live check (§11) and go. `approvalCards.js` (step 6's
non-ask-first half — return credit, payment card, Owes, Outstanding→after)
shipped in release A; only the `approvalEvents.js` half of step 6 waits. The S-CUR lint stays in warn mode until step 9; its
findings are the release-B backlog (`npm run smoke` lists them as `warn`
lines).

---

## 9 · Rollout

1. **Before any code:** owner answers R1 (INV-2 brief) so the design in
   flight is not finalised against the old rule.
2. **Railway:** leave `CURRENCY=NGN`. Leave `SALE_UNIT_LABEL` unset — no
   unit anywhere, the literal reading of §17 — unless R12b says documents
   carry a unit, in which case set it to the value management wants on
   invoice headers and report legends (R14; `NGN` recommended if so — the
   header then reads `COST NGN`). Restart the service (env changes are
   restart-only by design, §4.2).
3. **After step 4 ships — what to check, where:**
   - Approve one small sale; open the PDF the bot sends: status strip and
     DEBIT BALANCE are bare numbers, the table header reads `COST` /
     `PAYMENTS` (or `COST NGN` / `PAYMENTS NGN` once a label is set), the
     line reads `420 yds @ 1,450/yd`, no struck-through symbol anywhere.
     Open the `/i/<token>` link: `Rate` / `Cost` headers (`Rate (NGN)` /
     `Cost (NGN)` with a label), bare cells. Read the Telegram caption: bare.
   - Open an OLD invoice link: it carries the new label (R3 decides whether
     that is acceptable).
4. **After step 5:** 💰 Stock Value → no legend fragment (or `amounts in NGN`
   once a label is set), rows bare;
   📂 Check Stock `Selling: 1,500/yd`; a marketer's catalogue line
   `· 1,500/yd`; a ↩️ Return goods confirm card `💰 Credits ABBA 150,000
   (60 yds × 2,500/yd)`; `/balance` and `/ledger` bare with one legend line.
5. **After steps 6–7:** a Sell Bale approval — buyer chips `CJE — 1,500/yd`,
   the Outstanding line bare; a price update card `Before: 1,500/yard`;
   a Record Payment card `Amount: 50,000`; the receipt prompt still says
   `(NGN)` (R18 — prompts keep naming the unit).
6. **Side A, every time:** file one expense — every line still `₦`; the
   20:00 report still `₦`; raise one PAY-1 request — `₦45,000` on the request,
   finance and approval cards; set one task incentive — `₦5,000` on the card
   and in the payout queue. If any of these lost the symbol, the pin in step 3
   failed and the deploy is rolled back.
7. **Rollback** = redeploy the previous commit; the env variables are inert
   to old code (`SALE_UNIT_LABEL` is unread by it).

---

## 10 · Open rulings for the owner

> **Closed 08-Sep-2026 — owner: "Go with as recommended"** for R1–R18 and
> D1–D6, plus the clarification recorded in BUSINESS_RULES §17: no
> multiplier → unconverted variable-1 value, bare; multiplier fulfilled
> (Settings) or supplied during approval → local-currency value, bare.
> The invoice and wizard layouts go to the owner first: `specs/CUR-2_INVOICE_MULTIPLIER.md`.


Each has the recommended answer; "as recommended" closes them all.

| # | Ruling | Recommended |
|---|---|---|
| **R1** | Amend INV-2 rule 3 (*"all money is ₦ per yard"*) and INV-1 decision 9 (`Cost ₦ \| Payments ₦`) NOW, before the redesign is finalised — and refresh the three `specs/inv1-mockups/*.html` (decision 9's template reference, 19 `₦` literals): bare cells, `/yd` names the divisor, the unit appears once in the column header from the env only when management sets one, absent by default. | Yes — before the design lands |
| **R2a** | **One variable.** §17 leaves "what a blank `CURRENCY` means" open, and you spoke of the existing variable, singular. Option: blank `CURRENCY` = no unit anywhere. Cost: the FX pair (`landedCostService.js:169`), the ledger narrations (`accountingService.js:32,71`) and the incentive rows (`incentivesRepository.js:66`) each need their own literal `'NGN'` pin so a blank does not reach stored data. | Not recommended — R2b — **OWNER RULED 08-Sep-2026:** not this; see R2b. |
| **R2b** | **Two variables** (the plan's preference). `CURRENCY` keeps its accounting meaning, blank still = `NGN`; a NEW display-only Railway variable `SALE_UNIT_LABEL` (restart-only; unset = no label; any short text to print one). Settings-sheet cell instead only if you want a no-deploy switch. | Railway, as you said — **OWNER RULED 08-Sep-2026:** two variables — but the second is a **MULTIPLIER on the rate**, not a label. Variable 1 = `CURRENCY`, the accounting unit every rate is entered and booked in. Variable 2 = a rate multiplier used when the invoice is given to the customer directly: invoice rate = entered rate × multiplier, and every field that depends on the rate is filled from the multiplied rate, printed without a currency symbol. Open doubts before build: D1–D6 below. |
| **R3** | Old invoices re-label themselves when the env changes. Accept that, or freeze the label per invoice in a new trailing `Invoices` column `unit_label` (schema change)? | Accept for now; add the column only when the label first changes — **OWNER RULED 08-Sep-2026:** freeze per invoice **later**, with a new trailing column; accept re-rendering until then. With a multiplier this freeze becomes a numbers freeze, not a label freeze — see D3. |
| **R4** | Return credit line (requester card, admin card, executor note, backfill script): side B (bare, `× 2,500/yd`). | B |
| **R5** | Customer statement, `/balance`, `/ledger`, check_customer, the post-approval "Outstanding as of today" line: side B with one legend line. | B |
| **R5a** | Trial balance and daybook (`telegramController.js:4884-4886,:4899-4902`) are all-accounts book-keeping reports — cash/bank debits, receivables, revenue — straddling both sides. Leave them exactly as today (`fmtMoney`) until the finance portal takes them (SLG-1 Option B / §15b), or fold them into B? | Leave as today |
| **R6** | Customer payment IN (Record Payment card, receipt flow prompts and approval card, payment-recorded replies): side B. This closes CPD §7 Q13. | B |
| **R7** | Ledger narrations keep the `NGN` code in stored text (`Sale: … \| Cash NGN 5000`), forward-only, no rewrite of history. Transactions carries no unit column (`transactionsRepository.js:11`; `PricePerYard` bare) — nothing to change there. | Keep |
| **R8** | Landed cost: the sealed NGN landed/yd is written to `GoodsReceipts` (not Inventory), read as the base for the sale rate, AND is the cost the business paid — A or B is a genuine call. (i) Side for the sealed rate on the finalize card / executor reply / preview (2 dp kept). (ii) The FX pair `forex.rate('USD','NGN')` at `landedCostService.js:169`: stays hardcoded (the `ForexRates` rows are `USD \| NGN`) unless you want it to follow `CURRENCY`. USD input lines keep `$`. | (i) B, 2 dp; (ii) keep hardcoded; `$` stays — **OWNER RULED 08-Sep-2026:** landed cost is not being worked on now; when its fields change they follow **variable 1 only** (accounting unit), no multiplier, no currency symbol — bare number. |
| **R9** | Catalogue price badge (marketer / field catalogue `· 1,500/yd`): side B. | B |
| **R10** | Invoice web copy prints 2 decimals today, the PDF prints integers. Make both integers (rates are integers on the sheet in practice; `pricePerYard` is `parseFloat`, nothing enforces it)? | Integers on both |
| **R11** | Task incentives are side A: pin the symbol to `₦` and store the literal `NGN` in the `Incentives.currency` column instead of `config.currency`, so a sales-side env change cannot relabel payouts or write mixed-currency rows. | Yes |
| **R12** | Credit limit and "Owes …" on customer-master cards and CON-1 chips: side B (bare). | B |
| **R12b** | Does a sale invoice / report carry a unit AT ALL — even once, in a column header or legend line — or is the unit purely management's accounting code and every side-B surface stays bare (your words: "without the currency symbol or unit")? The plan's default is bare; a label prints only if you set one. | Bare by default; your call whether a header label is ever set — **OWNER RULED 08-Sep-2026:** bare — a sale invoice carries no symbol; the unit is expressed through variable 1 (accounting) and, for a customer copy, the multiplier (R2b). |
| **R13** | If R12b allows a label: approval-card and wizard text still print NO unit (the card title names the object; `/yd` names the divisor); only documents and reports carry the once-printed label. | Yes |
| **R14** | Only if R12b = a label is wanted: which `SALE_UNIT_LABEL` value goes in first on Railway — `NGN` or `₦`? Otherwise leave it unset. | Unset unless R12b says otherwise; then `NGN` — **OWNER RULED 08-Sep-2026:** superseded by R2b — there is no label variable; the second variable is the multiplier. |
| **R15** | Steps 6 and 7 edit `approvalEvents.js` and `telegramController.js` (ask-first files) — surgical line swaps only, no refactor. Go? | Go, after steps 1–5 are live and checked |
| **R16** | Reword locked §6b (`docs/BUSINESS_RULES.md:211-212`, recorded 31-Aug-2026) from *"all money is Naira per yard"* to *"all money is per yard; the unit is management's (§17)"*? A locked sentence is yours to reword, not a session's. | Yes |
| **R17** | All admin-facing sales/stock analytics — rankings, purchase pattern, customer 360 sale values, sales design/customer reports, container/allocation values, queryEngine/analytics sold values — follow side B. §17's words cover rates and stock values; this extends them to sales history. | Yes |
| **R18** | Input prompts may still NAME the unit the admin must type (`amount received (Naira)`, `(NGN)`), and the AI data context keeps its per-number `NGN` prefixes; only rendered money goes bare. | Yes — leave prompts and the AI context untouched |

### Doubts to settle before the multiplier is built (asked 08-Sep-2026)

| # | Doubt | Recommended |
|---|---|---|
| D1 | Scope: does the multiplier apply to the invoice DOCUMENT only (PDF, web copy, caption), while sale cards, statements, Transactions, the ledger and every report stay on variable 1? | Invoice document only |
| D2 | Which invoice fields are multiplied: rate and line amounts and totals for sure; and the red PAYMENT rows and the BALANCE / DEBIT BALANCE lines, which come from the ledger in variable 1 — multiply them at the same factor so the whole document is in one unit, or leave them in variable 1? | Multiply everything on the document, same factor |
| D3 | Freeze: an invoice's lines and totals are stored bare in variable 1 at issue (`Invoices.lines_json`, `subtotal`, `total`). If the multiplier is applied at READ time, changing it later re-prices every past invoice. Freeze the multiplier used at issue in a new trailing `Invoices` column (schema change, your sign-off) NOW, or accept re-pricing until the column comes? | Add the column now — a customer copy must never change after it is handed over |
| D4 | Where the multiplier lives: Railway env (restart to change; applies to every invoice after) — or a Settings-sheet cell (change at will, no deploy) — or chosen per invoice at generation (a chip: office copy × customer copy)? "If I want to give the invoice to the customer directly" sounds occasional. | Settings cell `INVOICE_RATE_MULTIPLIER` (default 1) with the env as the boot default; per-invoice chip only if you say so |
| D5 | Rounding when the multiplier is not 1: rate to 2 decimals, line amounts and totals to integers? | Rate 2 dp, amounts and totals integers |
| D6 | Variable-1 value: `CURRENCY` stays `NGN` for accounting narrations and stored rows; blank still means `NGN`. Confirm nothing about variable 1 changes. | Confirm |

---

## 11 · Release A — what shipped (09-Sep-2026) and the owner's live check

### What release A ships

| Piece | Where | Behaviour |
|---|---|---|
| The money module | `src/utils/money.js` (+ `test/unit/utils/money.test.js`) | `expense(n)` → `₦12,345` (side A, literal symbol, never the env); `sale(n)` → `12,345`; `saleRate(n)` → `1,450/yd`; `fraction: 2` prints exactly two decimals (`4,000.00/yd`); `code()` → `CURRENCY` (blank = `NGN`) for narrations / FX pair / incentive rows only. `saleHeader()` / `saleLegend()` print no unit |
| `format.js` shims | `src/utils/format.js` | `fmtMoney` / `fmtMoneyShort` / `currencySymbol` are `@deprecated` shims over `money.js`, behaviour-identical for numbers (garbage now renders `0`, not `NaN`). Deleted in release B (step 9) |
| Side A pinned | `taskFlow`, `incentivesRepository`, `paymentService.fmtNaira`, the EXP-1 files | every expense figure prints through `money.expense`; the stored `Incentives.currency` is the literal `NGN` (R11) — a `CURRENCY` change cannot move an expense figure |
| The invoice | `src/services/invoiceService.js`, `src/controllers/invoiceWebController.js` | bare in both states (§4a / §4b of CUR-2): status strip, `COST` / `PAYMENTS` headers, `@ 3.20/yd`, DEBIT BALANCE, the web copy's `Rate` / `Cost`. `docFigures(invoice)` is the one source of the document's numbers — stored base lines × the STORED multiplier; rate 2 dp when a factor applies, amounts / totals / payments / balance integers, each line `round(yards × rate × m)`, totals summed from the document's lines; PAID / PART-PAID / UNPAID from the BOOKED figures; `RATE NOT RECORDED` when a rate never resolved. The Telegram caption is a staff message: booked figures plus one `Customer copy × 1,250` line when a factor applies |
| The freeze column | `Invoices.rate_multiplier` — column W, trailing, after `created_at` | written by `createForSale` from the factor in force at issue; blank = none (never `1`); `ensureHeader` widens a live 22-column sheet by the one header cell and touches no data row; old rows read blank → unconverted |
| The knob | Settings `INVOICE_RATE_MULTIPLIER`; env of the same name is its boot default (`settingsRepository.DEFAULTS`) | blank / 0 / 1 = none; a number > 0 and ≠ 1 (≤ 1,000,000) converts every invoice issued while it is set. Read once at issue; a later change never touches an issued invoice |
| Side B swept | sales browser, sold bales, supply details design, field catalogue, rate suggestions, warehouse audit, sales workflow view, queryEngine, analytics, landed cost, `inventoryService` credit notes, `returnFlow`, `ledgerCommands`, `accountingService` (`code()`), `approvalCards` (return credit, payment card, Owes, Outstanding→after), the dead re-exports | inline `₦`, `fmtMoney`, `fmtMoneyShort` and private `NGN` constants replaced by `money.sale` / `money.saleRate`; input prompts and the AI data context untouched (R18) |
| The lint | `scripts/smoke.js` S-CUR, `SCUR_MODE = 'warn'` | rule 1 (₦ only in `money.js` + side A), rule 2 (side A never reaches the env), rule 3 (side B never prints ₦ / uses an expense helper); findings are `warn` lines, the summary counts them separately |

**Integrity, as tested** (`test/unit/services/invoiceMultiplier.test.js`,
`test/unit/repositories/invoicesRepository.test.js`): the sheet row never
carries a multiplied figure and the factor sits alone in W; the base
figures reproduce the ledger / Transactions numbers; flipping the Settings
cell AFTER issue never changes a re-render, while a NEW invoice takes the new
cell; key present as `1` beats a Settings 1,250; an out-of-range key means
none and still never falls through to Settings; a Settings read failure
means none, never a failed sale.

**Not in release A (release B, owner go):** the wizard's Step 5
(`approvalEvents.js` — the supplied-during-approval door and the
`INVOICE_MULTIPLIER_ASK` knob), the `approvalEvents.js` chip, ack and
outstanding-line sweep (the `approvalCards.js` half of step 6 — return
credit, payment card, Owes — already shipped bare in A), the
`telegramController.js` sweep (Stock
Value, Check Stock, price update, customer 360, receipts, `/balance`
replies through the controller), the deletion of the `format.js` shims, and
S-CUR in fail mode. Until then those surfaces print exactly as before —
the "📒 Outstanding" line under an approved sale still shows `NGN …`, a
buyer chip still shows `₦…/yd`.

### The owner's live check (do this before the release-B go)

1. **Settings sheet:** add the row `INVOICE_RATE_MULTIPLIER` | `1250` (any
   factor > 0 and ≠ 1; live in ≤ 30 s, no deploy).
2. **Approve one small sale** through the wizard exactly as today (rate,
   payment mode, amount paid). The wizard asks nothing new — Step 5 is
   release B.
3. **Read the approval reply** in the admin chat: the "Outstanding as of
   today" line and the sale card are BASE figures (variable 1). Then the
   invoice caption under the PDF: `Total <base> · Paid <base> · Balance
   <base>` plus one `Customer copy × 1,250` line.
4. **Open the invoice link** (`/i/<token>`) and the **PDF**: every figure is
   the base × 1,250 — rate with two decimals (`4,000.00/yd`), integer
   amounts, the red payment row and DEBIT BALANCE converted at the same
   factor, the strip status (PAID / PART-PAID / UNPAID) unchanged from what
   the base figures say, no `₦`, no `NGN`, no "× 1,250" anywhere on the
   paper.
5. **Compare with the statement**: `/ledger` / the SLED-1 statement / the
   customer's OTP ledger move by the BASE amount only; the Invoices row
   (`subtotal`, `total`, `amount_paid_at_issue`, `lines_json`) holds the base
   figures and column W holds `1250`.
6. **Blank the Settings cell** (or set it to `1`), wait 30 s, **re-open the
   same link and re-download the PDF**: the issued invoice does not change —
   still × 1,250. Approve a second small sale: its invoice is unconverted
   (base figures, `3.20/yd`), its column W is blank.
7. **Side A, every time:** file one expense (`₦` on every line), read the
   20:00 report (`₦`), raise one PAY-1 request (`₦45,000` on the request,
   finance and approval cards), set one task incentive (`₦5,000` on the
   card and in the payout queue). If any of these lost the symbol, the
   side-A pin failed — roll back.
8. **Side B, quick pass:** 💰 Stock Value rows bare, 📂 Check Stock
   `Selling: 1,500/yd`, a marketer's catalogue line `· 1,500/yd`, a ↩️ Return
   goods confirm card `💰 Credits ABBA 150,000 (60 yds × 2,500/yd)`,
   `/balance` bare.

Then say **go** for release B, or amend. Rollback = redeploy the previous
commit; the Settings cell and column W are inert to old code (an old build
ignores W and never reads the cell).

