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

First review round closed the same day (§8): an unreadable account list fails
closed, the retry of a half-finished approval is not asked again, the completing
signature is saved before the payment is approved, the inbox keeps its card while the
picker is open, a stale `✖ Not now` says the truth, the record label is neutral, the
picker is a reply to the card it answers, commas, the Paid notice's From / To, and
two simultaneous completing taps.

## 1. The paying accounts (by name)

`paymentService.sourceAccounts()` -> an ordered list of `{ label, bank, account }`:
- Settings `PAYMENT_SOURCE_ACCOUNTS` (new key, text, default blank). Entries are
  separated by `;` or a new line. A comma separates entries ONLY in a single-line
  cell with no `;` — otherwise it stays inside the name, so
  `ZENITH — BLACK PANTHER CO., LTD; GTBANK — BLACK PANTHER` is two accounts. In a
  comma-split cell a fragment that names no account (no dash) joins the account
  before it, so `ZENITH — BLACK PANTHER CO., LTD` alone is ONE account, never a
  bogus `LTD`. Owner: one account per line is the safe way to write the cell. Each entry is written the way the house
  already writes a company bank account, `BANK — ACCOUNT NAME` (the grammar of
  `src/utils/bankEntry.js`; a hyphen is read as the dash; a plain name with no dash
  is accepted as written).
- **Off value:** `0`, `off`, `none`, `-` or `—` (any case), or a cell with no letter
  at all (Settings hands `0` and a digits-only cell over as numbers), means NO paying
  account: nobody is asked, nothing is stamped, and BANK_LIST is NOT consulted. An
  entry with no letter is dropped from a longer list (an account is kept by NAME).
- When that cell is blank: the entries of Settings `BANK_LIST` that NAME an account
  (`bankEntry.parse(bankEntry.normalize(entry)).account` is not empty, e.g.
  `ZENITH — BLACK PANTHER`). Plain bank names (`GTBank`, `Zenith`, ...) and the
  BANK-3 form `OPAY — OPAY` are payee banks, not company accounts, and are never
  offered. These named entries are already maintained in the bot through 🏦 Manage
  Banks, behind approval.
- De-duplicated with `bankEntry.key`; `label` is `bankEntry.normalize(entry)`.
- It reads Settings through `settingsRepository.getAllStrict()` (the same 30 s
  cache as `getAll`; a good cached read is served) which THROWS when the sheet read
  fails, so `sourceAccounts` throws too. "Could not be read" is never "none
  configured": the completing approval stops with the alert
  `⚠️ Could not read the paying accounts — nothing was approved. Tap ✅ Approve again in a minute.`
  and nothing is approved. An empty list means the read succeeded and named no
  account. The read sits in `payFromStep`, outside the two-admin gate's try/catch.
- The new key has a class (text) in test/unit/repositories/settingsBlankCells.test.js
  and a DEFAULTS entry ('').

## 2. The picker — on the completing approval only

