# The customer-payment door — where we stand before binding it (08-Sep-2026)

The owner said: *"I am bringing a person/employee/telegram user who will update
the payment against the customer, with or without the receipt, BEFORE the
supply request is raised, or AFTER the dispatch invoice is generated against
the customer/marketer. I want to bind this step for a smooth transition. Let
me know where we stand right now."*

Separately, the same day, he ruled on currency display (now BUSINESS_RULES
§17): expenses keep the ₦ symbol everywhere; invoices generated from a sale,
and any update that changes the Inventory sheet, print money with no symbol
and no unit — the unit is management's, via the Railway `CURRENCY` variable.
That ruling is recorded; the research that turns it into a surface list
(CUR-1) is a later turn. This document is the payment door only; §7 lays the
groundwork the currency turn will build on.

**Method.** Five independent sweeps traced every code path that could take
money from a customer into any book — seven candidate doors (six live, one
dormant bus listener), the supply
lifecycle from request to statement, the roles and onboarding path, the
ledger data model, and the currency literals. Every claim below was then
re-read in the code before it was written down. Anchors are `file:line` under
`telegram-ops-bot/`. Nothing here is a design; §6 names the gaps and where
each one lands, no more.

---

## 1 · Where we stand — one paragraph

**A designated employee can record a customer payment today, but only by
typing a sentence, only without a receipt, only dated today, and only against
a customer — never against a supply request, an invoice, or a marketer.** The
single door that moves the customer's book is the typed intent
`record_payment` ("Record payment 50000 from Ibrahim via bank",
`src/controllers/telegramController.js:4804-4848`): it is open to every
allowed user, has no tile, asks for no date, no bank account name, no
reference and no file, needs two admin signatures, and lands a Cash/Bank–
Receivable pair in `Ledger_Entries` keyed to the customer with a
`PAY-<timestamp>` id (`src/services/crmService.js:48-56`,
`src/services/accountingService.js:62-78`). The 🧾 Upload Receipt tile is the
only "with receipt" door, and it is evidence only: customer, amount, account
and a mandatory photo/PDF, one admin tap, a Drive copy — and **no ledger
entry and no balance change** (`telegramController.js:9527-9545`,
`:9606-9645`). The two doors do not know about each other: a payment with a
receipt costs three signatures across two unlinked rows. Both of the owner's
timings are *representable* through the typed door — an advance before a
request posts as a receivable credit and shows as a negative outstanding on
every ledger-fed surface; a settlement after the invoice credits the customer
correctly — but neither is *bound*: no field on any sheet ties a payment to a
supply request or an invoice number, the invoice's PAID/UNPAID banner is
frozen at issue, and if the approving admin already took "amount paid" at sale
approval, the new person recording the same cash books it twice. Marketers
have no receivable anywhere, so "against the marketer" cannot be recorded at
all. The locked rules bearing on this: **§15b** (no new bot-side customer-money
list/queue/report without a fresh ruling — a payment *door* is arguably one of
the "payment approval cards" the bot keeps, but that reading is the owner's to
make), **SLG-1 Option B** (the goods ledger's money columns stay blank for the
finance portal), **§12** (Customers + Inventory are the only customer truth;
money ledgers are "separate logging"), **§13** (every financial action is
dual-admin), **DUAL-1/1a** (Inventory writes dual, the sale family single), and
**§16** + `auth.isAllowed` (`telegramController.js:3912`) — a linked
customer/marketer identity gets exactly one surface, so the new person must be
an onboarded employee. (**§1c** does *not* apply here: it is the PAY-1 payee
rule — a payment ACCOUNT for money LEAVING the business may be registered only
against an active Users-sheet Telegram ID. It says nothing about who may record
inbound customer money; the analogous requirement for a customer-payment
recorder is written nowhere and would be a new ruling — §8 Q12.)

---

## 2 · The doors that exist today

