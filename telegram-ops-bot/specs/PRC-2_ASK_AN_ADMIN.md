# PRC-2 — Payment Received: ask a named admin; the admin may enter the amount

Shipped 16-Nov-2026. Builds on PRC-1 (`specs/PRC-1_PAYMENT_RECEIVED_AND_REVERT.md`).

## 1. Owner's words

> "What if I want to ask a specific admin to approve the payment received? If
> the amount is known, then I (employee) will attach the amount also.
> Likewise, this request will be raised through any of the employees to the
> admin to approve it and record it against the customer … the employee will
> select the admin from the admin list to send for approval."

Then, on the recommendation: *"Go with the recommendation."*

## 2. Rulings (owner, 16-Nov-2026)

- **R1 — the named admin first; two approvals stay.** The card goes to the
  named admin first. After the first signature the second approval is open
  to the other admins. The number of approvals does not change
  (`risk/evaluate.js` untouched): an employee's entry needs two different
  admins, an admin's own entry one OTHER admin (ruling 15-Nov-2026, "Two").
- **R2 — never stuck on one person.** The request is in EVERY admin's
  🛂 Approvals, marked `🙋 Asked: <name>`. Any admin may approve or reject it
  at any time.
- **R3 — the amount may be left blank.** When the employee does not know
  it, the admin giving the FIRST approval types it. The second admin's
  approval is the check on that figure.

## 3. Decided by the agent inside the rulings (say if you want any different)

- **D1** `👥 Any admin` is the last chip of the new step = the behaviour
  before PRC-2 (the card to every admin).
- **D2** `⏭ Amount not known` is for EMPLOYEES only. An admin entering a
  payment always types the amount: an admin's entry has one approver, so a
  figure typed by that approver would be checked by nobody.
- **D3** With exactly ONE admin able to approve, the "who" step is skipped
  (one-option navigation) and nobody is recorded as asked.
- **D4** Settings `ASKED_ADMIN_WIDEN_HOURS` (default **4**, `0` = never by
  time). While an asked request has NO signature and is younger than that,
  the hourly reminder and the requester's 🔔 Remind approvers go to the
  asked admin ONLY. After it they go to every admin, saying the asked admin
  has not answered.
- **D5** The amount is frozen once it is on the request. To change it:
  ❌ Reject and raise again.
- **D6** The cash / bank step stays required even when the amount is blank.

## 4. The employee's screens (verbatim)

Step 1 (who paid) is unchanged.

**Step 2 — how much** (an employee; an admin sees the first five lines and
only `⬅ Back` `❌ Cancel`):

```
💵 Payment received

Customer: ABBA

How much did they pay?
Type the amount, for example `50000`.
If you do not know it, tap ⏭ Amount not known — the admin enters it.
[⏭ Amount not known]
[⬅ Back] [❌ Cancel]
```

A `prc:noamt` tap from an admin (a stale or crafted chip) only redraws this step.

**Step 3 — paid how.** Unchanged; with a blank amount:

```
💵 Payment received

Customer: ABBA
Amount: to be entered by the admin

How was it paid?
[💵 Cash]
[🏦 Zenith]
[⬅ Back] [❌ Cancel]
```

**Step 4 — who should approve (new).** Shown when two or more admins can
approve (the env admin pool minus the requester):

```
💵 Payment received

Customer: ABBA
Amount: 50,000
Paid by: Bank — Zenith

Who should approve it?
The admin you pick is asked first.
[🛂 Krishna]
[🛂 Musa]
[🛂 John]
[👥 Any admin]
[⬅ Back] [❌ Cancel]
```

Names: the name the approval cards use (Users sheet → Telegram), else
`Admin <last 4 digits>`. Two admins with the same name are told apart by the
last four digits of their id.

**Step 5 — confirm:**

```
💵 Payment received

Customer: ABBA
Amount: 50,000
Paid by: Bank — Zenith
Ask: Musa
Date: 16-Nov-2026

Musa is asked first. Two admins approve it before the customer's balance moves.
[✅ Submit for approval]
[⬅ Back] [❌ Cancel]
```

| Requester | Asked | Closing sentence |
|---|---|---|
| employee | named | `Musa is asked first. Two admins approve it before the customer's balance moves.` |
| employee | any / skipped | `Two admins approve it before the customer's balance moves.` |
| admin | named | `Musa is asked to approve it before the customer's balance moves.` |
| admin | any / skipped | `Another admin approves it before the customer's balance moves.` |

