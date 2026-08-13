# CNET-2 — contact triage at approval

**Status: SHIPPED 13-Aug-2026.** Owner-confirmed layout ("Looks perfect. Go
ahead and build it.").

## The problem (owner, 13-Aug-2026)

> "Even after approving a contact requested by Abdul, I am not able to see
> this customer when approving the sales bill."

Abdul typed "add contact Mr femi …". The bot filed it — correctly — into
the **Contacts** phonebook, which the sale-approval wizard never reads
(BUSINESS_RULES §12: only the **Customers** register is sale-assignable).
The old approval card gave the admin no say in WHERE the person landed and
no warning that a phonebook row would never appear on a sales bill.

> "Give me the options in the chips: whether I have to add this customer to
> the customer list, or in the usual contacts, giving them a place in a
> network as we have designed it already. Stitching is required."

## The card

Every queued `add_contact` (typed NLP today; any future door) renders the
full parsed detail — so a mis-parse is visible before routing — plus three
destination chips instead of a bare Approve:

```
🔔 Approval required

Ref: `…` / From: Abdul

📇 New contact — Mr femi
🏷 typed as: other · 📞 +2348012345678
🏠 Kano
📝 (notes, when typed)

Where does this person belong?
🛒 Customer — registered for sales bills, and joins the network as a buyer
📒 Contact — phonebook only
🕸 Network — phonebook + placed under a buyer's people

[🛒 Customer] [📒 Contact]
[🕸 Network]  [❌ Reject]
```

## The stitching

| Chip | Writes | Where the person then appears |
|---|---|---|
| 🛒 `ctg:<rid>:c` | CRM entity via `crmService.addCustomer` (CUS-2 collision guard) **+ a Contacts node with `customer_id` bound** (CNET-1a column) | sale-approval wizard, CRM, network as a buyer node |
| 📒 `ctg:<rid>:p` | Contacts row with the typed type | phonebook / contact network person cards |
| 🕸 `ctg:<rid>:n` → buyer picker (in place, paged) → `b:<i>` → confirm `ok` | Contacts row + `subordinate_of` edge (same shape as `add_contact_link`) | phonebook + under the chosen buyer in 📇 Contact Network |

A 🛒 name collision fails LOUD (`"…already exists as customer X — choose
📒 Contact on the card, or reject"`) and the request **stays pending**, so
the admin re-routes instead of silently no-opping.

## How it rides the existing rails

- **No new action code.** The queued action stays `add_contact`; the chip
  persists `destination` (+ `boss_contact_id`/`boss_name` for 🕸) onto the
  actionJSON via `updateActionJSON`, then delegates to
  `handleApprovalCallback('approve')` — so the stale-request, self-approval,
  super-admin and dual-admin guards ALL hold unchanged.
  `WRITE_ACTIONS` / `ALWAYS_APPROVAL_ACTIONS` untouched.
- **Safe default:** a plain `approve:` from any old card, the approvals
  inbox delegate, or a generic surface executes with no `destination`,
  which the executor reads as 📒 Contact — the exact pre-CNET-2 behaviour.
- **APC-1 concurrency:** every chip carries its requestId
  (`ctg:<rid>:…`); the 🕸 picker state is per (admin, request) with a 1-h
  TTL sweep, so two pending contact requests cannot cross-wire.
- **Reminder sweep** rebuilds the same card with the same chips
  (`approvalCards.keyboardForRequest`); every other action keeps the
  standard Approve/Reject pair (`keyboardForRequest` returns null).
- Buyer picker list: active Contacts of type `customer` or carrying a
  `customer_id` (the CNET-1 buyer nodes), alphabetical, 10/page. No typed
  search in v1 — chips + paging only.

## Callback namespace

`ctg:` — registered in the CLAUDE.md prefix registry and usageTracker
(`contact_triage`). Shapes: `c` / `p` / `n` / `pg:<n>` / `b:<i>` / `ok` /
`x` (back), all `ctg:<requestId>:<op>`.

## Files

`approvalCards` (card + keyboard), `approvalEvents` (triage handler +
`opts.keyboard` on notify), `inventoryService` (destination-aware
`add_contact` executor), `telegramController` (`ctg:` route + requireApproval
uses the chip card), `approvalReminder` (keyboard on rebuilds),
`usageTracker` (namespace name).

## Tests

`test/characterization/contactTriage.test.js` — the card + chips, the typed
front door end-to-end, both-register stitching, loud collision (stays
pending), the network picker → edge, back-navigation, cross-wire guard,
non-admin + self-approval refusals, and the plain-approve default.

## Notes

- "Mr femi" himself predates this feature: he sits in Contacts as `other`.
  Register him via ➕ Add Customer when needed (or ask for a one-off bind).
- Deferred: typed search inside the 🕸 buyer picker; contact→customer
  promotion for EXISTING phonebook rows (a "promote" chip on the person
  card in 📇 Contact Network would be the natural door).