In `approvalEvents.handleApprovalCallback`, for action `request_payment` only, at
the point where the tap is known to be the COMPLETING signature and nothing has been
written, answered or edited yet (after the two-admin gate, before the `Approving...`
toast and the keyboard wipe; outside the gate's try/catch). The seam calls
`paymentCards.payFromStep` and returns `{ asked: true }` when it answers `ask`.

`payFromStep` first reads the payment row (by its approval request id). If it is no
longer `pending_approval` — the retry of a half-finished approval: the row was
approved and stamped, the queue row could not be marked — nothing is asked and no
account is passed; the executor's already-approved branch then tells both result
cards what is recorded:
`ℹ️ Payment <id> was already approved by <pair> — paying from <account>. Nothing changed.`
(without ` — paying from …` when the row has no account). An unreadable payment row
carries on as usual; the executor reads it again before it writes.

| Accounts configured | What happens on ✅ Approve |
|---|---|
| 0 | Exactly as before PAY-6. No From anywhere. |
| 1 | That account is stamped without asking (one-option navigation). |
| 2 or more | A NEW message with the picker is sent AS A REPLY to the approval card that was tapped (`reply_to_message_id`, `allow_sending_without_reply`), the tap is answered with the toast `Choose the account to pay from.`, and the handler returns. **Nothing is approved, written or logged.** The approval card keeps its buttons. |

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
- `✖ Not now`: `pay:fromx:<requestId>` — the request is read first. Still pending
  (or unreadable): the picker message becomes
  `Nothing was approved. The request still waits for its last approval.` with no
  buttons. Already decided meanwhile: it becomes
  `This request was already approved — nothing to do.` /
  `This request was already rejected — nothing to do.` with no buttons. Session-free;
  nothing was written when the picker was drawn, so nothing is undone. A non-admin's
  tap is answered `Only admins can approve.` and changes nothing. Not now only removes
  the buttons: a replayed chip still meets every approval guard.
- A `pay:from:` chip whose request id names another request type is answered
  `Not a payment request.` and changes nothing.
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
- After the approval has gone through on a chip tap, the approval card the picker
  answered (`callbackQuery.message.reply_to_message`) loses its buttons too,
  best-effort and stateless — but ONLY while that message still carries this
  request's own decision chip (`approve:<id>` or `abx:ok:<id>`). An admin who turned
  the card into the menu or the inbox list (🏠 Menu / ⬅ Back) before picking keeps
  those buttons; a card that cannot be edited changes nothing else.
- 🛂 inbox: when ✅ Approve on an inbox card only drew the picker, the inbox leaves
  its card exactly as it is (buttons kept, no `still pending` footer) and stays
  anchored on it. A pick whose picker answers the admin's open inbox card goes back
  through the inbox (`approvalsInboxFlow.delegateDecision`), so it ends the way an
  inbox decision does: the card loses its buttons, the result, then
  `🛂 💳 Payments — *N* still pending.` with ⬅ Back / 🏠 Menu.
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
- Four eyes, durable (BUSINESS_RULES §13, no knob, no override): inside the
  executor's per-request lock the approver pair (`approverIds`) is written to the
  queue row BEFORE the PaymentRequests row is set approved. If that write throws or
  finds no row, nothing is approved: the executor answers
  `Could not record your approval — nothing was approved. Tap ✅ Approve again in a minute.`
  and the admin sees `⚠️ ` + that sentence (never "Approved but execution failed");
  the tapped message gets its buttons back so it can be tapped again; the requester
  is told nothing. This replaces the PAY-4b "a refused park never costs the
  approval" rule for payments, with or without a paying account.
- ApprovalQueue `actionJSON.payFrom = { label, by, at }` (best-effort, a separate
  write AFTER the row write, so a pending card never shows it), so the inbox record
  can print it. `by` is always the admin the executor ran for — the completing
  approver.
- `payment_events` `approved` detail carries the label as `paid_from` (no new event
  kind, no migration).
- `paymentService.approverIdsFor` also counts `payFrom.by` (the completing admin).
  The durable record of the completing approver is the `approverIds` write above;
  `payFrom.by` is a second copy.

## 4. Every card that shows it

Only when the payment HAS a paid-from account; a payment without one prints exactly
what it printed before (so every existing pin still holds).

| Card | With a paid-from account |
|---|---|
| Finance card (first send, reminder re-send, opened from 💳 Waiting for me to pay) | the payee line `🏦 0123456789 · GTBank` becomes two lines: `📤 From: ZENITH — BLACK PANTHER` / `📥 To: 0123456789 · GTBank` |
| The approving admin's result and the requester's closing card (the executor's note) | `... — now with finance to pay.` gains ` Paying from ZENITH — BLACK PANTHER.` |
| Paid notice (plain text: requester + both approvers) | `📤 From: ZENITH — BLACK PANTHER` directly above the payee line, and the payee line reads `📥 To: 0123456789 · GTBank`, the finance card's order (without an account it stays `🏦 GTBank 0123456789`) |
| Finance's own `✅ Paid` confirmation | the same From line, directly under the first line |
| 🛂 Approvals → 💳 Payments record: the status line (`With finance to pay` / `Paid by ...`) | ` · from ZENITH — BLACK PANTHER` at the end of the line |
| 🛂 Approvals record body (rebuilt from the queue payload) | `Pay from: ZENITH — BLACK PANTHER` under `Account:` (a label true whether the payment waits, was paid or was declined) |

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

Known and left as it is: another admin's copy of the approval card (a DM or a
reminder copy) keeps its buttons after the approval, as before PAY-6; a tap on it is
answered `Already approved — nothing to do.`, as on every stale card. On the retry of
a half-finished approval the closing admin's id is not added to `approverIds` (the
pair that approved the payment is already saved); when a DIFFERENT admin makes that
retry, the queue's Approver label names them while the payment row names the pair
that approved it. With the paying-account list on the 30 s cache, a Settings read
outage longer than the cache stops every completing payment approval with the
"could not read" alert, even where no paying account is configured (fail-closed by
design). The sale wizard (APC-1, `runApprovedSaleWithEnrichment`) has its own
executor call and still answers a second finishing admin "Approved but execution
failed" — pre-existing, identical before PAY-6, outside this feature.