A blank amount puts `The admin enters the amount.` in front, and the summary
reads `Amount: to be entered by the admin`. `Ask:` is left out for Any admin
or a skipped step.

**Receipt (asked):**

```
⏳ Sent to Musa for approval

Customer: ABBA
Amount: 50,000
Paid by: Bank — Zenith
Ask: Musa
Date: 16-Nov-2026
Ref R-4F72
[🔔 Remind approvers] [📋 Status]
[💵 Record another] [🏠 Menu]
```

If Telegram refuses the Markdown receipt after the request was raised, the
same facts are sent as plain text (`⏳ Sent to Musa for approval` · the
customer · `Ref R-4F72`, same buttons). A request that exists is never
reported as `Could not send`. Names inside the bold headline are not
backslash-escaped (Telegram honours no escape there); a `*` in a name closes
and reopens the bold.

When Musa cannot be reached (the send failed), the card goes to the other
admins at once and the receipt ends with
`⚠️ Musa could not be reached — sent to the other admins.`
Un-asked receipts read `⏳ Sent for approval` as before.

`⬅ Back` walks every step backwards, the new one included (a skipped step is
skipped going back too). Changing any answer makes a new request id.

## 5. The admin's screens (verbatim)

### 5a. The card — one builder for every admin surface

The DM card, the 🛂 inbox card, the hourly reminder, 🔔 Remind approvers and
the second admin's card are all `approvalCards.buildPaymentCard`:

```
Record Payment Request
Customer: ABBA
Amount: 50,000
Method: Bank — Zenith
Date: 16-Nov-2026
🙋 Asked: Musa
Outstanding today: 120,000
After this payment: 70,000
```

- blank amount: `Amount: not entered — typed at the first approval`; no
  `After this payment`, no EXCEEDS line;
- entered by an admin: `Amount: 50,000 · entered by Musa`;
- `🙋 Asked: <name>` only when asked and that person is still an admin; on
  the 🛂 inbox, once the request has waited past the widen hour:
  `🙋 Asked: Musa · no answer for 5h — any admin may approve`;
- an un-asked request with an amount prints byte-for-byte as before
  (pinned by test);
- a decided record (🛂 ✅❌ Decided) prints no live balance.

Notes put above the card (`🔔 Approval required …`):

| When | Note |
|---|---|
| first card, to the asked admin only | `🙋 Abdul asks YOU to approve this.` |
| the asked admin could not be reached, to the others | `🙋 Asked: Musa (could not be reached)` |
| the first signature, to admins who held no card yet | `🔏 1 of 2 — signed by Musa. Yours is the second approval.` |
| the first signature on a blank request (the signer typed the amount), to EVERY other admin — their card still says `not entered` | the same note, on the full card with `· entered by Musa` |
| hourly reminder, before the widen hour (asked admin only) | `⏰ Reminder — Abdul asked YOU to approve this` |
| hourly reminder, after it (every admin) | `⏰ Reminder — asked: Musa · no answer for 5h. Any admin may approve.` |
| the same, less than an hour old (widened early — the asked admin was unreachable) | `⏰ Reminder — asked: Musa. Any admin may approve.` (never `0h`) |
| hourly reminder after a signature (the unsigned) | `⏰ Reminder — this approval is still waiting` (as before) |

An admin who already holds the card when someone else signs first (the asked
admin, R2) gets the one-line ping as before (whether someone "holds the
card" is read from the raw `askedAdmin` id, so an asked admin since removed
from `ADMIN_IDS` still means the others get the full card):
`🔔 Request <id> (record payment) has its first admin approval and needs a SECOND. Use the approval card in your chat.`

### 5b. The amount step (blank amount, first approval)

`✅ Approve` on a blank request records NOTHING. The tap answers
`Type the amount first.` and, as a reply to the card:

```
💵 Payment received · amount needed

Customer: ABBA
Paid by: Bank — Zenith
Raised by: Abdul
Outstanding today: 120,000

Abdul did not know the amount. Type what ABBA paid, for example `50000`.
Nothing is approved until you confirm.
If your number gets no answer, tap ✏️ Type the amount and send it again.
[✏️ Type the amount] [✖ Not now]
```

