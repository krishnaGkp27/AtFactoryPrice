# ACA-1 — one admin or two behind a new customer

Shipped 27-Nov-2026. Rule: `docs/BUSINESS_RULES.md` §12b, amendment of 27-Nov-2026.

## Your words

> "I want to make a toggle for admin to add customer through one admin
> approval or 2 admin. I need it on urgent basis and make it default to 1
> admin for now."

## The switch

Settings sheet → `ADD_CUSTOMER_APPROVALS` → **1** or **2**. Default **1**.
The bot adds the row to the sheet at its next start (as `1`) so it can be
seen; a row that is already there is never changed. A new value is live
within 30 seconds, no deploy. An empty cell is 1.

| | Switch on **1** (default) | Switch on **2** |
|---|---|---|
| An employee adds a customer | one admin approves — as before | two different admins approve |
| An admin adds a customer | that admin approves their own entry | one other admin approves |
| The admin's ⚡ Quick Add (writes at once) | offered — as before | closed |
| A person routed to 📒 Contact or 🕸 Network | one admin — as before | one admin — as before |

"Adds a customer" means what the request creates: a request raised as a
Customer, or one the approving admin routes to 🛒 Customer. It covers every
way in — ➕ Add Contact, 🆕 Add Prospect, the typed customer line, and the
➕ New customer button inside a sample, an order or a receipt upload.

## What changes on the phone

**Switch on 1 — what is new.** Before, an admin who added a customer was sent
the approval card like every other admin, and tapping ✅ Approve on it
answered `🔒 You cannot approve your own request — a second admin must review
it.` Now that tap saves the customer. The submitted card says so:

    👥 Add contact — submitted
    …
    🔏 One admin is enough for a new customer — tap ✅ Approve on the card
    below to save it yourself, or leave it to another admin.

The other admins still receive the card; whoever taps first decides. Only a
customer entry opens this way: an admin's own Worker / Agent / Supplier /
Other entry, and every other kind of request, still needs another admin.

**Switch on 2.**

- The first admin's tap answers `🔏 Approval 1 of 2 recorded.` and creates
  nothing; the requester is told `🔏 Approval 1 of 2`; the other admins are
  told a second approval is needed. The same admin cannot sign twice.
- The second admin's tap creates the customer.
- The approval card ends `🔏 A customer needs two admins. Contact and Network
  need one.`
- If the second admin routes the person to 📒 Contact instead, it is saved as
  a contact (not a customer).
- With only one admin set up, one approval is enough (as for every two-admin
  request).

## Where it lives

- `src/services/customerApprovals.js` — the value (`count`, `countNow`),
  what counts as creating a customer (`createsCustomer`), and whether an
  admin may approve their own entry (`ownApprovalAllowed`).
- `src/risk/evaluate.js` — `needsTwoAdmins(actionJSON)`: the fixed two-admin
  list, or a customer entry while the switch says two; `requiredAdminApprovals`
  takes `dual: true` for it. The list itself is unchanged.
- `src/events/approvalEvents.js` — the two-admin gate asks `needsTwoAdmins`;
  the self-approval guard steps aside for an admin's own customer entry
  while the switch says one.
- `src/services/approvalGate.js` (`requiredFor`) — the requester's cards and
  📨 My Requests count the same way.
- `src/controllers/telegramController.js` — Quick Add offered / refused by
  the switch; the wording on the admin's submitted card.

A Settings read that fails keeps the last value read. Before any read has
succeeded (a restart while Google Sheets cannot be read) the default, 1,
applies.

## Not changed

- Who may add a customer, the form, the freeze (`CUSTOMER_CREATION_ENABLED`),
  the name check, the triage chips, the executor.
- ❌ Reject: one admin, at any stage. An admin still cannot reject their own
  request.
- The two-admin list for every other action.
- With `AI_TEXT_PARSER = 1` (not the default) the old typed "add contact …"
  sentence raises the same request, so the switch covers it.

## Live check

1. Leave the switch on 1. From your own phone: 👥 CRM → ➕ Add Contact →
   🛒 Customer → fill it → ✅ Submit for Approval → on the card below tap
   ✅ Approve → the customer is saved, and appears in 👤 Customer Details.
2. From Abdul's phone add a customer → approve it once from any admin phone
   → saved (as before).
3. Settings sheet → `ADD_CUSTOMER_APPROVALS` → `2`. Wait half a minute.
   Abdul adds a customer → you tap 🛒 Customer → `Approval 1 of 2 recorded`,
   no customer yet → Musa taps ✅ Approve → saved.
4. Still on 2: ➕ Add Contact → 🛒 Customer on your phone → no ⚡ Quick Add
   button; submit → your own ✅ Approve is refused; Musa's saves it.
5. Set the cell back to `1`.