| # | Door | Who can open it | Asks for | Approval | Writes to | Receipt attach? | Linked to a sale / invoice? | Used in practice? |
|---|---|---|---|---|---|---|---|---|
| 1 | **Typed `record_payment`** — "Record payment N from X via bank" (`telegramController.js:4804-4848`; candidate chips `rpk:` `:157-183`) | Any user passing `auth.isAllowed` (`:3912`); no department, role or finance check on the typed path | Customer name (must resolve to an active entity, else tappable candidates), amount, method by regex `bank\|cash\|transfer` defaulting to `cash` (`:4808-4809`). **No date, no bank name, no reference, no file** | Dual-admin: `ALWAYS_APPROVAL_ACTIONS` + `DUAL_ADMIN_ACTIONS` (`src/risk/evaluate.js:80`, `:200`); two distinct env admins for an employee, one other admin if the requester is an admin (`:242-247`). Admins meet it in the 📥 Approvals Inbox under 💵 Finance, `dual: true` (`src/flows/approvalsInboxFlow.js:83`), as well as in the DM card. Card = `buildPaymentCard` with live outstanding before→after and an EXCEEDS warning that never blocks (`src/services/approvalCards.js:487-498`) | Executor `inventoryService.js:704-707` → `crmService.recordPayment` → `Ledger_Entries` DR Cash/Bank + CR Customer Receivable, `customer_id` in col K, date `todayInLagos()`, then `Customers.outstanding_balance` = max(0, old − amount) (`crmService.js:48-56`, `accountingService.js:62-78`) | **No** — ActionJSON is `{action, customer, customerId?, amount, method}` | **No** — `txn_id` is `PAY-<Date.now()>` (`crmService.js:51`) | The only standalone booking door; pinned by tests (`test/characterization/customerDoors.test.js:112`, `test/unit/services/approvalCardsExtra.test.js:17-31`). Live usage not verifiable offline |
| 2 | **Sale-approval enrichment "amount paid"** — Step 3 payment mode, Step 4 amount, inside the approving admin's wizard (`src/events/approvalEvents.js:660-701`, `:756-770`) | The approving env admin only; the requester submits `paymentMode ''`, `amountPaid 0` (DSP-1) | Mode chips (💵 Cash · 🕐 Not yet paid · 🏦 each bank · typed), then "Paid in full" or a typed amount | Rides the sale's own single-admin approval (DUAL-1a) — no separate signature for the cash | `Transactions.PaymentMode/AmountPaid` (`src/repositories/transactionsRepository.js:11-18`); the receivable debit narration embeds the paid text (`accountingService.js:30-34`); then the **same** `crmService.recordPayment` pair if `amountPaid > 0`, `created_by` = approver, keyed by customer NAME — three sale-time writers: `sell_than` (`inventoryService.js:443-448`), `sell_package` (`:466-469`), `sale_bundle` (`:1576-1581`); `Invoices.amount_paid_at_issue` / `balance_after_issue` snapshot (`src/services/invoiceService.js:134-191`) | Sale bill only (mandatory on the bale door, SELL-K1) — proof of goods, not of money | Snapshot on the invoice row: yes. Ledger pair: no (`PAY-<ts>` again) | Yes — every approved sale passes through it |
| 3 | **`/payment <Ledger_Customers id> <amount>`** (`src/commands/ledgerCommands.js:84-119`, routed `telegramController.js:4380-4387`) | `auth.isAdmin` only (env or sheet-promoted); `FINANCE_IDS` not consulted | Customer id that must exist in **`Ledger_Customers`** (a separate master, seeded only by `/addledgercustomer`), amount | **None** | One `LedgerTransactions` row (PAYMENT / credit / completed) + `LedgerBalanceCache` recompute (`src/services/transactionService.js:27-68`) | No | No | Parallel ledger; no sale path writes it; whether the live workbook has any `Ledger_Customers` rows is unverified — likely dormant |
| 4 | **🧾 Upload Receipt** tile (`upload_receipt`, hub `daily`, `src/services/activityRegistry.js:302`; `act:` case `telegramController.js:10096`) / typed "upload receipt" (typed-intent dispatch `:5254-5257`; flow entry `startReceiptFlow` `:3479-3482`) / 🧾 chip on the 🌅 Open Branch (Daily) panel (`src/flows/dailyBranchOpsFlow.js:289`) | The **tile** appears for any user whose department CSV lists `upload_receipt` (menu derivation `:5460-5470`) — the code-seeded Sales department DEPT-001 already lists it (`src/services/schemaMapper.js:54`). The **door itself is open regardless**: the typed intent `upload_receipt` ("Upload receipt", "Log payment receipt", "Submit receipt" — `src/ai/intentParser.js:121`, `:237-239`) dispatches to `startReceiptFlow` for any `isAllowed` user with no gate (`:5254-5257`); the `act:` case has no gate either (`:10096`); and anyone holding `daily_branch_ops` gets the chip on the panel (`dailyBranchOpsFlow.js:289`) | Customer (top-10 chips, See all, ➕ Register New Customer which pauses the upload behind a `new_customer` approval `:3553-3589`), amount (typed, "NGN"), account (`BANK_LIST` + Cash), **photo/PDF mandatory** (`:3633-3636`), confirm | **Single env-admin tap** `rcapr:` (other admin if uploader is admin; self-approval blocked; decisions final) (`:9606-9625`). Not via `ApprovalQueue` — approval state lives only in admin DMs | `Receipts` row status `pending` → on approve Drive upload + cols I–L + AuditLog `receipt_approved` (`:9534-9545`, `:9636-9639`). **Nothing to any ledger; `Customers.outstanding_balance` untouched** | **Yes — required** (`telegram_file_id`, then `drive_file_id`) | No | Read back by nothing except the Remove-Bank card (`approvalCards.js:507-510`); `getByCustomer` has no caller |
| 5 | **Supply request payment picker** (`srf_pm:`, `telegramController.js:7081-7093`, ActionJSON `:11339-11383`) | The requester of a supply request | A payment-mode **label** only (Cash / Credit / each bank), optional bill photo/PDF ("if payment was already received…", Skip) | Three-stage supply chain (Dispatch → admin → assignee) | `ApprovalQueue` ActionJSON only; executor is a comment — "Intimation only" (`inventoryService.js:1582-1583`) | Optional bill, forwarded to admins, Drive link echoed in chat only | It IS the request; nothing later references it | Yes, daily — but it carries **no amount** |
| 6 | **💳 Payments (PAY-1)** (`src/flows/paymentFlow.js`, `src/services/paymentService.js`) | Every allowed user (tile injected regardless of CSV, `telegramController.js:5501-5512`) | Payee account (registered, picked), amount, optional bill | Dual-admin, then ONE finance hand marks done | `PaymentRequests` | Optional bill (col N); `proof_file_id` exists but nothing writes it | n/a | **Money going OUT** — not a customer-receipt door |
| 7 | **➕ Cash received (EXP-1)** (`src/flows/officeExpenseFlow.js:47-49`, `:495-508`) | Expense filers | Amount only | None — immediate | `BranchOpsLog` kind `cash_in` — the office float | No | No customer field at all | Office petty cash, not customer money |
| 8 | **Dormant ERP bus listener `payment_received`** (`src/events/erpEventBus.js:73-78`; bound by `registerListeners()` at startup) | Nobody today — grep of `src/` finds **no emitter** (`erpEmit`/`erpEmitAsync`/`bus.emit` of `payment_received`); only the handler itself names the event | Whatever the future emitter passes as `data` | **None** — no queue row, no card, no signatures | `accountingService.recordPaymentReceived(data)` → the same Cash/Bank–Receivable pair on `Ledger_Entries`, plus an AuditLog line; **no `Customers.outstanding_balance` decrement** (it bypasses `crmService.recordPayment`) | No | No | Un-gated ledger writer with no caller. Any future `erpEmit('payment_received', …)` posts a pair with no signatures and no Customers update — remove it or route it through the executor so the new door is the ONLY writer ((b)15) |

