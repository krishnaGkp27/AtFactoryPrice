# TIME-1 — Time & date display audit (12-Aug-2026)

Trigger: the pending-user onboarding card printed
`When: 2026-08-12T15:58:34.018Z` — a raw UTC ISO timestamp — and the owner
asked whether other surfaces have the same issue. A four-lens sweep of
`src/` + `server.js` (raw ISO prints · clock times without a timezone ·
"today" off the server clock · mixed clocks), each candidate adversarially
verified, confirmed **73 defects**; 13 candidates were refuted.

The full verified table is the appendix below. This header is the triage.

## The physics

- The bot deploys on Railway, whose clock is **UTC**. The business runs on
  **Africa/Lagos = UTC+1, no DST** — a fixed one-hour offset, year round.
- So there are exactly two failure shapes:
  1. **Clock times** rendered without `timeZone: 'Africa/Lagos'` are
     **one hour early, all day, every day**.
  2. **"Today"** computed from the server clock (`new Date().toISOString()
     .slice(0,10)` and friends) is **yesterday between 00:00 and 01:00
     Lagos** — a one-hour nightly window, but anything *stored* in that
     window keeps the wrong date forever.
- `fmtDate()` on a **full ISO timestamp** is NOT safe: it falls through to
  `new Date(s)` + local getters, i.e. the server's calendar day. It is only
  safe on date-only strings (`YYYY-MM-DD`), which its regex path handles
  without any timezone math.
- The right helpers already exist and are simply not used at these sites:
  `todayInLagos()` / `LAGOS_TZ` (`src/utils/dates.js`),
  `lagosISO()` (`src/utils/dateCalendar.js`).

## Priority A — wrong every single day (fix first)

| Where | What the user sees | Truth |
|---|---|---|
| `src/services/morningDigest.js:156` | 🕘 Attendance: `✅ Musa — Kano office · 07:15` | he checked in at **08:15** — the HH:MM is sliced straight out of the UTC ISO |
| `src/controllers/apiController.js:390` | Ops-dashboard attendance `"at": "07:45"` | 08:45 Lagos — and the row's `date` field IS Lagos, so the panel mixes two clocks |
| `src/events/approvalEvents.js:1350` | `✅ Confirmed by Dispatch: Musa on 12/08/2026, 15:58:34` | 16:58:34 — `toLocaleString('en-NG')` without a timeZone renders the server clock |
| `src/services/pendingUserService.js:87` | `When: 2026-08-12T15:58:34.018Z` | the anchor defect — raw UTC ISO on the onboarding card |

Every attendance time the owner has ever read in the morning digest has
been one hour early. This is the loudest, most-read instance.

## Priority B — wrong date gets STORED (permanent record damage)

All of these stamp a business date from the UTC clock. Misfires only
00:00–01:00 Lagos, but the stored row is wrong forever and every later
display faithfully repeats it.

- **Accounting ledger** — `accountingService.js:24/45/57` stamp sale /
  return / payment (both legs) ledger rows; `:102` reads the daybook's
  default day. A payment recorded 00:30 lands on yesterday's daybook and
  the customer's statement, permanently.
- **Inventory** — `inventoryRepository.js:224/243` soldDate fallback;
  `inventoryService.js:552/724`, `goodsReceiptFlow.js:461`,
  `photoReceiveFlow.js:961`, `bulkReceiveFlow.js:475` dateReceived stamps
  (feeds aging-stock maths).
- **Customer-facing supply ledger** — `baleMovementLog.js:38` business-day
  fallback dates every approved return's credit row on the `/sl/:token`
  web page.
- **Invoices** — `invoiceService.js:142` issue/sale date on the customer
  invoice page + PDF (`:240` also prints a raw ISO date on the PDF).
- **Sale dates** — `salesFlowService.js:86` (NLP sale "today");
  the "📅 Today" chips at `telegramController.js:5530/6589/8558-8579`
  store the UTC day (order `scheduled_date` then drives the due-today
  digest line and the day-before reminder); `taskFlow.js:127/588`
  deadline chips; `procurementPlanView.js:536` expected-date presets.