A typed value that is not an amount adds
`⚠️ That is not an amount. Type digits only, for example 50000.`
A good one turns the same message into:

```
💵 Payment received · check the amount

Customer: ABBA
Amount: 50,000 · entered by you
Paid by: Bank — Zenith
Outstanding today: 120,000
After this payment: 70,000

Your approval is the first of two. A second admin checks the amount.
[✅ Approve with 50,000]
[✏️ Change amount] [✖ Not now]
```

- When this approval completes the request: `Your approval records the payment.`
- When the figure is more than the balance, `⚠️ Payment EXCEEDS the outstanding balance.`
  under `After this payment` (a warning, never a block).

The amount is saved, then read back: the signature is recorded only when
the request still carries THIS admin's figure and still waits.

After `✅ Approve with`, the message becomes one line, no buttons:

- `✅ You entered 50,000 and gave approval 1 of 2. A second admin checks it.`
- `✅ 50,000 from ABBA is recorded.` (when it completed the request)

`✖ Not now` → `Nothing was approved. The request still waits.`

Refusals (alerts):

| Case | Text |
|---|---|
| the amount could not be saved | `⚠️ Could not save the amount — nothing was approved. Tap again in a minute.` |
| the saved amount did not read back as this admin's | `⚠️ The amount on this payment changed while you typed — nothing was approved. Open the card again.` |
| another admin entered it meanwhile | `Krishna already entered 40,000 for this payment. Open the card to approve or reject it.` |
| the request was decided meanwhile | `Already rejected — nothing to do.` (or approved) |
| not an admin | `Only admins can approve.` |
| the requester's own request | `🔒 You cannot enter the amount on your own request.` |

Two admins confirming different figures at once are taken one at a time
(a per-request lock in the approval handler): the first figure and its
signature stand, the second admin's step closes with
`Krishna already entered 50,000 for this payment. Open the card to approve or reject it.`

### 5c. The second admin checks a figure another admin typed (review 1)

A plain `✅ Approve` (DM card, reminder, 🛂 inbox) on a payment whose amount
ANOTHER admin typed records nothing — the card may have been drawn before the
amount existed. The tap answers `Check the amount first.` and, as a reply:

```
💵 Payment received · check the amount

Customer: ABBA
Amount: 50,000 · entered by Krishna
Paid by: Bank — Zenith
Outstanding today: 120,000
After this payment: 70,000

Krishna typed this amount. Check it before you approve.
Your approval records the payment.
[✅ Approve 50,000]
[✖ Not now]
```

`✅ Approve 50,000` = `prc:ok:<requestId>:<amount>`, session-free: it goes
through only when the request still carries exactly that figure. Closing
line: `✅ 50,000 from ABBA is recorded.` (or `✅ You approved 50,000 —
approval n of N.`). Refusals: `The amount on this payment is 50,000. Tap
✅ Approve on the card again.` (a different figure on the chip) ·
`🔏 You typed this amount — a different admin must check it.` ·
`This payment has no amount yet. Tap ✅ Approve on the card.`
A payment whose amount the EMPLOYEE typed keeps the one-tap ✅ Approve.

Every signature on a payment received stores the amount it was given for
(`signoffs[].amount`). The last approval is refused, recording nothing, when
any signature names a different figure from the request (or, on an amount an
admin typed, names none):
`⚠️ The approvals on this payment were given for different amounts — nothing was recorded. Reject it and raise it again.`

## 6. The requester's cards

No balance on any of them (FIN-V2).

```
🔏 Approval 1 of 2
💵 Payment received · ABBA · 50,000 · Bank — Zenith
💵 Amount entered by Musa: 50,000
🙋 Asked: Musa
✅ Musa · 16-Nov 10:20
⏳ Waiting on 1 more admin
Ref R-4F72
```

The closing `✅ Approved · 2 of 2` card keeps the `💵 Amount entered by` line.
A blank request reads `💵 Payment received · ABBA · amount to be entered · Bank — Zenith`
on every card that names it in one line. 📋 Status shows `🙋 Asked: <name>`
while it waits.

## 7. Data on the request (no sheet change)

Everything rides the request's own ApprovalQueue `actionJSON`:

