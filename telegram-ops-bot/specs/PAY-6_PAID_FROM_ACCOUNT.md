# PAY-6 — the paying account on every payment (From and To together)

Owner, 11-Nov-2026: "the account through which the payment will go through shall
also be mentioned with the bank name, so that each transaction is clubbed with the
source and the recipient, both visible to Financer (the person who will pay)."

Rulings the same day (asked, answered):
1. WHO decides the paying account: **the admin who gives the last approval.** Finance
   is told which account to pay from and cannot change it.
2. The list of company paying accounts: "It will be maintained through name, later
   will be shown as qr code information when tapped on chips. But this will be
   polished later." -> kept BY NAME for now (bank + account name, no number); the
   QR / detail-on-tap is a later release and is NOT built here.
3. Recorded on the payment in **one new last column** of the PaymentRequests sheet
   (owner's go). No existing column moves.

SHIPPED 11-Nov-2026. Code: `paymentService.sourceAccounts` / `sourceAccountKey` /
`resolveSourceAccount`, `paymentCards.buildPayFromPicker` / `payFromStep`, the seam in
`approvalEvents.handleApprovalCallback`, `paymentFlow` (`pay:from:` / `pay:fromx:`),
the `request_payment` executor in `inventoryService`, `paymentRequestsRepository`
column T. Tests: `test/unit/services/paymentPayFrom.test.js`,
`test/characterization/paymentPayFrom.test.js`, and the PAY-6 cases in
`test/unit/services/paymentApproval.test.js` and
`test/unit/repositories/paymentRequestsRepository.test.js`.

## 1. The paying accounts (by name)

`paymentService.sourceAccounts()` -> an ordered list of `{ label, bank, account }`,
never throws:
- Settings `PAYMENT_SOURCE_ACCOUNTS` (new key, text, default blank). Entries are
  separated by `;`, a new line, or a comma. Each entry is written the way the house
  already writes a company bank account, `BANK — ACCOUNT NAME` (the grammar of
  `src/utils/bankEntry.js`; a hyphen is read as the dash; a plain name with no dash
  is accepted as written).
- When that cell is blank: the entries of Settings `BANK_LIST` that NAME an account
  (`bankEntry.parse(bankEntry.normalize(entry)).account` is not empty, e.g.
  `ZENITH — BLACK PANTHER`). Plain bank names (`GTBank`, `Zenith`, ...) and the
  BANK-3 form `OPAY — OPAY` are payee banks, not company accounts, and are never
  offered. These named entries are already maintained in the bot through 🏦 Manage
  Banks, behind approval.
- De-duplicated with `bankEntry.key`; `label` is `bankEntry.normalize(entry)`.
- A Settings read that fails is an empty list (the Settings reader itself answers
  its in-code defaults on a failed read): the approval then runs as with no account
  configured.
- The new key has a class (text) in test/unit/repositories/settingsBlankCells.test.js
  and a DEFAULTS entry ('').

## 2. The picker — on the completing approval only

In `approvalEvents.handleApprovalCallback`, for action `request_payment` only, at
the point where the tap is known to be the COMPLETING signature and nothing has been
written, answered or edited yet (after the two-admin gate, before the `Approving...`
toast and the keyboard wipe; outside the gate's try/catch). The seam calls
`paymentCards.payFromStep` and returns when it answers `ask`.

| Accounts configured | What happens on ✅ Approve |
|---|---|
| 0 | Exactly as before PAY-6. No From anywhere. |
| 1 | That account is stamped without asking (one-option navigation). |
| 2 or more | A NEW message with the picker is sent, the tap is answered with the toast `Choose the account to pay from.`, and the handler returns. **Nothing is approved, written or logged.** The approval card keeps its buttons. |

The picker (text built in paymentCards.js — the naira sign lives on side A):

```
💳 *Pay from which account?*
₦25,000 → Abdul · 0123456789 · GTBank
📝 Transport to Idumota

_You are giving the last approval. Finance will be told to pay from the account you tap._
[ 🏦 ZENITH — BLACK PANTHER ]
[ 🏦 GTBANK — BLACK PANTHER ]
[ ✖ Not now ]
```

(The `📝` line is printed only when the request has a reason.)

- Chip: `pay:from:<requestId>:<key>`; `key` = `<index>.<6 hex>` — the entry's
  position plus a short fingerprint (SHA-1 of `bankEntry.key(label)`) — so a list
  edited between the picker and the tap can never stamp a different account. ASCII;
  55 bytes at most with a 36-character request id and a two-digit index.
- A key that no longer resolves (the entry at that position is not that account any
  more) approves nothing: the tap is answered `That list has changed — pick again.`
  and the picker message is redrawn IN PLACE with a first line
  `⚠️ That list has changed — pick again.`, a blank line, then the picker as above
  with the list as it now stands — also when only one account is left (the remaining
  account is never stamped in the other's place). If the list is now EMPTY the tap is
  answered `Nothing was approved.` and the picker message becomes
  `That list has changed — no paying account is listed any more.` /
  `Nothing was approved. Tap ✅ Approve on the request again.` with no buttons.
- A key that resolves is honoured whatever the list's length is by then.
- `✖ Not now`: `pay:fromx:<requestId>` — the picker message becomes
  `Nothing was approved. The request still waits for its last approval.` with no
  buttons. Session-free; nothing was written when the picker was drawn, so nothing
  is undone.
- Both are session-free and ride the existing `pay:` route (paymentFlow), so the
  controller is not touched.
- A chip tap does not approve by itself. It re-enters `handleApprovalCallback` as an
  `approve` tap by the same admin carrying the key (the new optional fourth
  parameter, `{ payFromKey }`), so EVERY existing guard runs again (admin, still
  pending, not own request, not already signed, two-admin count). The chip handler
  does not answer the callback; the approval handler does. A stale picker after
  someone else decided answers `Already approved — nothing to do.` (or
  `Already rejected — nothing to do.`) and loses its buttons, as any stale approval
  card does.
- The chosen account travels to the executor as a parameter
  (`executeApprovedAction(requestId, adminId, { payFrom })`) and is stamped inside
  the executor's per-request lock together with the approval — never written before
  the guards have passed.
- If the picker cannot be drawn (Telegram refuses the message) the approval stops:
  the tap is answered with the alert
  `⚠️ Could not show the paying accounts — nothing was approved. Tap ✅ Approve again in a minute.`
  A payment with a paying account to choose is never approved without the choice.

## 3. What is recorded

- PaymentRequests column **T `paid_from`** (one trailing header cell; added the way
  column S `reason` was; text snapshot of the label, e.g. `ZENITH — BLACK PANTHER`).
  Written by the `request_payment` executor in the SAME row write (one batch call)
  that sets `approved` and the approver pair. History is snapshot, not looked up.
  `update()` writes T only when the patch names it; Mark Done, Decline and the proof
  never touch it. A live 19-column sheet is widened by the one header cell `T1`.
- ApprovalQueue `actionJSON.payFrom = { label, by, at }` (best-effort, in the same
  row write as the PAY-4b `approverIds`), so the inbox record can print it. `by` is
  always the admin the executor ran for — the completing approver.
- `payment_events` `approved` detail carries the label as `paid_from` (no new event
  kind, no migration).
- `paymentService.approverIdsFor` also counts `payFrom.by` (the completing admin) —
  four eyes is not weakened and gains one more durable source.

## 4. Every card that shows it

Only when the payment HAS a paid-from account; a payment without one prints exactly
what it printed before (so every existing pin still holds).

| Card | With a paid-from account |
|---|---|
| Finance card (first send, reminder re-send, opened from 💳 Waiting for me to pay) | the payee line `🏦 0123456789 · GTBank` becomes two lines: `📤 From: ZENITH — BLACK PANTHER` / `📥 To: 0123456789 · GTBank` |
| The approving admin's result and the requester's closing card (the executor's note) | `... — now with finance to pay.` gains ` Paying from ZENITH — BLACK PANTHER.` |
| Paid notice (plain text: requester + both approvers) | one more line `From: ZENITH — BLACK PANTHER` directly above the payee account line |
| Finance's own `✅ Paid` confirmation | the same From line, directly under the first line |
| 🛂 Approvals → 💳 Payments record: the status line (`With finance to pay` / `Paid by ...`) | ` · from ZENITH — BLACK PANTHER` at the end of the line |
| 🛂 Approvals record body (rebuilt from the queue payload) | `Paid from: ZENITH — BLACK PANTHER` under `Account:` |

Not changed: the pending approval card (the account is not known yet), the proof
caption, the Declined notices, 📋 My requests rows, the Waiting-for-me-to-pay list rows.

## 5. What does not change

Who approves and how many signatures (`risk/evaluate.js` untouched). Four eyes
(BUSINESS_RULES §13): the picking admin is the completing approver and can never pay
it. Finance still only has ✔ Mark Done and ✖ Decline; if the money cannot leave from
the named account, finance declines with the reason and the request is raised again.
Payments approved before this release have no paid-from account and read as before.

## 6. Not built (owner: "polished later")

Account numbers / QR details on the chip; registering company accounts with their
numbers; changing the paying account after approval; a back-fill for old payments.

Known and left as it is: after a pick, the admin's ORIGINAL approval card (in the
chat or the inbox) keeps its ✅ / ❌ buttons — the picker is a separate message and
the bot holds no state to find the card by. A later tap on it is answered
`Already approved — nothing to do.`, as on every stale card.

## 7. Live check (owner)

1. Settings: leave `PAYMENT_SOURCE_ACCOUNTS` blank if 🏦 Manage Banks already lists
   your accounts as `BANK — ACCOUNT NAME`; otherwise type them there, one per line.
2. Abdul asks for a small payment. First admin approves. Second admin taps ✅ Approve:
   the picker appears; tap `✖ Not now` — Abdul's request still reads 1 of 2.
3. Second admin taps ✅ Approve again and picks an account: the result names it, the
   finance phone's card shows `📤 From` and `📥 To`, the PaymentRequests row has the
   name in the new last column T.
4. Finance taps ✔ Mark Done: the Paid notice to Abdul and both admins names the account.