**Money READS, for contrast:** `check_balance` is admins + env `FINANCE_IDS`
(`telegramController.js:4793-4796`, FIN-V1); `show_ledger`, Supply Ledger,
Supply Statement and Stock Value are admin-only. But `check_customer`
(`:4773-4784`) prints the stale `Customers.outstanding_balance` to **any**
allowed user — the one ungated money line left, and it is the wrong number
(§4). The failure text on a sale approval tells admins to "check
LedgerTransactions" (`approvalEvents.js:1092`) while the writer is
`Ledger_Entries` — a name mix-up that will confuse the new person on day one.

---

## 3 · The supply timeline, and where a payment can bind

```
 T0 request raised ─ T1 Dispatch confirms ─ T2 admin assigns ─ T3 assignee accepts
        │                                                             │
        └── NO money record at any stage; the row carries a paymentMode LABEL only
                                                                      │
 T4 SALE booked (a SEPARATE request) ─ T5 ledger + Transactions ─ T6 invoice ─ T7 statement
                                          │                            │            │
                       receivable DEBIT + optional cash PAIR    frozen snapshot   goods only
```

| Point | What happens | Money record that exists | Anchor |
|---|---|---|---|
| **T0 request raised** | `supply_request` queued, stage `dispatch_review`; customer from the Customers register (CUS-1), salesperson, date, paymentMode label, optional bill | None | `telegramController.js:11339-11383`; `src/services/salesFlowService.js:35-38` |
| **T1 Dispatch confirms** | Only active Dispatch users; stage → `admin_review` | None | `approvalEvents.js:1308-1361` |
| **T2 admin approves** | ✅ opens the warehouse-boy picker instead of an executor; stage → `dispatch_acceptance` | None | `approvalEvents.js:1847-1850`, `:2061-2131` |
| **T3 assignee accepts** | Queue row → `approved`, stage `completed`, AuditLog `supply_dispatch_accepted`. No Inventory, Transactions, Ledger or Invoice write | None | `approvalEvents.js:2389-2432`; `inventoryService.js:1582-1583` |
| **T4 sale booked** | A separate `sell_*` / `sale_bundle` request; requester gives salesperson + date (DSP-1); the admin's wizard assigns customer, rate, mode, amount paid | — | `salesFlowService.js:13-23`; `approvalEvents.js:640-701` |
| **T5 executor** | Inventory flips; `Transactions` row with mode/amount/customerId; ONE receivable debit; a Cash/Bank pair if amount paid > 0 | `Ledger_Entries` debit (+ pair); `Customers` col G decremented if paid | `inventoryService.js:423-448`; `accountingService.js:22-40`, `:62-78` |
| **T6 invoice** | `INV-<year>-NNNN` issued for the sale (never for a supply request), `amount_paid_at_issue` + `balance_after_issue` snapshot, status `issued`, PDF + web view | `Invoices` row | `inventoryService.js:1815-1827`; `invoiceService.js:134-191`; `src/repositories/invoicesRepository.js:19-26` |
| **T7 statement** | SLED-1 supply statement: quantities, rate/amount blank; SLG-1 supply ledger: goods only, Debit/Credit/Balance reserved; the customer web portal shows the `Ledger_Entries` statement filtered to Sale/Payment narrations | Read-time only | `src/services/supplyStatementService.js:3-16`; `src/services/supplyLedgerService.js:3-22`; `src/services/extLedgerService.js:359-392` |

**Nothing links T0–T3 to T4–T7.** No `supplyRequestId` / `supply_request_id`
/ `fromSupply` identifier exists anywhere in `src`; the sales browser lists
supply requests and Transactions sales side by side as unrelated kinds
(`src/flows/salesBrowserFlow.js:100-115`).

### An ADVANCE — payment before the request (T0−)

- **Representable today:** yes, through Door 1 only. The customer must already
  be an active Customers entity; the amount is typed; two admins sign.