| Field | Meaning |
|---|---|
| `askedAdmin: { id, name }` | the admin asked first (absent = any admin) |
| `amount` | positive number, or absent while blank |
| `amountPending: true` | the amount was left blank (set `false` once entered) |
| `amountBy: { id, name, at }` | the admin who typed the amount |
| `askWidenedAt` | when the card first went beyond the asked admin (first signature, the widen hour, an unreachable asked admin) |
| `signoffs[].amount` | the figure each signature was given for (review 1) |

The duplicate detector ignores `askedAdmin`, `askWidenedAt`, `amountBy` and
`amountPending`, and compares a copy whose amount an admin typed without
that amount: one payment raised twice stays flagged whoever was asked, after
a first signature, and after an admin typed the figure on one copy.

Audit: `approval_queued` carries `asked` and `amountPending`;
`payment_received_amount_entered` `{ requestId, amount, customer }` when an
admin types it.

## 8. How it is built

- `src/services/askedApprover.js` — the one answer to "who should be
  messaged about this request now". Keys on `askedAdmin`, not on the action,
  so another door can adopt it by writing that field.
- `paymentReceivedFlow` — the new step, the blank amount, the admin's amount
  step (`prc:ay` / `prc:ae` / `prc:ax`, session-free, re-checked on every tap;
  the amount rides `prc:ay:<requestId>:<amount>`, at most 55 bytes).
- `approvalEvents.handleApprovalCallback` — two seams: (1) after every guard
  and before the two-admin gate, a blank row opens the amount step and the
  ✅ chip's re-entry saves the amount before the gate records the signature
  (a refused save approves nothing); (2) the first signature on an asked
  request stamps `askWidenedAt` in the same write and sends the full card to
  the admins who had none.
- `approvalReminder.sweepPending` and `approvalGate.nudge` use the same
  audience; neither ever messages the requester or a signer of an asked request.
- Executor backstop: a `record_payment` with no positive amount is refused
  (`This payment has no amount yet — nothing was recorded.`).

## 9. Not built (deliberately)

- Changing an amount once entered (D5 — reject and raise again).
- A named admin on any other request type (the module is ready; each door
  is the owner's word).
- The typed `Payment …` line still points at this door; the legacy typed
  `record_payment` raisers in the controller are unchanged (no asked admin,
  amount always present).
- Sheet-promoted admins (USR-C3b) are not in the "who" list: the list is the
  Railway `ADMIN_IDS` pool, the same pool the cards go to.

## Known limits

- **A typed amount after the admin's session is lost** (a redeploy, or the
  session's time-out between `✅ Approve` and the typed number) reaches no
  step: the controller reads the number as an ordinary typed line (for
  example `Bale 50000 not found.`, or a bale card when the figure is a bale
  number). Nothing is recorded. Routing it would mean changing the
  controller, which this feature does not touch. The way back: tap
  `✏️ Type the amount` on the prompt (session-free) or `✅ Approve` on the
  card again, then type the number.
- The per-request lock is in-process: it holds while the bot runs as one
  process (as today). The signature figures (`signoffs[].amount`) are the
  backstop that does not depend on it.

## Live check

1. Abdul: 💰 Finance → 💵 Payment Received → ABBA → `50000` → a bank →
   **Who should approve it?** lists every admin but Abdul → 🛂 Musa → the
   confirm card says `Ask: Musa` and `Musa is asked first …` → Submit →
   `⏳ Sent to Musa for approval`.
2. Only Musa's phone gets the card (`🙋 Abdul asks YOU to approve this.`);
   another admin's 🛂 Approvals shows it with `🙋 Asked: Musa`.
3. Musa ✅ Approve → Abdul gets `🔏 Approval 1 of 2`; the other admins now
   get the full card with `🔏 1 of 2 — signed by Musa`; one of them approves
   → recorded, Abdul gets `✅ Approved · 2 of 2`.
4. Again with `⏭ Amount not known` → Musa's card says `not entered`; ✅
   Approve asks for the amount; type it → `✅ Approve with …` → the second
   admin's card reads `· entered by Musa`; their ✅ Approve opens the check
   card → `✅ Approve 50,000` → recorded at that figure.
5. An admin's own entry has no `⏭ Amount not known`.
6. Leave one asked request unanswered past 4 hours: the next hourly reminder
   reaches every admin with `no answer for …h`.
