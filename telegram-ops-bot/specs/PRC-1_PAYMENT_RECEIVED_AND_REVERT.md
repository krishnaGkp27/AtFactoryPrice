# PRC-1 + REV-1 — the tap doors for a customer's payment and a sale's revert

Shipped 11-Nov-2026 with APG-1 phase 3 (owner: "Go with all the remaining
phases").

## 1. Why

TXT-1 (01-Nov-2026) stopped the AI reading a typed sentence for anything
that changes the sheet. Two things then had no door at all:

| What | The typed sentence it needed | Since 01-Nov |
|---|---|---|
| A customer pays against what they owe | "Record payment 50000 from Ibrahim via bank" | no door |
| An approved sale must be undone | "Revert last transaction" (the LAST one only) | no door |

The owner's ruling that day: no typed payment line — wait for the tap door.

Both doors raise the **same request types** the typed lines raised
(`record_payment`, `revert_sale_bundle`): same executors, same approvals. No
action code, sheet or column was added.

## 2. PRC-1 — 💰 Finance → 💵 Payment Received

| Step | Screen |
|---|---|
| 1 | `💵 Payment received` · `Who paid?` · eight customers a page, A–Z, `◀ Back` / `Next ▶`. Typing part of a name narrows the list. Removed, merged and pending customers are not offered. |
| 2 | `Customer: ABBA` · `How much did they pay?` Typed: `50000`, `50,000`, `50k`, `1.5m`. |
| 3 | `How was it paid?` · `💵 Cash` · one `🏦 <bank>` chip per bank in Settings `BANK_LIST`. |
| 4 | Customer, amount, paid by, date · `✅ Submit for approval`. |
| 5 | `⏳ Sent for approval` · `🔔 Remind approvers` · `📋 Status`. |

- **One request per confirm.** The id is minted when the confirm card is
  drawn; a second Submit tap is the same request.
- **A bank chip is stored as `Bank — Zenith`.** The ledger sends a method
  with the word "bank" to the Bank account and anything else to Cash. The
  typed line sent "Paid to Zenith" to Cash (bale-yards check, item A6). This
  door cannot make that mistake.
- **The sale wizard's bank chip reaches the Bank ledger too (11-Nov-2026).**
  A mode shaped `Paid to <bank>`, or naming a `BANK_LIST` bank in any case, is
  booked to Bank (`accountingService.paymentAccountFor`); `Cash` and other free
  text are as before. The stored mode text is unchanged; no posted row is moved.
- **No balance on the entry screens.** Customer outstanding is admins-only
  (FIN-V2). The admin's approval card shows `Outstanding today` and
  `After this payment`, and warns when the payment exceeds the balance.
- **Approval:** one admin, never the requester (`record_payment` is in
  ALWAYS_APPROVAL_ACTIONS). On approval the ledger is credited and the
  customer's outstanding falls.
- **Who sees the tile:** departments whose `allowed_activities` include
  `payment_received`; admins always.

## 3. REV-1 — 🛂 Approvals → ✅❌ Decided → the sale → ↩️ Revert this sale

- Shown to **admins only**, on the record of an **approved sale**.
- The record says where the sale stands: the button, or
  `↩️ A revert is waiting for approval · R-XXXX`, or
  `↩️ This sale was reverted · <date>`.
- The button **asks first**: `↩️ Revert this sale?` with the sale card and
  what will happen. `↩️ Yes, ask for the revert` raises the request.
- The record and the `Revert this sale?` card list the goods **as the
  request recorded them** (described from Inventory rows of any status) and
  carry no live-stock warning and no `half-done run` line — those belong to
  a pending sale only (FIX-INBOX, 11-Nov-2026).
- **Two admins approve**; the requester cannot approve their own.
- **One revert per sale.** A second request for the same sale is refused
  while the first is open, whoever asks (registry rule, key = the sale's
  request id). After an approved revert the button is gone for good.
- The request carries the customer, the goods (`2B + 1t · 450 yd`), the sale
  date and reference, so two reverts never read the same on an admin card.
  The typed line's card read only "revert sale bale".
- Unlike the typed line, any approved sale inside the Decided window
  (Settings `APPROVALS_DECIDED_DAYS`) can be reverted, not only the last
  transaction.
- An approvals record that cannot be read offers no button (fail-closed).

## 4. The typed handlers

Still in the code, reachable only when `AI_TEXT_PARSER` is not `0`, and now
raising through the gate. Delete them on the owner's word after the typed
census (`npm run insights -- typed`).

## 5. Live check

1. 💰 Finance → 💵 Payment Received → type part of a test customer's name →
   tap them → `5000` → `🏦 <a bank>` → the confirm card reads
   `Paid by: Bank — <bank>` → ✅ Submit.
2. An admin's phone gets `Record Payment Request` with the outstanding
   before and after. Approve it. The customer's statement shows the credit
   under Bank.
3. Tap ✅ Submit twice quickly on a second payment: one card reaches the
   admins.
4. 🛂 Approvals → ✅❌ Decided → open an approved test sale →
   ↩️ Revert this sale → Yes. The other two admins get `↩️ Revert sale` with
   the customer and goods. Open the sale's record again: it reads
   `A revert is waiting for approval`, and there is no button.
5. Two admins approve. The bales are available again, the customer's
   statement loses the sale, and the record reads `This sale was reverted`.
