# BANK-4 — account chips under a bank

Shipped 17-Nov-2026.

## 1. The owner's words

On a screenshot of the sale approval wizard's Step 3 (Cash · Not yet paid ·
GTBank · Zenith · FirstBank · Access · UBA · OPAY):

> "I have 2 accounts in zenith bank whose abbreviation needs to be used to
> capture the payment in particular account for accounting. Let me know your
> proposal to add further chips when I select particular bank."

The proposal went back with six doubts, each with a recommendation. The
owner: **"Go with all your recommendations."**

## 2. What was there before

- 🏦 Manage Banks could already store two accounts under one bank (BANK-2):
  the bank, then an account name, kept as one entry `Zenith — AFP`.
- Every entry was its own flat chip. The owner's list held plain banks
  only, so Zenith was one chip and the account was never asked.
- The ledger booked every bank payment as `via Bank`, code 1002. The bank
  the admin tapped was kept on the Transactions row and the invoice, never
  on the ledger row.

## 3. What was built

### The chips

Step 3 shows **one chip per bank**.

| The bank has | Its chip | A tap does |
|---|---|---|
| no account under it | `🏦 GTBank` | stores `Paid to GTBank`, as before |
| one account | `🏦 UBA — MAIN` | stores `Paid to UBA — MAIN`, no second screen |
| two or more | `🏦 Zenith ▾ 2` | redraws the same card with the accounts |

The second screen:

```
📋 Confirm sale — R-XXXX
👤 ABBA

Step 3 — Payment mode
🏦 Zenith · which account?

[🏦 AFP]        [🏦 BP]
[⬅ Back to payment modes]
```

A tap on an account stores `Paid to Zenith — AFP` and moves to Step 4.
Nothing is stored until an account is tapped. There is no "account not
known" chip: a bank that holds accounts is never saved without one.

### Typed replies

| Typed at Step 3 | Result |
|---|---|
| `Paid to Zenith` | the account chips are shown; nothing is stored |
| `Paid to Zenith AFP` or `Paid to Zenith — AFP` | stored as registered |
| `Zenith` or `GTBank` alone, a registered name without `Paid to` | read as paid to it (account chips for Zenith). Before, the bare word was stored and the sale sealed as unpaid |
| `AFP` while the account chips are open | that account |
| any other word while the account chips are open | refused with a line on the card; the sale is not sealed under it |
| `Cash`, `Not yet paid`, an unlisted bank | exactly as before |

### The ledger

`accountingService.recordPaymentReceived` reads the account from the stored
payment mode (`bankEntry.destinationOf`).

- The account code stays **1002** and the ledger name stays **Bank**. Every
  existing total, the daybook and the trial balance are unchanged.
- The narration ends with the account: `Payment received from ABBA: NGN
  50000 via Bank · Zenith — AFP`.
- **One new last column on Ledger_Entries: L `bank_account`.** It is filled
  on the Bank row of a received payment and left blank on every other row.
  Filter L in the sheet to total one account.

What the cell holds:

| Stored payment mode | Column L |
|---|---|
| `Paid to Zenith — AFP`, `Bank — Zenith — AFP` | `Zenith — AFP` |
| `Paid to GTBank` | `GTBank` |
| `Paid to Zenith` (an old request, two accounts now) | `Zenith` |
| `Paid to <a bank not on the list>` | the text as written |
| `bank transfer` | blank |
| `Cash` | blank |

An account the text does not name is never guessed.

### The other screens that read the bank list

| Screen | Change |
|---|---|
| 💵 Payment Received | the same two levels; stores `Bank — Zenith — BP` |
| 📦 Supply Request, payment chip (the requester) | each bank once; the admin picks the account at approval |
| 💳 Payments → Register account (a payee's bank) | each bank once; a company account is never a payee bank |
| 🏦 Manage Banks | unchanged: every entry listed, each removable |
| Outgoing payments, "Pay from which account?" (PAY-6) | unchanged in code. See §5. |

## 4. Where it lives

| Piece | File |
|---|---|
| Grouping, the one-option rule, typed reading, the ledger's account | `src/utils/bankEntry.js` (`group`, `banksOnly`, `choiceFor`, `resolve`, `destinationOf`) |
| Wizard Step 3 | `src/events/approvalEvents.js` (`sendPaymentStep`, `sendBankAccountStep`; chips `enr:q:<id>:pay:b:<bank>` · `pay:a:<bank>:<account>` · `pay:modes`) |
| Payment Received | `src/flows/paymentReceivedFlow.js` (`renderAccount`; `prc:ma:<bank>:<account>`, step `method_account`) |
| Ledger | `src/services/accountingService.js`, `src/repositories/ledgerRepository.js`, `src/services/schemaMapper.js` |
| Requester and payee pickers | `src/services/salesFlowService.js`, `src/flows/paymentFlow.js` |

No new Settings key. No new action code. No change to who approves.

## 5. Owner steps

1. **Add the two accounts.** 🏦 Manage Banks → ➕ Add New Bank → type
   `Zenith` exactly as the existing chip reads → type the abbreviation.
   Repeat for the second account. Each is approved by two admins. The plain
   `Zenith` entry may stay or be removed: either way Step 3 shows one
   Zenith chip.
2. **Outgoing payments.** Named entries on the bank list are also what the
   last approver of an outgoing payment is offered under "Pay from which
   account?" (PAY-6). With the two Zenith accounts listed, that question
   will appear with those two. If payments go out from other accounts, type
   them in Settings `PAYMENT_SOURCE_ACCOUNTS`. To switch the question off,
   type `0` there.
3. **The sheet.** After the deploy the Ledger_Entries sheet gains exactly
   one header cell, L1 = `bank_account`. No data row moves.

## 6. Live check

1. Approve a small sale. At Step 3 tap `🏦 Zenith ▾ 2`, then an account.
   Step 4 reads `· Paid to Zenith — <abbr>`.
2. Finish the wizard with an amount. In Ledger_Entries the new Bank row
   ends its narration with `· Zenith — <abbr>` and carries the same text in
   column L. The Customer Receivable row beside it has L blank.
3. Approve a second sale and type `Paid to Zenith`. The account chips
   appear. Type a wrong word: the card says it is not an account.
4. 💰 Finance → 💵 Payment Received → a customer → an amount → `🏦 Zenith ▾
   2` → the other account → submit. The approval card reads `Paid by: Bank
   — Zenith — <abbr>`.
5. 📦 Supply Request, payment step: Zenith is one chip.
6. Open the sale's invoice. The payment line names the account (`paid to
   Zenith — <abbr> account`). Say if the customer copy should show the bank
   alone.

## 7. Not done

- **No back-fill.** Earlier Zenith payments keep `via Bank` and a blank L.
- **No ledger account per bank account.** One code, 1002. Separate codes
  (a true sub-ledger per account) would be a chart-of-accounts change.
- **No per-account total in the bot.** The column is there to filter in
  the sheet; a daybook line per account can be added on request.
- **A typed word that names no registered bank** at Step 3 (`Credit`,
  `transfer`) is still stored as written and treated as unpaid, as before.