- **How it lands:** a receivable CREDIT with no debit to offset. `getCustomerLedger`
  sums debit − credit with no floor (`accountingService.js:172-177`), so every
  ledger-fed surface — the payment card, the enrichment "📒 Outstanding" line,
  the post-approval "Outstanding as of today", the typed ledger, the RET-4
  return card, the invoice's `balance_after_issue` — shows a **negative**
  outstanding. The payment card says "⚠️ Payment EXCEEDS the outstanding
  balance" and lets the admins proceed (`approvalCards.js:492-495`).
- **Where it does NOT show:** `Customers.outstanding_balance` floors at 0
  (`crmService.js:53`), so typed `check_customer` / `check_balance` show ₦0
  owed, not the credit. The supply request raised afterwards carries no
  reference to it, and SLED-1 / SLG-1 print no money.
- **On the customer's web statement:** it appears, because the portal keeps
  rows whose narration starts "Payment received from" (`extLedgerService.js:370-373`).

### A SETTLEMENT — payment after the dispatch invoice (T6+)

- **Representable today:** yes, through Door 1, dated `todayInLagos()` — never
  the day the money actually arrived.
- **How it lands:** correctly on `Ledger_Entries`; the customer's outstanding
  falls. The invoice row is never touched: `status` stays `issued`,
  `updateStatus` has no caller (`invoicesRepository.js:108`), and the PDF and
  `/i/<token>` compute PAID / PART-PAID / UNPAID from the **frozen**
  `amount_paid_at_issue` (`invoiceService.js:207-209`,
  `src/controllers/invoiceWebController.js:50-52`) — contradicting the repo
  header's claim that live status is recomputed from the ledger
  (`invoicesRepository.js:8-10`) and the same claim repeated inside
  `invoiceService.createForSale` ("the web view recomputes live",
  `src/services/invoiceService.js:156-157`). A customer who pays an UNPAID invoice in full
  keeps an UNPAID invoice.
- **The double-count trap:** if the approving admin already entered the cash
  at Step 4, that money is *already* a `Payment received from …` pair on the
  ledger (`inventoryService.js:443-448`, `:466-469`, `:1576-1581`). The new person, seeing the invoice
  and the receipt, records it again through Door 1 — a second pair, a second
  decrement. Nothing detects it; the only tell is the EXCEEDS warning, which
  fires only if the second entry pushes the balance below zero. (Within the
  executor itself there is no double-count: the debit is the full sale, the
  paid amount is text in its narration, and the pair is the only credit.)
- **On the statements:** SLED-1 and SLG-1 show nothing (goods only; SLG-1's
  blank row "where an in-between payment will sit" stays blank by ruling); the
  web statement shows the payment.

### The marketer case

There is no marketer receivable anywhere. `MarketerAllocations` holds
quantities per design/shade (`src/repositories/marketerAllocationsRepository.js:8-20`);
a catalogue loan writes a `CatalogLedger` quantity row with no money
(`inventoryService.js:1751-1780`); a linked marketer's tap raises an ordinary
`supply_request` with `paymentMode ''` and `customerId ''`
(`src/services/linkedSupplyService.js:60-76`). An invoice resolves its account
through `customerEntity` (`invoiceService.js:134-160`) — a marketer who is not
also a Customers row cannot be invoiced, and Door 1 refuses a name that does
not resolve to an active customer ("No customer matches …",
`telegramController.js:4821-4823`). "Payment against the marketer" therefore
has **no representation today**; the choice is a ruling (§8 Q7), not a bug.

---

## 4 · The data model — four stores, one truth

| Store | Written by | Read by | Verdict |
|---|---|---|---|
| **`Ledger_Entries`** (entry_id, txn_id, date, account_code, ledger_name, debit, credit, narration, created_by, created_at, customer_id — `src/repositories/ledgerRepository.js:9-25`) | Sale debit, return credit, payment pair (`accountingService.js:22-78`) | Every "Outstanding" the admins see; the typed ledger; the invoice snapshot; the customer web portal | **The de-facto book of record** (`docs/APPROVAL_BUSINESS_AUDIT_2026-09-01.md` §11 *Money beyond returns*, :333, reaches the same verdict). Append-only, computed at read time — the shape §12 calls "separate logging" |
| **`Customers.outstanding_balance`** (col G — `src/repositories/customersRepository.js:22`, `:126-134`) | Only `crmService.recordPayment`, decrement floored at 0 (`:53`). `addToOutstanding`, the only code that would ever *increase* it, has **zero callers** in `src`, `test`, `scripts` | Typed `check_customer` (ungated) and `check_balance` (`telegramController.js:4782`, `:4800`); the RMV-1 remove/restore-customer approval card ("⚠️ Owes ₦…", `src/services/approvalCards.js:758-761`) — so the dual-admin signers of a removal see the same stale number; and the removal executor stamps it into AuditLog as `outstanding_at_action` (`inventoryService.js:809`) | **Dead but still displayed.** A sale never raises it, so it reads 0 for every customer who has never paid, and stays ≤ its own starting value forever. A stale number shown as "Outstanding" |
| **`LedgerTransactions` + `LedgerBalanceCache` + `Ledger_Customers`** (`src/services/schemaMapper.js:105-113`) | Only `/payment` and `/addledgercustomer` (`transactionService.js:27-68`) | `/ledger`, `/balance`; the Sales Workflow view's "💰 Ledger" line, matched by `Customers.customer_id` — a different master, so null unless the same id was hand-seeded (`src/flows/salesWorkflowView.js:32`, `:90-94`) | **A parallel, sale-blind ledger.** Its repo header calls it "source of truth"; no sale ever writes it |
| **`Transactions.PaymentMode/AmountPaid` + `Invoices.amount_paid_at_issue/balance_after_issue`** | Once, at sale approval | Invoice PDF / web banner; sales browser | **Frozen snapshots** — correct on the day, never updated |

