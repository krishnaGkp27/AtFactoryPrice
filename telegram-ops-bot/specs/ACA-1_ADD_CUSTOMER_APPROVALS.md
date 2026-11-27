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
within 30 seconds, no deploy. An empty cell is 1. Type `1` or `2`; anything
that starts with 2 or says "two" (`2 admins`, `Two admins`) is read as two,
and a cell the bot does not recognise is named in the Railway log.

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

The other admins still receive the card; whoever taps first decides. When an
admin approves their own entry, every other admin (Railway `ADMIN_IDS` and
the admins on the Users sheet) is told at once:

    ℹ️ Krishna added the customer Amib International and approved it on
    their own (one admin is enough for a new customer). R-0F36

Only a customer entry opens this way. An admin's own Worker / Agent /
Supplier / Other entry still needs another admin — unless that admin routes
it to 🛒 Customer on their own card, which makes it a customer entry. Every
other kind of request still needs another admin.

If an admin taps 📒 Contact or 🕸 Network on their OWN entry, the tap is
refused as before and now leaves nothing behind: the next admin's plain
✅ Approve still files the person as the customer that was requested.
(Before, the refused tap had already saved "contact" on the request.)

**Switch on 2.**

- The first admin's tap answers `🔏 Approval 1 of 2 recorded.` and creates
  nothing; the requester is told `🔏 Approval 1 of 2`; the other admins are
  told a second approval is needed. The same admin cannot sign twice.
- The second admin's tap creates the customer.
- The message every admin is sent ends `🔏 A customer needs two admins`; the
  card in 🛂 Approvals and the hourly reminder end `🔏 A customer needs two
  admins. Contact and Network need one.`
- The person who raised it reads `⏳ Waiting for admin approval — a new
  customer needs two admins.` (an admin: `⏳ Waiting for one other admin — …`).
- Filing the person as a 📒 Contact or under 🕸 Network takes ONE admin, at
  any point — also after a first approval was given for 🛒 Customer, and also
  by the admin who gave it. No customer is created that way; the person who
  asked is told where the entry went.
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
  while the switch says one, and tells its caller when it refuses; the
  triage chips undo a refused routing; the other admins' notice.
- `src/flows/approvalsInboxFlow.js` — the "1 of 2 already given" note is not
  printed for a customer entry once the switch is back on one.
- `src/services/approvalGate.js` (`requiredFor`) — the requester's cards and
  📨 My Requests count the same way.
- `src/controllers/telegramController.js` — Quick Add offered / refused by
  the switch; the wording on the admin's submitted card.

**If the Settings sheet cannot be read.** A read that fails keeps the last
value read. If no read has succeeded since the bot started (a restart while
Google refuses the sheet), the switch is treated as **2** and no admin may
approve their own entry, until the first read succeeds — your 2 never turns
into 1 because of a failed read. "Default 1" means: the sheet was read, and
it has no row or an empty cell. In that state Quick Add answers `⚠️ The
Settings sheet could not be read just now, so Quick Add is closed until it
can be.` and comes back by itself.

**What is decided and what is shown.** Every decision (an Approve tap, the
door's Submit, Quick Add) reads the cell at that moment. Lists that count
approvals — 📨 My Requests, the status card — show the last value read and
refresh in the background, so after you change the cell they can show the
old count for one screen. The approval card in 🛂 Approvals and the hourly
reminder read the cell when they are drawn.

## Not changed

- Who may add a customer, the form, the freeze (`CUSTOMER_CREATION_ENABLED`),
  the name check, the triage chips, the executor.
- ❌ Reject: one admin, at any stage. An admin still cannot reject their own
  request.
- The two-admin list for every other action.
- With `AI_TEXT_PARSER = 1` (not the default) the old typed "add contact …"
  sentence raises the same request, so the switch decides its approval too.
  Its reply to an admin still reads `Needs 2nd admin approval` and it sends
  that admin no card; on 1 they approve it from 🛂 Approvals.
- The two "approved" messages an admin gets after approving their own entry
  (the approver's line and the requester's card) — both are sent, as for
  every request.
- Known, older than this change and the same for every two-admin request:
  an admin who is an admin only on the Users sheet (not in Railway
  `ADMIN_IDS`) is counted as an admin but cannot tap Approve. With the
  switch on 2 and only ONE id in `ADMIN_IDS`, a customer request can wait
  for a second signature nobody can give. Keep two ids in `ADMIN_IDS`.
- 🛂 Approvals: the `👤 Customers & contacts` group shows no ⚠️ two-admin
  badge while the switch is on 2 (the group also holds one-admin requests).

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
