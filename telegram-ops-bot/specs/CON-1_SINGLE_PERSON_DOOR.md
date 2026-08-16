# CON-1 — one door for adding a person on Telegram

**Status: SPEC LOCKED 15-Aug-2026 — owner: "Go ahead, build with Opus5
only." Build from this document without re-asking.** Every ruling below
is his, from the 15-Aug discussion of the "Add Customer" approval card
that carried no triage chips.

## The owner's rulings

> "Keep single entry of any user added in telegram. Add contact flow has
> perfect build in this situation. For any other addition contact will
> have sub-categories if-needed. All other employees still keep on added
> through railway variables."

Plus explicit confirmation of the proposal's five points, including the
plain-Approve default (point 5 below).

## Why (the state that prompted it)

Two doors created people, and only one carried the CNET-2 triage:

| Door | Action code | Approval card | Data written |
|---|---|---|---|
| ➕ Add Customer (tile, guided) | `add_customer` | plain Approve/Reject | Customers row, **no network node** |
| "Add contact …" (typed only) | `add_contact` | 🛒 Customer · 📒 Contact · 🕸 Network | destination-dependent, Customer = CRM row **and** bound node |

So a person could exist as a customer but not in the network (the Mr
femi split-brain, again) and the card an admin saw depended on which
door the requester happened to use.

## The build

1. **One tile: ➕ Add Contact** (replaces the Add Customer tile in
   `activityRegistry` — code `add_customer` tile retired, a single
   `add_contact`-launching tile in the CRM hub). The guided flow BODY is
   kept — its step-by-step UI is good — only its plumbing changes.
2. **TYPE step first**: 🛒 Customer · 👷 Worker · 🤝 Agent · 🚚 Supplier
   · 📎 Other (the existing `contactsRepository.TYPES`).
3. **Sub-categories only when needed** (owner's phrase): type = Customer
   asks the existing Wholesale / Retail / Distributor / Wholesaler
   sub-category + credit limit + payment terms (the current flow's
   steps, unchanged); every other type skips straight to phone → address
   → notes. **No new columns** — category already lives on Customers.
4. **Everything queues as `add_contact`**, with the customer fields
   (category, credit_limit, payment_terms) riding the actionJSON when
   type = customer. Every person-card therefore gets the CNET-2 chips.
5. **Plain Approve honours the requested TYPE** (owner-confirmed
   semantic refinement): a Customer-typed request approved without
   touching a chip lands as customer + bound network node — NOT
   phonebook-only, which would re-create the very bug CNET-2 fixed. For
   every other type, plain Approve keeps today's phonebook default. The
   chips remain the admin's override in all cases. Reject unchanged.
6. **The typed-NLP paths converge**: "add customer John…" (intent
   `add_customer`) queues the same `add_contact` shape instead. The
   `add_customer` enum entry, WRITE_ACTIONS entry and executor all
   REMAIN so pending queue rows keep approving and S4's enum→policy lint
   holds — the action just stops being produced.
7. **Employees untouched**: Railway variables + the existing Add
   Employee door + IDR-2 pending-user triage all stay exactly as they
   are. This consolidation is customers/contacts only.

## Executor notes

- The CNET-2 destination executor (`add_contact` branch in
  `inventoryService.executeApprovedAction`) gains the customer fields:
  when destination = customer, pass category / credit_limit /
  payment_terms through to `crmService.addCustomer` (it already accepts
  them). CUS-2 fail-loud on name collision stays.
- Default-approve routing: `approvalEvents.handleApprovalCallback`'s
  plain-approve path consults `aj.type` for `add_contact` (customer →
  the 🛒 route). Implemented where CNET-2's `pendingTriage` delegation
  already lives — no new pipeline.

## Cards

`buildAddContactCard` renders the customer extras when present
(Category / Credit limit / Payment terms lines, CARD-3 grammar: a line
only when it has something to say). The chips row is unchanged.

## Tests (characterization through the real controller)

- Tile launches the flow; TYPE step first; customer type asks
  sub-category, worker type does not.
- Submission queues `add_contact` carrying the customer fields.
- Card shows the extras + all three chips.
- Plain Approve on a Customer-typed request → Customers row AND bound
  Contacts node (the split-brain is dead).
- Plain Approve on a Worker-typed request → phonebook, as today.
- Chip override still wins over the type.
- NLP "add customer …" produces the `add_contact` shape.
- A legacy pending `add_customer` row still approves via its executor.
- Existing CNET-2 suite stays green.

## Gate

`npm test` + `npm run smoke` + `npm run lint` 0 errors → one commit →
ff-push `main`. Update BUSINESS_RULES §12 (one door, type honoured at
approval) and the CLAUDE.md registry line for `ac*` in the same commit.
