# APG-1 — the approval gate: one foundation under every request

**Phase 1 shipped 10-Nov-2026** (with PAY-5, payments as the first tenant).

Owner, on two identical `Payment request: ₦70,000 · Muhammad · Salary` cards
that arrived a second apart: *"There are multiple salary requests being raised
by the employee. It should not happen with them asking for the same approval
again and again."* Then: *"before this, I want to build a strong foundation on
which all other approvals also sit. Otherwise every gate and channel will have
its own method / path. Shall I make it modular?"* — and after the layout:
*"You can increase the reminder hours from 4 to a day. Everything else looks
good with twin rules, salary, and scope … You are good to go."* —
*"make sure that the requester who raised the request gets the notification
back as and when approved by the admin, one by one, with the name and number
of approvers required."*

## 1. Why

A census the same day:

| Fact | Count |
|---|---|
| Places that raise a request | 44, across 26 files |
| Protected against a double submit | 5 |
| Doors that refuse an open twin | 2 (both transfers) |
| Request types | ~42 |
| Places one type's rules live | 5 — policy lists, card builder, inbox groups, decision special cases, executor |

Every door hand-wrote the same sequence (queue row → audit → notify → receipt),
so each fix landed on one door and never reached the rest. The two salary
cards were that pattern: the payment door's Submit stayed tappable for the
seconds the sheet write took, and the existing duplicate warning was blind to
payments because every payment request carries its own `payment_id`.

## 2. The two pieces

**`src/services/approvalRegistry.js`** — one entry per request type: `icon`,
`label`, `oneLine(aj)`, `nudge`, and the twin rule:

| Field | Meaning |
|---|---|
| `twin.key(aj)` | what makes two requests the same thing (null → the whole payload, as before) |
| `twin.policy` | `refuse` (the door will not raise a second while one is open; an admin may send it anyway, marked ⧉) · `flag` (raised, admins see ⚠️ Possible duplicate — **the default**) · `off` |
| `twin.scope` | `open` (for as long as one is open) · `window` (`DUPLICATE_WINDOW_MINUTES`, a double tap) |
| `twin.anyRequester` | the same thing raised by another person is a twin too |

An unknown type gets the default entry, so a new request type is flagged
before anyone writes a line for it. **Who signs is not here**:
`src/risk/evaluate.js` stays the one authority; the gate asks it.

**`src/services/approvalGate.js`** — `raise()` runs one sequence for every door:

1. the open-twin check (the registry's rule; the type's own *twin source* for
   states the queue cannot see);
2. the door's own record (`prepare`) — only after the check passed, so a
   refused request writes nothing on any sheet;
3. the queue row, idempotently (one request id = one row);
4. the audit line.

and gives every request, session-free:

| Chip | Callback | Does |
|---|---|---|
| 🔔 Remind approvers | `apg:nudge:<id>` | re-sends the SAME card to the admins who have not signed; once per `REQUEST_NUDGE_HOURS` (24) per request; raises nothing |
| 📋 Status / Open it | `apg:st:<id>` | where the request stands, who signed, reminders so far |
| ⧉ Reject as duplicate | `apg:dup:<id>` | admin, one tap on a flagged twin: stamps "Duplicate of R-XXXX, which is still open" and hands over to the ordinary reject path |

The duplicate detector (`src/utils/duplicateApprovals.js`) reads the registry,
so the ⚠️ line on admin cards and the inbox's ⧉ group now see payments.

## 3. What the requester is told (every request type)

One card at every step, plain text (`src/services/approvalProgress.js`):

```
🔏 Approval 1 of 2
💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
✅ Musa · 10-Nov 10:20
⏳ Waiting on 1 more admin
Ref R-77E8
```
```
✅ Approved · 2 of 2
💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
✅ Musa · 10-Nov 10:20
✅ Krishna · 10-Nov 11:05
✅ Payment of ₦70,000 to Muhammad approved by Musa ‖ Krishna — now with finance to pay.
Ref R-77E8
```
```
❌ Rejected by Musa · 10-Nov 11:05
💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
📝 Duplicate of R-B118, which is still open
Ref R-77E8
```

A one-admin request reads `✅ Approved · 1 of 1`. A sale's dispatcher card
reads `✅ Approved by Krishna · 1 of 1 — ready to dispatch`. The signature
trail rides the request's own row as `actionJSON.signoffs: [{id, name, at}]`
beside the existing `approvals: [id]`, which the dual-admin counter and the
four-eyes gate (PAY-4) keep reading untouched. The messages to the admins
(first-signature ping, sealed cards, the Paid notice to both signers) are
unchanged.

## 4. PAY-5 — payments on the gate (owner's rulings)