- **Reminder matching** — `customerFollowupsRepository.js:42`,
  `samplesRepository.js:99`, `ordersRepository.js:96` match "due
  today/tomorrow" against the UTC day, so the 00:00–01:00 scheduler ticks
  nag the wrong set. `server.js:301`: the weekly cold-customer alert's
  Monday gate is UTC — it can fire ~00:30 Lagos on a Tuesday.

## Priority C — wrong-day DISPLAY only (same nightly window, cosmetic)

~20 sites format a full UTC ISO through `fmtDate`/local `toLocaleDateString`
with no timezone: approvals-inbox chips + already-resolved notices
(`approvalsInboxFlow.js:136/492/536`, `approvalEvents.js:1594`), digest
customer notes (`morningDigest.js:328`), last-N-transactions and daybook
headers (`telegramController.js:4654/4702`), orders view
(`salesWorkflowView.js:43/289`), catalog upload dates
(`telegramController.js:11540/12343`, `catalogFlowController.js:1093`),
task incentives paid list (`taskFlow.js:117/2270`), audit checklist chips
(`warehouseAuditFlow.js:376/509`), report windows (`queryEngine.js:57/62/
183/218/223`, `telegramController.js:586`), statement PDF header + period
(`supplyStatementService.js:100`, `supplyStatementFlow.js:35/97` — raw ISO
too), remove-bank card (`approvalCards.js:338`), transfer left-on fallback
(`transferService.js:321`), ops-dashboard JSON (`apiController.js:298/318/
361/416`), OCR spend tile (`vision/index.js:171`), usage rollup day
buckets (`usageRollupJob.js:66`), FX fallback day (`landedCostService.js:166`).

## Recommended fix shape (three small commits)

1. **TIME-1a — the daily-wrong four.** New `fmtDate.withTime(iso)` in
   `src/utils/formatDate.js` → `12-Aug-2026, 16:58`, date and time from ONE
   `Intl.DateTimeFormat` pinned to `LAGOS_TZ` (so the two halves can never
   disagree across midnight). Use it at the four Priority-A sites.
2. **TIME-1b — stop storing UTC days.** Replace every Priority-B
   `new Date().toISOString().slice(0,10)` stamp/match with
   `todayInLagos()`. Mechanical, one line per site; no schema change —
   same YYYY-MM-DD strings, correct calendar.
3. **TIME-1c — make the shared door Lagos-aware.** Teach `fmtDate()` that
   a full ISO timestamp (contains `T`) is an instant: derive its calendar
   day via `LAGOS_TZ` before formatting. One change fixes the whole
   Priority-C family without touching 20 call sites; then convert the few
   raw-`slice` sites onto `fmtDate`. (Test note: any test that pins
   `fmtDate(<full ISO>)` output near a midnight boundary must seed
   Lagos-aware expectations; date-only inputs are byte-identical before
   and after.)

No Settings knob: the business timezone is already the `LAGOS_TZ` constant
used by every correct site, and the evening report's `DIGEST_TIMEZONE`
already covers the one configurable case.

## Appendix — all 73 verified findings

