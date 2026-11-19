# CON-2 — one door for every customer entry

Shipped 19-Nov-2026. Layout shown 11-Nov-2026, owner's go 19-Nov-2026.

## 1. Before

Three flows carried their own "➕ New customer" button: 🧪 Samples, 📋 Orders
and 🧾 the receipt upload. Each asked two questions (name, phone) and raised
a private request, `new_customer`.

- A `Pending` row was written to the Customers sheet before any approval,
  and a `Rejected` row was left behind when the admin said no.
- No network node, no category, no credit limit, no payment terms.
- The admin got a bare Approve, without the 🛒 Customer · 📒 Contact ·
  🕸 Network chips every other entry has.
- The prompt promised "2-admin approval". One admin decided.

## 2. Now

Each button is a shortcut into ➕ Add Contact, the one door, with the kind
already set to Customer. The flow the person was in is put on hold.

```
➕ Add contact
✓ Type: 🛒 Customer
🧪 Your sample request is on hold until this customer is approved.

Enter the full name (reply in chat):
[⬅️ Back to sample]  [❌ Cancel]
```

Then the door's own steps: phone, address, category, credit limit, payment
terms, notes, store, confirm.

| Moment | What happens |
|---|---|
| ⬅️ Back on the name step, ❌ Cancel anywhere, typed `cancel` | The flow is live again at its own customer picker. Nothing picked before is lost. |
| The name is typed | Checked there. Already a customer: refused with the existing name and id. Creation frozen: refused. This check now runs for every customer entry, the CRM tile included. |
| ✅ Submit | ONE `add_contact` request, kind customer, with `resume: { flow }`. Nothing is written to the Customers sheet. The flow is live again, waiting on that request. |
| The admin's card | The usual card and chips, plus `🧪 Raised from a sample request · on hold until approved`. |

After Submit the person reads:

```
⏳ Customer "Mariam Salisu" sent for admin approval.
Your sample request is paused. It resumes automatically once an admin approves the new customer.
```

## 3. The decision

| Admin's choice | Result |
|---|---|
| 🛒 Customer, or a plain ✅ Approve | The Customers row and its network node are written by the usual executor. The flow continues: the sample and the order at quantity, the receipt at the amount, with the new customer and its id in place. |
| 📒 Contact or 🕸 Network | No customer is created. The person is told the name was filed as a contact, and the flow returns to its customer picker. |
| ❌ Reject | Nothing is written. The person is told, and the flow returns to its customer picker. |
| The person moved on meanwhile | Nothing is resumed. The closing card every requester gets already carries the outcome. |

A flow is resumed only when it is waiting on that exact request.

Changed from before: a rejected new customer used to cancel an order or a
receipt upload outright. Both now return to the picker.

## 4. Retired

- The three private forms, and `new_customer` as a request the bot raises.
- The Pending row before approval and the Rejected row after it.
- The "2-admin approval" wording.

Kept: the `new_customer` approval branch in `approvalEvents`, so a request
already in the queue from before can still be approved or rejected. It can
be deleted once the queue holds none.

## 5. Where it lives

| Piece | File |
|---|---|
| Open the door held, leave it, the Orders picker | `src/controllers/telegramController.js` (`startAddCustomerHeld`, `returnToHeldFlow`, `showHeldFlowCustomerPicker`, `showOrderCustomerPicker`, `HELD_FLOWS`) |
| The name check for every customer entry | the door's name step, `checkCustomerCreationGate` |
| Resume after the decision | `src/events/approvalEvents.js` (`resumeHeldFlowAfterContact`) |
| The line on the admin card | `src/services/approvalCards.js` (`buildAddContactCard`) |

No sheet, column, Settings key or action code changes.

## 6. Live check

1. From an employee's phone: 🧪 Samples, pick a design, tap ➕ Add New
   Customer. The door opens with the hold line. Tap ⬅️ Back to sample: the
   customer list is back.
2. Tap ➕ Add New Customer again, type a name that is already a customer.
   It is refused with the existing name.
3. Type a new name, finish the form, ✅ Submit. Check the Customers sheet:
   no new row yet.
4. On an admin phone open the card: the hold line is there. Tap 🛒 Customer.
   The employee's sample request continues at the quantity step. The
   Customers sheet has the row, and the person is in the network.
5. Repeat from 📋 Orders and tap 📒 Contact on the card: the employee is told
   and is back at the order's customer list.
6. Repeat from 🧾 the receipt upload and reject: back at the customer list.

## 7. Not done

- 📦 Supply Request's ➕ Add New Customer still answers that customers are
  added through CRM. It was not in the layout. Routing it into the door is
  the same small change; say the word.
- ⚡ Quick Add is not offered inside a held door. It writes at once and
  would skip the approval the paused flow waits for.