- **Submit fires once.** The button goes at the tap; one request id per confirm.
- **Twin rule (amended 11-Nov-2026, owner):** *"The primary key of the
  duplicate transaction would be account number, name, and the amount, which
  comes out to be the same. Then the admin will be able to refuse it."* and,
  for a request raised by another person on someone's behalf, *"you don't
  have to refuse it on your own, but the admin will be notified."*
  - **Key:** account number + payee name + amount, while one is open
    (waiting on approval, or approved and not yet paid).
  - **The same person's repeat** is stopped at the door: the open request is
    shown instead, with 📋 Open it and 🔔 Remind approvers. (This is the
    original complaint; `APPROVAL_TWIN_GUARD = 0` switches even this off —
    then every twin is raised and flagged.)
  - **Another person's** (on behalf) is **never refused by the bot**: the
    confirm card warns the requester, the request is raised with `twinFlag`
    on its row, and every admin card carries
    `⚠️ Same account, name and amount as R-XXXX (raised by John · waiting on
    approval)` plus `⧉ Reject as duplicate`. The admin decides.
  - A request raised into an account that is not the requester's own says so:
    `👥 Raised by Ajeet on behalf of Sani Loader`.
  - Once the first is paid, an identical payment is a new one. A different
    amount, or another name, is a different payment.
  - Who may raise for whom is unchanged (PAY-1): an employee into their own
    account, an admin also into a contractor's. Raising into another
    EMPLOYEE's account is still not possible — an owner ruling would be
    needed to open it.
- **An admin may ⧉ Send anyway** — the confirm, the queue row (`twinOf`,
  `sentAnywayBy`) and every admin card say it is a repeat.
- **Salary by month.** For an employee payee the reason step offers
  `💼 Salary` · `💵 Salary advance`, then the month (last · this · next). The
  reason is stored as `Salary · Nov-2026` in the sheet's own reason cell
  (column S — no new column). One salary per employee per month, waiting,
  approved or PAID (declined / rejected do not count). An advance is its own
  chip and is not blocked by the month rule. A typed reason containing
  "salary" is sent to the chip.
- **Receipt:** `🔔 Remind approvers` · `📋 Status` · `📋 My requests`; My
  requests shows who has signed and offers the reminder on what is waiting.
- The account-registration submit rides the gate too (submit-once, flagged).

Card shown instead of a second request:

```
⏳ This request is already open
💳 Payment request · ₦70,000 → Muhammad · Salary · Nov-2026
Raised by Muhammad · 09-Nov 16:20
🛂 Waiting on approval · 1 of 2 signed
If this really is a second payment, ask an admin to raise it.

Nothing new was raised.
[📋 Open it] [🔔 Remind approvers]
```

## 5. Switches (Settings, no deploy)

| Key | Default | Meaning |
|---|---|---|
| `REQUEST_NUDGE_HOURS` | 24 | hours between two 🔔 reminders on one request; 0 = off |
| `APPROVAL_TWIN_GUARD` | 1 | 0 = nothing is refused; admin cards keep their ⚠️ line |

No sheet, column or action code was added.

## 6. What phase 1 deliberately left alone

- **Deciding and executing** (`approvalEvents`, the 50 executor branches).
- **The other 26 files' raise sites.** They keep working as they are and move
  one commit at a time. The smoke check **S-APG** freezes their direct queue
  writes: a file may lose calls, never gain one; a new file fails the build.
- **Transfers** keep their own lifecycle (TRF-20 already refuses twins).

## 7. Next phases

- **Phase 2:** sales, returns, goods receipts, edit bale → the gate. Each
  door's twin rule is the owner's to rule on; until then `flag`.
- **Phase 3:** the rest; and the typed AI raise sites — four call sites,
  three actions:

| Typed site | Action | Other door today | Recommendation |
|---|---|---|---|
| "Record payment 50000 from Ibrahim via bank" (+ its candidate chip) | `record_payment` | none (🧾 Upload Receipt is a different record) | **build a tap door first** (💰 Finance → 💵 Payment received), then delete the typed handler |
| "Revert last transaction" | `revert_sale_bundle` | none | **build a tap door** (🛂 Decided → the sale → ↩️ Revert), then delete |
| "Add contact Ibrahim, worker, phone …" | `add_contact` | 👥 CRM → ➕ Add Contact | delete the typed handler; optional `Contact …` shortcut INTO the door (CON-2 layout) |

  `npm run census:typed` (needs the Railway `DATABASE_URL`) prints how often
  each was typed, per month, and every line that bounced — the evidence for
  the order of those doors.

## 8. Tests

`test/unit/services/approvalGate.test.js` (registry, detector, raise, nudge,
status, reject-as-duplicate, twin card) ·
`test/unit/events/approvalEvents.requesterProgress.test.js` (the three
requester cards on the real decision path, the flagged card's chip) ·
`test/characterization/paymentFlow.test.js` (double tap → one request; twin
refused / approved-unpaid / paid; Send anyway; salary by month; receipt +
reminder + My requests).

## 9. Owner live check

1. Approve ONE of the two ₦70,000 cards, tap ⧉ Reject as duplicate on the
   other (after the next reminder re-sends it), or ❌ Reject it now.
2. From an employee phone raise a payment, then raise the same one again →
   the "already open" card; tap 🔔 Remind approvers → the admins get the card
   with `🔔 <name> asks for a decision`; tap again → "Already reminded".
3. Sign it from one admin phone → the employee gets `🔏 Approval 1 of 2` with
   the signer's name; sign from the second → `✅ Approved · 2 of 2`.
4. Raise 💼 Salary for this month, then again with another amount → refused;
   💵 Salary advance → allowed.
5. As an admin raise the same payment twice → ⧉ Send anyway → the card reads
   `⧉ Repeat of R-XXXX — sent anyway by <you>`.