**What is linked to what.** A payment row carries `customer_id` and
`PAY-<ts>`; a sale row carries `ST-…` / `SP-…` / `<requestId>-<design>` and
`Transactions.SaleRefId = requestId`; an invoice carries `request_id`. The
payment shares none of these keys with anything. A supply request shares no key
with a sale. `Receipts` shares no key with any of them.

**The defects that will bite the new person specifically:**

1. **Double-count of sale-time cash** — the wizard's Step 4 and Door 1 both
   write the identical pair with no marker distinguishing "cash taken at the
   counter" from "payment received later" (`inventoryService.js:443-448`,
   `:466-469`, `:1576-1581` vs `:704-707`). Two hands, one receipt, two credits.
2. **No receipt slot** — the `record_payment` ActionJSON has no file key; the
   approval card has no "📎 attached" line (contrast the return card,
   `approvalCards.js:441`); `recordPaymentReceived` has no evidence parameter.
   The Receipts sheet cannot be pointed at from a ledger row and vice-versa.
3. **No invoice or request reference** — `txn_id` is a timestamp
   (`crmService.js:51`); `Ledger_Entries` has no reference column; the invoice
   is never marked paid (`invoicesRepository.js:108`, no caller).
4. **`Customers.outstanding_balance` is dead but read** — and shown ungated by
   `check_customer`. The new person typing "show customer X" will be told a
   number that contradicts the card the admins see. The admins themselves meet
   it too: the RMV-1 remove-customer card prints it as "Owes ₦…"
   (`approvalCards.js:758-761`) and the executor freezes it into AuditLog
   (`inventoryService.js:809`) — the removal card should read
   `getCustomerLedger` the way the payment card does.
5. **"transfer" books as Cash** — the typed door accepts `transfer` as a
   method (`telegramController.js:4808`) but the writer maps anything without
   the word "bank" to Cash (`accountingService.js:68`). The bank NAME (which
   account the money reached) is never captured on a payment at all — only the
   Upload Receipt door asks it, and that door posts nothing.
6. **Date is always today** — `recordPaymentReceived` takes no date
   (`accountingService.js:66`); the card prints `todayInLagos()`
   (`approvalCards.js:488`). A settlement recorded on Monday for Saturday's
   transfer lands on Monday's daybook and statement line, permanently.
7. **Two identities on `created_by`** — Door 1 stamps the *requester*
   (`inventoryService.js:706`, `item.user`); all three sale-time writers stamp
   the *approver* (`:446`, `:469`, `:1579`, `approvedBy`). The ledger cannot say who took the money
   consistently.
8. **Sale-time cash keys by name** (`aj.customer`, `:446`, `:469`, `:1579`)
   while Door 1 keys by id when it has one (`:706`). `crmService.getCustomer` resolves either
   through `customerEntity` (id → name → alias), so both land — but a name
   that has since been merged or renamed depends on the alias table holding.
9. **Three signatures for one payment-with-receipt** — two on the typed
   payment, one on the receipt — and the two rows never meet.
10. **A latent no-signature tail in the controller** — both the typed path
    and the `rpk:` candidate-pick path fall through to a DIRECT
    `crmService.recordPayment(...)` when `requireApproval` returns false
    (`telegramController.js:175-176` and `:4840-4841`; `requireApproval`
    `:215-217`). Unreachable today — `evaluate()` returns
    `approval_required` for every `ALWAYS_APPROVAL_ACTIONS` member
    (`src/risk/evaluate.js:275`) — but it becomes a live no-approval writer
    the moment `record_payment` leaves that list or changes shape, which
    (c)17 proposes. Delete the tail with the typed door.
11. **A dormant un-gated writer on the bus** — Door 8: `erpEventBus.js:73-78`
    posts the same pair with no signatures and no Customers update the day
    anyone emits `payment_received`.

---

## 5 · Onboarding and gating — bringing the person in with today's code

**Exact steps, no code change:**

1. The person sends `/start` → a `PendingUsers` row and an admin card with
   👔 Onboard as employee · 🤝 Link to customer · 📣 Link as marketer · 🕸 Add
   to network · 🚫 Ignore (`src/services/pendingUserService.js:228-238`).
   **Must be 👔 Onboard as employee** — §16 gives a linked customer/marketer
   exactly one surface (My Products) and every typed action refuses them
   (`telegramController.js:3912-3920`).
2. `pu:onboard` opens `userAddFlow` prefilled (`:7780-7796`): telegram id →
   name → branch → **department** (pick or create) → warehouses → **role**
   (`employee | manager | marketer | salesman` — pick `employee`; marketer /
   salesman are field roles that collapse the menu to My Products,
   `:5447-5452`) → confirm (`src/flows/userAddFlow.js:12-20`).
3. `add_user` is `ALWAYS_APPROVAL` but **not** in `DUAL_ADMIN_ACTIONS`
   (`evaluate.js:91` vs `:184-231`) — one non-requester admin signs, despite
   the flow header saying "dual-admin" (`userAddFlow.js:4`). The executor
   appends the Users row and invalidates the auth cache.