| File | Line | Class | Sev | Surface | Renders today as |
|---|---|---|---|---|---|
| `server.js` | 231 | server-tz-today | low | salesperson DM — hourly order reminder | Scheduled: *2026-08-13* (tomorrow)  delivered at 00:30 Lagos on 13-Aug — i.e. labeled 'tomorrow' when it is already toda |
| `server.js` | 301 | server-tz-today | low | admin DM (weekly cold-customer alert) | "⚠️ Weekly Cold Customer Alert" DM can arrive at ~00:30 Lagos on TUESDAY (UTC still Monday); its 30-day cutoff (line 315 |
| `src/controllers/apiController.js` | 298 | server-tz-today | low | web JSON (ops-dashboard overview 'audits today' tile) | Dashboard 'audits today' counter counts the UTC day — audits done 00:00–01:00 Lagos land under yesterday, and the counte |
| `src/controllers/apiController.js` | 318 | server-tz-today | low | web page /ops (Ops Dashboard) | ops dashboard "notes last 7 days" count uses a UTC 7-day boundary |
| `src/controllers/apiController.js` | 361 | raw-iso | low | web JSON (ops-dashboard approvals oversight table) | "createdAt": "2026-08-05T09:14:02.331Z"  (per pending-approval row) |
| `src/controllers/apiController.js` | 390 | mixed-clock | high | web JSON (ops-dashboard attendance panel) | "at": "07:45" for a check-in the employee made at 08:45 Lagos — one hour early on the dashboard |
| `src/controllers/apiController.js` | 416 | raw-iso | low | web JSON (ops-dashboard stock-takes table) | "at": "2026-08-12T15:58:34.018Z"  (per stock-take row) |
| `src/controllers/catalogFlowController.js` | 1093 | server-tz-today | low | admin/marketer DM (catalog ledger history list; same pattern at line 1 | 📤 CASHMERE 📕A4 ×2 → Ali (11-Aug-2026)  (dispatch logged 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 310 | server-tz-today | low | employee DM inline keyboard (supply/order date pickers' Mon/Fri chips) | Mon (17-Aug-2026) — computed off the UTC weekday/day |
| `src/controllers/telegramController.js` | 586 | server-tz-today | low | admin/employee DM (interactive sales report) | interactive "📊 Sales Report — Last 7 days" run at 00:30 Lagos includes an extra day (cutoff one day earlier than the Lag |
| `src/controllers/telegramController.js` | 1753 | server-tz-today | low | employee DM inline keyboard (sample follow-up date quick-picks) | 📅 14-Aug-2026 (+3d)  (chip computed from the UTC day, one behind at 00:00–01:00 Lagos) |
| `src/controllers/telegramController.js` | 3511 | server-tz-today | medium | employee DM (payment-receipt confirm-and-submit summary card) | 📅 Date: 11-Aug-2026  (receipt submitted 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 4654 | server-tz-today | medium | admin DM (daybook/ledger NLP report) | 📒 *Ledger — 11-Aug-2026*  (heading + wrong day's entries when asked at 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 4657 | server-tz-today | medium | admin/finance DM — daybook ledger report | 📒 Ledger — 12-Aug-2026  returned for a 'today's ledger' request made at 00:30 Lagos on 13-Aug |
| `src/controllers/telegramController.js` | 4702 | server-tz-today | low | admin DM ('last N transactions' report) | 1. 11-Aug-2026 · *Musa* · sell · CASHMERE Blue · Qty 2 · ... (for a transaction made 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 5530 | server-tz-today | medium | any flow using the shared calendar picker (button behavior + subsequen | Tapping '📅 Today' at 00:30 Lagos on 13-Aug picks and later displays 2026-08-12 |
| `src/controllers/telegramController.js` | 6589 | server-tz-today | medium | employee DM inline keyboard (supply-request date picker, srf_dtpick) | 📅 Today (11-Aug-2026) / 📅 Tomorrow (12-Aug-2026)  (shown at 00:30 Lagos on 12-Aug — both a day behind) |
| `src/controllers/telegramController.js` | 6594 | server-tz-today | medium | employee DM — supply-request wizard date picker (inline keyboard label | 📅 Today (12-Aug-2026)  shown at 00:30 Lagos on 13-Aug; tapping it stores supply date 2026-08-12 |
| `src/controllers/telegramController.js` | 8558 | server-tz-today | medium | employee DM inline keyboard (order flow 'Schedule supply date') | 📅 Today (2026-08-11)  (raw ISO date in the button, and a day behind at 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 8561 | server-tz-today | medium | employee DM — order flow 'Schedule supply date' inline keyboard | 📅 Today (2026-08-12)  shown at 00:30 Lagos on 13-Aug; 'odt:today' then stores scheduled_date 2026-08-12 (line 8579) |
| `src/controllers/telegramController.js` | 8579 | server-tz-today | medium | stored then displayed: order confirmation card, morning digest "🚚 Orde | an order scheduled 'Today' at 00:30 Lagos 12-Aug is stored as scheduled_date=2026-08-11; the morning digest then counts  |
| `src/controllers/telegramController.js` | 11540 | server-tz-today | low | admin DM sendPhoto caption (catalog manage — design asset card) | Uploaded by: Musa • 11-Aug-2026  (photo actually uploaded 00:30 Lagos on 12-Aug) |
| `src/controllers/telegramController.js` | 12343 | server-tz-today | low | admin DM (📊 Catalog Statistics report) | • CASHMERE — 11-Aug-2026  (recent-uploads list, UTC day of the upload timestamp) |
| `src/events/approvalEvents.js` | 1350 | server-tz-time | medium | admin DM — Stage-2 supply approval card prepend note (notifyAdminsAppr | ✅ Confirmed by Dispatch: Musa on 12/08/2026, 15:58:34  (wall clock in Lagos was 16:58:34) |
| `src/events/approvalEvents.js` | 1594 | raw-iso | low | admin DM (stale approve/reject tap on a resolved request) | ℹ️ Request REQ-20260812-001 was already approved on 2026-08-12 — no change made. |
| `src/flows/approvalsInboxFlow.js` | 136 | server-tz-today | low | admin DM — 🛂 approvals inbox list rows | • 12 Aug · sale bale · Musa  for a request actually created at 00:30 Lagos on 13-Aug (line 492 render) |
| `src/flows/approvalsInboxFlow.js` | 492 | server-tz-today | low | admin DM inline keyboard (approvals inbox list chips) | 🟢 12 Aug · Sale · Musa   (inline keyboard button) |
| `src/flows/approvalsInboxFlow.js` | 536 | raw-iso | low | admin DM (approvals inbox, item view of an already-resolved request) | ✅ _Already approved · 2026-08-12 — no action needed._ |
| `src/flows/bulkReceiveFlow.js` | 475 | server-tz-today | medium | stored then displayed Inventory dateReceived | bulk Excel intake at 00:30 Lagos dates all bales to the previous Lagos day |
| `src/flows/goodsReceiptFlow.js` | 461 | server-tz-today | medium | stored then displayed: GRN/bale cards, aging stock | a goods receipt submitted at 00:30 Lagos 12-Aug carries dateReceived 2026-08-11 through the approval into Inventory |
| `src/flows/photoReceiveFlow.js` | 961 | server-tz-today | medium | stored then displayed Inventory dateReceived | photo-receive intake at 00:30 Lagos dates the bales to the previous Lagos day |
| `src/flows/procurementPlanView.js` | 536 | server-tz-today | low | admin DM — procurement PO wizard expected-date presets + confirm card | PO confirm card shows Expected: 2026-08-19 instead of 2026-08-20 when '+7 days' is tapped at 00:30 Lagos on 13-Aug |
| `src/flows/salesWorkflowView.js` | 43 | server-tz-today | medium | admin DM — Sales Workflow report card (reporting hub) | ✅ accepted 12-Aug-2026  (line 185) for an order accepted at 00:30 Lagos on 13-Aug; same for 'delivered …' (198) and the  |
| `src/flows/salesWorkflowView.js` | 289 | server-tz-today | medium | admin DM (sales workflow / orders view) | _created 11-Aug-2026_ · _accepted 11-Aug-2026_  (order actually created 00:30 Lagos on 12-Aug) |
| `src/flows/supplyStatementFlow.js` | 35 | server-tz-today | low | customer-facing PDF (statement period selection) | 'This month' selected at 00:30 Lagos on 1-Sep still builds the AUGUST statement (from 2026-08-01) |
| `src/flows/supplyStatementFlow.js` | 97 | server-tz-today | medium | customer-facing PDF (supply statement period label) | Period: 2026-08-01 to 2026-08-11  (raw ISO dates on the PDF header, end date a day behind at 00:30 Lagos on 12-Aug) |
| `src/flows/taskFlow.js` | 117 | server-tz-today | medium | admin/finance DM — task incentives paid list; also every deadline line | incentives list shows paid date '12-Aug-2026' (fmtDate(inc.paid_at), line 2270) for a payment marked at 00:30 Lagos on 1 |
| `src/flows/taskFlow.js` | 127 | server-tz-today | low | employee DM inline keyboard (task deadline quick-pick chips, rendered  | 📅 Tomorrow (12-Aug-2026) ✓ — offered at 00:30 Lagos on 12-Aug, i.e. 'tomorrow' is actually today |
| `src/flows/taskFlow.js` | 588 | server-tz-today | medium | employee DM — task timeline wizard deadline preset chips (inline keybo | 📅 Today (12-Aug-2026)  chip shown at 00:30 Lagos on 13-Aug; picking it stores the task deadline a day early |
| `src/flows/taskFlow.js` | 622 | server-tz-today | low | employee DM — task deadline mini-calendar (renderCalendar) | mini-calendar marks 12 Aug with the • 'today' prefix and greys 13-Aug-earlier days per UTC while it is already 00:30 on  |
| `src/flows/taskFlow.js` | 2270 | server-tz-today | low | admin DM (task incentives — 'Recently paid' list) | Fix generator · *₦5,000* · 11-Aug-2026  (incentive actually paid 00:30 Lagos on 12-Aug) |
| `src/flows/warehouseAuditFlow.js` | 376 | server-tz-today | low | auditor DM (audit checklist state: 🚩 locked / 🔁 retry / ✅ done chips) | A design flag-locked at 23:30 UTC still renders 🚩 locked after Lagos midnight; conversely at 00:30 Lagos the 'today' sta |
| `src/flows/warehouseAuditFlow.js` | 509 | server-tz-today | low | auditor DM inline keyboard (warehouse audit checklist chips) | ✅ CASHMERE (done 11-Aug-26)  (audit reconciled 00:30 Lagos on 12-Aug) |
| `src/repositories/customerFollowupsRepository.js` | 42 | server-tz-today | low | employee/admin DM (scheduled follow-up reminders from server.js) | Follow-up reminder DM ('Follow-up due today: Ali') fires against the UTC day — a scheduler pass between 00:00–01:00 Lago |
| `src/repositories/inventoryRepository.js` | 243 | server-tz-today | medium | stored soldDate displayed in sales/sold reports and the customer-facin | whole-bale sale at 00:30 Lagos 12-Aug booked under 2026-08-11 across all thans |
| `src/repositories/ordersRepository.js` | 96 | server-tz-today | low | employee/admin DM (scheduled order reminders) | 'Supply due tomorrow' reminder DM selects orders by the UTC notion of tomorrow |
| `src/repositories/samplesRepository.js` | 99 | server-tz-today | low | employee/admin DM (scheduled sample follow-up reminders) | Sample follow-up reminder DM keyed to the UTC day, same failure window as customer follow-ups |
| `src/services/accountingService.js` | 24 | server-tz-today | medium | admin DM ledger/daybook reports + customer-facing web ledger | A payment recorded 00:30 Lagos on 12-Aug is booked and forever displayed as 11-Aug on the customer ledger, daybook and t |
| `src/services/accountingService.js` | 45 | server-tz-today | medium | admin DM (customer ledger view), stored ledger row | a return approved at 00:30 Lagos 12-Aug is credited on the customer's statement under 2026-08-11 |
| `src/services/accountingService.js` | 57 | server-tz-today | medium | admin DM (daybook, customer ledger), stored ledger rows (both legs) | a payment recorded at 00:30 Lagos 12-Aug shows on the daybook/statement dated 2026-08-11 - the owner checking 'today's l |
| `src/services/accountingService.js` | 102 | server-tz-today | medium | admin DM (daybook view; duplicated by telegramController.js:4654 which | getDaybook() with no date returns the UTC day's entries - yesterday's book between 00:00-01:00 Lagos |
| `src/services/approvalCards.js` | 313 | server-tz-today | medium | admin DM (Record Payment dual-admin approval card) | Date: 11-Aug-2026  (on a payment recorded 00:30 Lagos on 12-Aug) |
| `src/services/approvalCards.js` | 338 | server-tz-today | low | admin DM — remove_bank approval card | Most recent: 11-Aug-2026 — on the remove-bank approval card, for a receipt recorded 12-Aug 00:30 Lagos |
| `src/services/baleMovementLog.js` | 38 | server-tz-today | medium | customer-facing supply ledger web page (/sl/:token) - return rows deri | a return approved at 00:30 Lagos 12-Aug appears on the customer's supply-ledger web page as a credit row dated 11 Aug |
| `src/services/consistencySentinel.js` | 164 | server-tz-today | low | admin DM (nightly consistency-sentinel report) | Return of Bale 408 (CASHMERE, Ali, 11-Aug-26) — no approved return found in the queue  (movement logged 00:30 Lagos on 1 |
| `src/services/inventoryService.js` | 552 | server-tz-today | low | stored Inventory dateReceived, displayed in bale details, supply repor | goods-receipt approved at 00:30 Lagos 12-Aug writes Inventory dateReceived=2026-08-11, later shown as "Received: 11-Aug- |
| `src/services/inventoryService.js` | 724 | server-tz-today | low | stored Inventory dateReceived, displayed later (same surfaces as line  | bulk-receive executor stamps dateReceived one Lagos day early in the 00:00-01:00 window |
| `src/services/invoiceService.js` | 142 | server-tz-today | medium | customer-facing invoice (web page via invoiceWebController line 110 +  | Invoice web page header 'Date 11-Aug-2026' and PDF 'SALE DATE 2026-08-11' for a sale executed 00:30 Lagos on 12-Aug |
| `src/services/invoiceService.js` | 240 | raw-iso | medium | customer-facing invoice PDF | 2026-08-12 paid to GTB account  (raw ISO date printed on the invoice PDF payment row) |
| `src/services/landedCostService.js` | 166 | server-tz-today | low | admin DM (landed-cost flow FX lookup message); the chosen date also de | "⚠️ No FX rate on file ... no USD→NGN rate on or before `2026-08-11`" shown at 00:30 Lagos on 12-Aug (when the GRN has n |
| `src/services/morningDigest.js` | 156 | server-tz-time | high | admin DM — morning digest 🕘 Attendance detail section | • ✅ Musa — Kano office · 07:15  (he checked in at 08:15 Lagos) |
| `src/services/morningDigest.js` | 328 | server-tz-today | low | admin DM (morning digest, customer-notes drill-down) | 📌 11-Aug  (for a note actually written 00:30 Lagos on 12-Aug) |
| `src/services/pendingUserService.js` | 87 | raw-iso | medium | admin DM (new-unknown-user card, sent to every admin via bot.sendMessa | When: 2026-08-12T15:58:34.018Z |
| `src/services/queryEngine.js` | 57 | server-tz-today | medium | admin/employee DM (NLP 'sales today' report) | 📊 Sales Report — Today: includes yesterday's sales when viewed 00:00–01:00 Lagos (same pattern again at line 218 in sold |
| `src/services/queryEngine.js` | 62 | server-tz-today | low | admin/employee DM (sales report) | on 1-Sep at 00:30 Lagos, "Sales Report — This Month" is built from 2026-08-01 - it shows the whole of August as 'this mo |
| `src/services/queryEngine.js` | 183 | server-tz-today | low | admin/employee DM (aging stock report) | "📅 Aging Stock (received over 60 days ago, unsold)" run at 00:30 Lagos uses cutoff 2026-06-12 instead of 2026-06-13 - bo |
| `src/services/queryEngine.js` | 218 | server-tz-today | medium | admin/employee DM (NLP sold report) | Sold report — 'Today' window is the UTC day |
| `src/services/queryEngine.js` | 223 | server-tz-today | low | admin/employee DM (sold report) | "Sold Report — This Month" on the 1st of a Lagos month, 00:00-01:00, reports the previous month |
| `src/services/salesFlowService.js` | 86 | server-tz-today | medium | admin DM (sale approval card) + employee confirmation | Sale approval card shows 'Date: 11-Aug-2026' (via approvalCards.js:435 fmtDate(aj.salesDate)) for a sale typed 'today' a |
| `src/services/supplyStatementService.js` | 100 | server-tz-today | medium | customer-facing PDF (supply statement, sent as a Telegram document) | Statement date: 11-Aug-26  (PDF generated 00:30 Lagos on 12-Aug) |
| `src/services/transferService.js` | 321 | server-tz-today | low | admin/dispatch DM (transfer cards, transferFlow lines 679/1432 print f | 📅 Left the store: 11-Aug-2026  (transfer dispatched 00:30 Lagos on 12-Aug via any caller not passing leftOn) |
| `src/services/usageRollupJob.js` | 66 | server-tz-today | low | web analytics dashboard (usage_daily served by /api/analytics/*) | the admin analytics dashboard's per-day usage series buckets events by the server-local (UTC) day - activity from 00:00- |
| `src/services/vision/index.js` | 171 | server-tz-today | low | web page /ops (SNAP-3 OCR spend tile); the cap check (line 156) also g | ops dashboard shows ocr: { day: "2026-08-11", today: 37 } at 00:30 Lagos on 12-Aug, and the counter/cap resets at 01:00  |
