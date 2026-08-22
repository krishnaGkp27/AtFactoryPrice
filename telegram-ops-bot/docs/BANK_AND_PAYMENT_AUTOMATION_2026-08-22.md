# What a bank entry actually does — and every automation around money

**Investigation, 22-Aug-2026.** Four-agent trace of the whole money path,
prompted by the owner's question: *"once I add the bank and the account
name, how is it going to integrate and work inside the bot? Which type of
automation will I be receiving?"* (raised when a worker found no O-Pay
option in payment-account registration).

Everything below is from reading the code, not from the specs' promises.
Where the two disagree, that is called out.

---

## 1 · The one-line answer

Adding a bank to `BANK_LIST` creates a **label**, not a connection. The
bot has no link to any bank or fintech; it never checks a balance, never
verifies an account number, and never moves money. That is not a gap —
it is BUSINESS_RULES §13, locked by the owner: *"The bot never moves
money. A human transfers it at the bank; the bot records the request,
the approvals, and that the transfer happened."*

What the entry buys is that the name becomes **selectable**, and every
record made against it is tracked, dual-approved, routed and reported.

## 2 · Where a BANK_LIST entry travels

`BANK_LIST` is a comma-separated free-text cell in the Settings sheet
(seeded `GTBank,Zenith,FirstBank,Access,UBA` — `schemaMapper.js:711-721`).

**Three writers:** the seed; the tap flow 🏦 Manage Banks
(`telegramController.js:840-900`, two steps → `BANK — ACCOUNT`, queued as
`add_bank` for approval); and the typed intent `Add bank X`
(`telegramController.js:4883-4909`) which writes Settings **directly**.

**Two readers — the only places a bank is ever picked:**

| Where | Code | Produces |
|---|---|---|
| Disbursal: 💳 Payments → Register account → "Which bank?" | `paymentFlow.js:165-184` | `session.reg.bank` |
| Inbound: sale approval enrichment, Step 3 | `approvalEvents.js:281-286, 638-645` | `Paid to <entry>` |

**Where the string lands afterwards:** PaymentAccounts col F (at
registration) · PaymentRequests col F (snapshotted at raise,
`paymentFlow.js:338`) · Transactions col N PaymentMode · Invoices
`payment_mode` + `bank` · the sale's Ledger_Entries **narration**.

**Every later read is cosmetic — with one exception.** The single
functional use is `paymentAccountsRepository.findLive` (lines 126-133),
which lowercases the bank and compares it with the account number to stop
the same number being registered twice at the same bank. A string
equality test against other rows in our own sheet — not a bank register.

Nothing validates the string against anything real. Removing a bank from
Settings leaves every registered account and every historical row intact
and still payable.

## 3 · ⚠️ CONFIRMED DEFECT — most bank payments are filed as Cash

`accountingService.js:68` chooses the ledger account with a substring test:

```js
const cashOrBank = (method || '').toLowerCase().includes('bank') ? 'Bank' : 'Cash';
```

The payment mode reaching it is `Paid to <entry>` (`approvalEvents.js:842`).
So the chart of accounts (1001 Cash / 1002 Bank, `schemaMapper.js:13-14`)
is filled like this:

| Payment mode | Contains "bank"? | Filed as |
|---|---|---|
| Paid to GTBank | yes | ✅ Bank (1002) |
| Paid to FirstBank | yes | ✅ Bank (1002) |
| Paid to Zenith | no | ❌ **Cash** (1001) |
| Paid to Access | no | ❌ **Cash** (1001) |
| Paid to UBA | no | ❌ **Cash** (1001) |
| Paid to Opay / Moniepoint / Kuda | no | ❌ **Cash** (1001) |

**Three of the five seeded banks already misfile, and every fintech will.**
Customer totals are unaffected (the receivable leg is correct, so
outstanding balances are right) — what is wrong is the *cash-vs-bank
split* of the asset side.

Today nothing in the bot displays that split, so the error is invisible
and purely latent. It stops being latent the moment the **website finance
portal** (§15b) reads this ledger — which is the owner's stated plan.
Recommended fix: match the picked bank against `BANK_LIST` (a listed bank
is a bank; only literal `Cash` is cash) rather than sniffing for the
letters "bank". One-line change, needs an owner ruling because it is
money semantics — and a decision about the rows already written.

## 4 · The payment lifecycle — who taps what