4. Their menu is the union of `Departments.allowed_activities` for their
   departments (`telegramController.js:5460-5470`); 💳 Payments (PAY-1) is
   injected for everyone (`:5501-5512`). The **🧾 Upload Receipt tile** appears
   if the department CSV lists `upload_receipt` (owner edits the sheet, or
   `scripts/grant-dept-activity.js`; the code-seeded Sales department DEPT-001
   already lists it, `schemaMapper.js:54` — whether the live sheet still
   matches the seed is unverified). **The door itself is open regardless:** any
   allowed user reaches it by typing "upload receipt" (`:5254-5257`), and
   anyone holding `daily_branch_ops` gets the chip on the 🌅 Open Branch panel
   (`dailyBranchOpsFlow.js:289`). The CSV controls the tile, not the door.
5. **`record_payment` has no activity code** (grep of `activityRegistry.js`:
   0 hits). It cannot be granted or withheld by a department; the person
   simply types it, as can every other allowed user.

**What they CANNOT do today:** open a payment tile (none exists); attach a
receipt to a payment; pick the bank account the money reached; date the
payment; reference an invoice or a request; see any balance (`check_balance`
is admins + `FINANCE_IDS`; `show_ledger`, Supply Ledger, Supply Statement are
admin-only) — except the wrong one via `check_customer`; see the invoice; sign
anything (approve/reject taps are accepted only from env `ADMIN_IDS`,
`approvalEvents.js:1625` — a sheet-promoted admin cannot approve either).

**The role definition the owner must pick** — the two "finance" notions in
code are unrelated:

| Definition | Set where | What it unlocks | Side effect of putting the new person in it |
|---|---|---|---|
| **env `FINANCE_IDS`** (`src/config/index.js:73`; defaults to all admins when empty, `:277-278`) | Railway variable → redeploy | READS: `check_balance`, Payouts/Incentives, container ₦ values (`telegramController.js:4793`, `:6021-6029`; `src/flows/taskFlow.js:133`, `:3117`) | Narrows the default (admins lose balance reads unless listed too). No effect on writing a payment |
| **Users `department` = `Finance`** (`src/services/paymentService.js:34`, `:56-83`) | Users sheet, by hand (owner's rule: the bot never writes it) | Becomes PAY-1's **single Mark-Done hand** for outgoing money — the seat meant for the Office phone (CLAUDE.md PAY-1 row) | A second member degrades every PAY-1 card to all-admins with a warning (`:86-94`). No effect on recording a customer payment |
| **`role = admin`** (env `ADMIN_IDS`) | Railway variable | Approve power; the whole registry as menu | Far more than the job needs; and self-approval guards mean they still could not sign their own payment alone |

Neither list touches Door 1. The gate on recording a payment is, and only is,
the two admin signatures.

---

## 6 · What must be built to "bind this step" — the gaps, in priority order

Named, not designed. Each line says where it lands.

**(a) No-code owner steps**

1. **Rule on §15b for a payment door** — is a tap door for recording a
   customer payment one of the "payment approval cards" the bot keeps, or a
   new bot-side money surface? Everything in (c) waits on this. →
   `docs/BUSINESS_RULES.md` §15b.
2. **Rule on the book of record** — `Ledger_Entries` as the one customer money
   ledger; retire the `/payment` stack (`Ledger_Customers`, `LedgerTransactions`,
   `LedgerBalanceCache`) or declare it. → `docs/SHEET_STORAGE_SPLIT.md`, then
   the schema register. **Note the CLAUDE.md "Sheets the bot uses" list has the
   two ledgers backwards today** (`CLAUDE.md:160-166`): it lists the sale-blind
   `LedgerTransactions` and `LedgerBalanceCache` but omits `Ledger_Entries`
   (the de-facto book), `Ledger_Customers`, `Invoices` and `BranchOpsLog` — all
   four registered in `schemaMapper.js` (`:23`, `:105`, `:151`, `:394`). The
   register must gain `Ledger_Entries` (+ `Invoices`, `BranchOpsLog`,
   `Ledger_Customers`) now and, once the ruling lands, lose
   `LedgerTransactions` / `LedgerBalanceCache` / `Ledger_Customers`.
3. **Onboard the person as an employee** via 👔 Onboard as employee, role
   `employee`, own department; list `upload_receipt` in that department's CSV
   if the evidence door stays. → Users / Departments sheets.
4. **Decide the finance seat** — `FINANCE_IDS` for balance reads (yes if they
   must see what a customer owes), Finance department **no** unless they are
   also to be PAY-1's one hand. → Railway variables / Users sheet.
5. **Tell the two admins the double-count rule until code prevents it**: cash
   taken at sale approval is already booked; the new person records only money
   that arrived *after* the sale card. → a line in the payment card is (b)9.

**(b) Small changes (each a surgical edit behind the existing gate)**

6. **Method mapping** — `transfer` and every bank name must not book as Cash;
   capture the account the money reached (the Upload Receipt door already
   offers `BANK_LIST` + Cash). → `src/services/accountingService.js:68`,
   `src/controllers/telegramController.js:4808` (controller edit: ask first).
7. **Payment date** — a caller-supplied business date, defaulting to today,
   within the `SALE_CALENDAR_MAX_DAYS_BACK` window sales already use. →
   `src/services/accountingService.js:66`, `src/services/crmService.js:48`,
   `src/services/approvalCards.js:488`.
8. **Reference slot** — a place on the payment row for an invoice number /
   request id / receipt id; new columns go at the END of `Ledger_Entries`
   under rule 4. → `src/services/schemaMapper.js:23`,
   `src/repositories/ledgerRepository.js:9-25`, `accountingService.js:74-77`.
9. **Card lines** — the payment card shows "📎 receipt attached / none" and
   "cash already booked at sale approval: ₦…" so the signers can see a
   double-count coming; the lines must render in the 📥 Approvals Inbox
   (💵 Finance, `approvalsInboxFlow.js:83`) as well as in the DM card. →
   `src/services/approvalCards.js:487-498`.
10. **Invoice paid state** — a later payment that references the invoice
    updates its status, or the PDF/web banner stops claiming PAID/UNPAID from
    the frozen snapshot. → `src/services/invoiceService.js:207-209` (and the
    "web view recomputes live" comment at `:156-157`),
    `src/controllers/invoiceWebController.js:50-52`,
    `src/repositories/invoicesRepository.js:8-10`, `:108`.
11. **`Customers.outstanding_balance`** — retire it from every read (or repair
    it on the sale path); gate or drop the outstanding line in
    `check_customer`; the RMV-1 removal card reads `getCustomerLedger` like
    the payment card, and the AuditLog stamp follows. →
    `src/services/crmService.js:53`, `telegramController.js:4782`, `:4800`
    (controller: ask first), `src/services/approvalCards.js:758`,
    `src/services/inventoryService.js:809`.
12. **One `created_by`** — the same identity on all four payment writers. →
    `src/services/inventoryService.js:446`, `:469`, `:1579`, `:706`.
13. **Failure text** — "Check LedgerTransactions" → `Ledger_Entries`. →
    `src/events/approvalEvents.js:1092` (protected file: ask first).
14. **Receipt approval posts, or says it does not** — either an approved
    receipt raises the ledger pair (Door 4 becomes Door 1 with evidence) or
    the approval message states "evidence only — payment not booked". →
    `telegramController.js:9636-9647`.
15. **Remove the dormant bus writer, or route it through the executor** —
    Door 8's `payment_received` listener posts the ledger pair with no
    signatures and no Customers update the day anyone emits it. Delete the
    handler, or make it call the `record_payment` executor, so the new door is
    the ONLY writer. → `src/events/erpEventBus.js:73-78` (event bus: ask
    first).

**(c) A new door (only after (a)1 and (a)2)**

16. **One ➕ Record Payment tile** — flow module + registry entry + one `act:`
    case and prefix block (controller edit: ask first): customer (register
    picker, CUS-1) → amount → account → date → optional receipt photo/PDF →
    optional invoice/request reference → confirm → ONE dual-admin
    `record_payment` request whose executor writes the ledger pair and the
    Receipts row together, and whose card carries the file. → new
    `src/flows/recordPaymentFlow.js` (name indicative), `src/services/activityRegistry.js`,
    `src/controllers/telegramController.js` dispatch, `src/services/inventoryService.js:704`.
17. **Retire the typed-only shape and the `/payment` stack** once the tile
    ships — one door, per the owner's standing "two doors doing one job" rule.
    Delete the direct-write tails at `telegramController.js:175-176` and
    `:4840-4841` in the same change (§4 defect 10), so no signature-free
    writer survives the retirement. → `src/commands/ledgerCommands.js`,
    `src/ai/intentParser.js:77` (enum change needs sign-off, rule 3),
    `src/controllers/telegramController.js` (ask first).
18. **Marketer receivable** — a ruling first (§8 Q7); if a marketer is to be
    invoiced and paid, they need a Customers row or a new receivable. →
    `docs/BUSINESS_RULES.md` §16.

---

## 7 · Currency display — groundwork only

**Where ₦ is decided today.** One helper module owns the two shapes:
`fmtMoney` → `NGN 1,500` (code + space) and `fmtMoneyShort` → `₦1,500`
(symbol), both from `config.currency` = env `CURRENCY`, default `NGN`
(`src/utils/format.js:19-56`; `src/config/index.js:91`). Beside it, the
symbol is hardcoded in seven local re-implementations and dozens of inline
literals — on the order of a hundred sites across ~25–35 files under `src`
(`grep -rn '₦' src --include=*.js` → 99 hits / 25 files; widened to
`₦|fmtNgn|fmtNaira|ngn(|'NGN'` → ~150 / 33; CUR-1 produces the
authoritative list):

| Area | Where the symbol comes from | Count / anchors |
|---|---|---|
| **Sale invoice PDF** | file constant `NGN = '₦'`, cells bare via `fmtQty` aliased as `fmtMoney` | 9 sites — `src/services/invoiceService.js:27`, `:32`, `:230-233`, `:242-243`, `:260`, `:289`, `:306` |
| **Invoice web view `/i/<token>`** | local `fmtMoney` → `₦` with 2 decimals | 7 sites — `src/controllers/invoiceWebController.js:38-39` |
| **Sale approval cards + enrichment wizard** | inline `₦` + `toLocaleString('en-NG')`; two closures use the code form | `approvalCards.js:453-461`, `:488-494`; `approvalEvents.js:359`, `:627`, `:646`, `:695`, `:753-754` |
| **Inventory-affecting outputs** (return credit notes, price update, edit bale, stock value) | `inventoryService.fmtNgn` (`:47`) hardcoded; controller uses helper code/symbol forms | `fmtNgn` call sites `inventoryService.js:495`, `:517`, `:647` (the only three); `telegramController.js` 55 `fmtMoney(` + 15 `fmtMoneyShort(` call sites (`grep -o`) |
| **Landed cost / GRN finalization** | inline `₦` literal in the `finalize_landed_cost` executor message | `inventoryService.js:1223` — which side of §17 this falls on is itself open (it changes no Inventory rate directly) |
| **Ledger narrations (persisted text)** | `CURRENCY` code written INTO `Ledger_Entries` rows | `accountingService.js:12`, `:32`, `:71` |
| **Payment door surfaces** | payment card `₦` inline; receipt flow literal `NGN` | `approvalCards.js:488`; `telegramController.js:3603`, `:3627`, `:3646`, `:9642-9647` |
| **Expenses (EXP-1, PAY-1, reports)** — keep `₦` per §17 | all hardcoded `₦` (`fmtNgn`, `fmtNaira`, `ngn`, inline) | `officeExpenseFlow.js` 17 `₦` literals, `paymentService.js:37-40`, `eveningExpenseReport.js:61`, `dailyBranchOpsFlow.js` 8, and the `record_office_expense` batch-approval message `inventoryService.js:1207` (inline `₦`, expense side) |
| **Inventory sheet itself** | none — `pricePerYard` is a bare number, no currency column | `src/repositories/inventoryRepository.js:99` |

**What the ruling (§17) touches vs leaves.** Touches: the invoice PDF and web
view; every output of an update that changes the Inventory sheet (rates on
sale cards, return credit notes, price updates, edit-bale, stock valuations)
— today a mix of one constant, one helper and inline literals. Leaves: the
expenses side, which is already uniformly `₦` and hardcoded, so it needs no
change to comply. Undecided in §17 itself, and directly relevant to this
door: which side the **payment approval card**, the **receipt flow** and the
**persisted ledger narrations** fall on — a customer payment is sale-side
money but changes no Inventory row.

The deep research that produces the surface list, the blank-`CURRENCY`
semantics and the narration decision (CUR-1) comes in the next turn.

---

## 8 · Questions for the owner

1. **Is a tap door for recording a customer payment allowed under §15b?**
   Recommended: yes — it is a *payment approval card* (a surface the bot
   keeps), not a list, queue or report; record the reading in §15b.
2. **Which ledger is the book of record?** Recommended: `Ledger_Entries`;
   retire the `/payment` / `Ledger_Customers` stack in the storage split.
3. **Should the Upload Receipt door keep existing as evidence-only, or become
   the "with receipt" branch of the one payment door?** Recommended: fold it
   in — one door, receipt optional; keep the tile only as a redirect.
4. **Is the receipt optional on a booked payment?** Recommended: yes ("with or
   without the receipt" — the owner's words); the card says which.
5. **Does the new person's payment stay dual-admin?** Recommended: yes (§13
   "all financially related transactions"); their own entry is the request,
   never a signature.
6. **Is a negative outstanding the right picture of an advance, or should an
   advance carry its own label?** Recommended: keep the single receivable and
   the negative figure (simplest, already how every ledger surface reads) and
   label it "advance" on the card only.
7. **Marketers: does "invoice / payment against the marketer" mean the
   marketer becomes a Customers row, or a separate marketer receivable?**
   Recommended: a Customers row per marketer who buys — keeps one ledger and
   one invoice path; §16's commission rule is unaffected.
8. **Should a payment reference the invoice number / request id when it
   settles one?** Recommended: optional reference, end-column on
   `Ledger_Entries`; never required (an advance has nothing to reference).
9. **Should a payment carry its real date?** Recommended: yes, within the
   `SALE_CALENDAR_MAX_DAYS_BACK` window sales already use.
10. **Should a later payment mark the invoice PAID, or does the website own
    invoice state?** Recommended: the bot updates `Invoices.status` from the
    referenced payment; the banner stops reading the frozen snapshot.
11. **`Customers.outstanding_balance` — retire or repair?** Recommended:
    retire from every read; the ledger figure is the only outstanding.
12. **Who is the new person in role terms?** Recommended: `employee`, own
    department (e.g. Accounts), in `FINANCE_IDS` for balance reads, **not** in
    the Finance department (that seat is PAY-1's one hand for the Office phone).
13. **Which side of §17 do the payment card, receipt flow and ledger
    narrations fall on?** Deferred to CUR-1; the recommendation will come with
    the surface list.
14. **Is a Telegram `file_id` acceptable evidence storage until the Drive
    quota (BKP-1) is solved?** Recommended: yes for now — the Receipts sheet
    already keeps it, and the Drive copy stays best-effort.

---

*Verified against `origin/main` at `1347af43` (08-Sep-2026); revised the same
day after a second read against the code. Not checked offline: live rows in
`Ledger_Customers` / `Receipts`, whether the live Departments sheet still
matches the seeded Sales CSV for `upload_receipt`, whether Drive uploads
currently succeed in production.*