## 7. Live check (owner)

1. Settings: leave `PAYMENT_SOURCE_ACCOUNTS` blank if 🏦 Manage Banks already lists
   your accounts as `BANK — ACCOUNT NAME`; otherwise type them there, one per line.
   Those BANK_LIST entries are the accounts customers PAY INTO (BANK-2); with a blank
   cell every one of them is offered as a paying account, and with exactly ONE named
   entry nobody is ever asked — it is stamped on every payment. Type `0` to switch
   the paying account off.
2. Abdul asks for a small payment. First admin approves. Second admin taps ✅ Approve:
   the picker appears; tap `✖ Not now` — Abdul's request still reads 1 of 2.
3. Second admin taps ✅ Approve again and picks an account: the result names it, the
   finance phone's card shows `📤 From` and `📥 To`, the PaymentRequests row has the
   name in the new last column T.
4. Finance taps ✔ Mark Done: the Paid notice to Abdul and both admins reads
   `📤 From: …` / `📥 To: …`.

## 8. First review round (11-Nov-2026)

1. An unreadable account list fails closed (§1).
2. The retry of a half-finished approval is never asked again and is told what is
   recorded (§2).
3. The completing signature is saved before the payment is approved; a refused save
   approves nothing (§3). The executor test that pinned "the approval survives a
   failed park" was re-pinned to this rule on purpose.
4. The 🛂 inbox keeps its card while the picker is open; a pick that began there ends
   there (§2).
5. `✖ Not now` on a stale picker says the request was already approved / rejected (§2).
6. The record body reads `Pay from:` (§4).
7. The picker is a reply to the card it answers; a pick takes that card's buttons
   down (§2).
8. Commas separate entries only in a single-line cell with no `;` (§1).
9. The Paid notice reads `📤 From:` / `📥 To:` (§4).
10. Two completing taps at the same instant (every type that runs through
    `handleApprovalCallback`; the sale wizard does not — §6): the executor's
    `Request not found or already resolved.` is the stale case — the loser is told
    `Already decided — nothing to do.` and the requester is sent nothing (before, the
    loser read "Approved but execution failed" and the requester a false
    "approved but could not be completed").

## 9. Second review round (11-Nov-2026)

1. The off value: `0` / `off` / `none` / `-` / `—` or a letterless cell is no paying
   account, never BANK_LIST and never a stamped `0` (§1).
2. A comma-split fragment that names no account joins the account before it (§1).
3. A pick wipes the replied-to message only while it still carries this request's
   decision chip — never the menu or the list it became (§2).
4. Approve on a request id that does not exist reads as before PAY-6
   (`⚠️ Approved but execution failed: Request not found or already resolved.`);
   `Already decided` is kept for a row that existed.
5. The Paid notice's To line uses the finance card's order (§4).