1. **Register the account, once** (§13: *"registered once, then only ever
   PICKED"*). Employee registers their own; an admin registers a
   contractor's. Number typed **twice** (`paymentFlow.js:520-544`), bank
   picked from the chips, then **two distinct admins** approve
   (`register_payment_account` is in `ALWAYS_APPROVAL_ACTIONS` **and**
   `DUAL_ADMIN_ACTIONS`). Only then does it appear in any picker.
2. **Raise** — 💸 Request payment. The account is *picked*, never typed.
   An employee sees only their own accounts; an admin also sees
   contractors'. Never another employee's (§13 "Self only").
3. **Two admins approve** the request (`request_payment`, dual-admin).
4. **The bot hands it to a human** — `approvalEvents.js:1923` sends the
   finance card to the single active **Finance** member of the Users
   sheet; if that cell names zero or several people it degrades to **all
   admins plus a warning** (still the live state — the owner's open task).
5. **A person walks to the bank / opens their banking app and transfers
   the money.** The bot is not involved.
6. **Mark Done** — writes `status:'done'` + `done_by` + `done_at`, and
   DMs the raiser "✅ Paid". Finance may instead **Decline** with a
   reason, which reaches the requester (§13 "Approved ≠ paid").

₦50,000 (`PAYMENT_THRESHOLD_NGN`) **badges, it does not gate** (§13).

## 5 · Every automation that touches money

### Scheduled (fires on a clock)

| Job | When | To whom | Default |
|---|---|---|---|
| **EXP-1 office-expense report** — day's allowances / office items / commissions / cash-in, spend, balance in hand, "N awaiting sign-off" | 20:00 Lagos | **all admins** (not the finance hand) | `EXPENSE_REPORT_ENABLED` = **1 ON** |
| **EXP-1 nothing-filed reminder** — "File it" / "Nothing spent today" chips | 20:00 Lagos | that branch's recent filers | same key |
| **Approval reminder** — re-sends the original card, "still waiting", live buttons. **Covers pending payment approvals.** | every ~6 h | all admins except the requester | `REMINDER_HOURS_ADMIN`, else `APPROVAL_REMINDER_HOURS` = **6** |
| **Morning digest** | 10:00 Lagos | all admins | `DIGEST_ENABLED` = 1, but **no money category exists**; `DIGEST_APPROVALS` = **0 OFF** |
| **Order reminder** (mentions `Payment: PAID/UNPAID`) | hourly sweep | the order's salesperson | needs `REMINDER_HOURS.<Dept>` — **absent = OFF** |
| **Consistency Sentinel** | 20:00 Lagos | all admins | `SENTINEL_ENABLED` = 1 — **all eight checks are stock/queue; none touch money** |

### Event-driven (a human tap is always the trigger)

- **Finance card** the instant a payment clears dual-approval.
- **Requester DMs** on Mark Done ("✅ Paid — ₦X was sent to …") and on Decline with the reason.
- **`payout.paid` broadcast** to admins when a task incentive is marked paid.
- **VRF-1 bill OCR** on sale approval cards — `PDF_VERIFY_ENABLED` = 1, **spends real API credit**, capped `OCR_DAILY_CAP` = 100/day, narrowed to warehouse + bale-bearing sales (§9b).
- **Outstanding balance** printed on payment/removal cards, with "⚠️ Payment EXCEEDS the outstanding balance" — disclosure, never a block (§14).
- **Spend ceilings** (`usageMeterService.reserve`, fail-closed) — the only automatic guards that stop money going out, and the money is API credit, not the business's cash.

### The line, stated plainly

Every automation above is **the bot telling a human to do something**.
Nothing in this codebase initiates, schedules, batches, retries or settles
a transfer. The whole of a "payment" in code is a sheet cell moving from
`approved` to `done` plus an audit row — recording that a human says they
moved money.

## 6 · What does NOT exist (assume none of it)

- **No bank or fintech connection.** `src/integrations/banking/` is a
  complete scaffold — `stub` (default, 3 fake transactions), `zenithBank`
  (throws `BANKING_NOT_WIRED` *even with credentials*), `mono` (real HTTP,
  but no caller and its documented env key `BANKING_MONO_ACCOUNT_ID`
  doesn't exist in config). `require('../integrations/banking')` appears
  **nowhere** outside the folder and the smoke harness.
- **No account-number verification.** Validation is a 10-digit length
  check (`paymentService.js:161-168`). No NUBAN checksum, no name
  enquiry — a transposed digit passes, and the payee name is never
  checked against the bank's records. §13's answer is procedural: type
  the number twice, at registration.
- **No reconciliation.** `bankReconciler.js` is a tested matching engine
  with **zero callers**, no feed in (`bankFeedRepository.upsert()` is
  never called; the BankFeed sheet is created and stays empty), and its
  gate `confirm_bank_reconciliation` has no producer and no executor.
- **No reminder for an approved-but-unpaid payment.**
  `paymentRequestsRepository.awaitingPayment()` — "the finance head's
  queue" — is exported and called by **nothing**. Miss the finance DM
  card and the payment is unreachable, forever. This is exactly the
  failure APX-1 fixed for approvals.
- **No scheduled payment reporting** of any kind — no paid-today summary,
  no backlog line, no spend-by-payee, no bank balance.
- **No receivables/overdue/credit-limit alert** — deliberate: §15b puts
  customer money on the website.
- **No backup of the money sheets.** `SHEET_BACKUP_ENABLED` = 0 (BKP-1,
  Drive quota) — PaymentRequests, PaymentAccounts, the ledgers and
  AuditLog have no scheduled snapshot at all.

## 7 · Other findings worth an owner ruling

1. **Typed `Add bank X` bypasses dual-admin.** `add_bank` is in
   `DUAL_ADMIN_ACTIONS`, but the NL path
   (`telegramController.js:4883-4896`) writes Settings directly for any
   admin. The tap flow correctly queues an approval. Known hole
   (`docs/DATA_COLLECTIONS.md:791`); the gate is real only on one door.
2. **Cash INTO the float is ungated.** `branchOpsService.recordCashIn()`
   appends `status:'logged'` with no approval, while expense outflows are
   dual-admin. That unreviewed figure is the positive term in the
   "Balance in hand" the 20:00 card reports. No rule covers it.
3. **Two definitions of "finance".** Payment cards resolve the Finance
   *department*; the 20:00 "finance report" loops **all admins**.
4. **`reminderPolicy`'s docs contradict its code** — the header says
   "off by default", but `hoursForAdmin()` falls back to an in-code
   default of 6 hours.
5. **The bank string is never re-validated** — removing a bank from
   Settings does not disturb accounts already registered against it.

---

*Sources: `paymentFlow.js`, `paymentService.js`, `paymentCards.js`,
`paymentAccountsRepository.js`, `paymentRequestsRepository.js`,
`accountingService.js`, `ledgerRepository.js`, `approvalEvents.js`,
`inventoryService.js`, `evaluate.js`, `eveningExpenseReport.js`,
`approvalReminder.js`, `morningDigest.js`, `consistencySentinel.js`,
`src/integrations/**`, `server.js`, `docs/BUSINESS_RULES.md`.*
