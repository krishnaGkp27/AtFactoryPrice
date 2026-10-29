# CRM-R1 — Customers by region: Lagos (Lagos + IDUMOTA), Kano (Kano office), and any city registered later

**Status: SHIPPED 30-Oct-2026** (owner: "Go").

## The owner's words (29/30-Oct-2026)

> "Under CRM, I need a separate selection of chips from different regions here.
> It is especially Lagos and Kano. Lagos which consists of two stores: Lagos
> and Idumota, and another which is the Kano office. … This separation of
> customers will take place in all other regions."

> "Can you make sure that this bifurcation of customers between the regions
> shall always be done as and when required? Even when the employees who
> belong to a certain region shall not be seen from another region, only
> admin can see all of them at once."

> "Prospect will be given a region as and when they get added by employees.
> Say, for example, Muhammad is handling Kano office. Whenever he adds any
> customer, it will be tagged temporarily as a Kano office customer. As and
> when the employees from that region or the admin want to check their
> location, they can see/do it easily."

> "Instead of 'See all,' can you give me a Next button and a Back button."

Decisions: `❔ Not placed yet` shown until it empties · regions largest first ·
only 👤 Customer Details now (Add Note / Supply Statement / Supply Ledger
later) · Customer Ranking stays global · the supply request's `🌐 All
customers` becomes the region's customers for employees (everyone for admins).

## The rule (BUSINESS_RULES §19)

A customer belongs to the REGION of their stores. The Locations register
(LOC-1) says which city a store sits in; the customer's stores cell (CUS-3,
Customers col N) says where they buy. A buyer's store is stamped by the
approved sale; a prospect's store is stamped when they are added — the adding
employee's own store, **provisional** until the first sale confirms it — and
the region's employees or an admin can correct it from the card. Computed
every time a screen opens, never by hand, never on a schedule. An employee
sees only the region(s) of the stores on their own Users row (col I); only an
admin sees every region, or everyone at once.

## Screens

**Admin, screen 1** (`act:customer_details`):

```
👤 Customer Details
Pick a region, then a customer.

[🏆 Customer Ranking (global)]
[🏙 Lagos · 31]            [🏙 Kano · 18]
[🆕 Prospects · 7]         [❔ Not placed yet · 5]
[🌐 All customers · 54]
[⬅ Back to menu]
```

Regions largest first. `🆕 Prospects` = no sale yet, every region together.
`❔ Not placed yet` = a blank stores cell, buyer or prospect; the chip is
hidden at zero.

**A list, paged** (`cd:rg:<key>`, `cd:pg:<key>:<n>`; key = the region name,
`__p__`, `__u__`, `__all__`):

```
👤 Customer Details · 🏙 Kano
Kano office — 18 customers · page 1 of 3 · A–D

[👤 ABBA]                  [🆕 Abdul Gayinu]
…
[◀ Back]                   [Next ▶]
[🏙 Change region]         [🏠 Menu]
```

Eight names a page, buyers A–Z then prospects (🆕) A–Z; page 1 has no
`◀ Back`, the last page no `Next ▶`, eight or fewer names no paging row;
every page redraws in place.

**Employee** (Kano staff): the tile opens straight on their region's list
(no screen 1, no 🌐 All, no ❔ Not placed); `🆕 Prospects` in place of
`🏙 Change region`, filtered to their region. Stores in two regions → screen 1
with only those chips. No store on the Users row → the Prospects list and a
line asking an admin to attach their store. A region tap outside their scope
is refused.

**The customer card** gains one line under the name and, where allowed, one
chip:

```
🏙 Kano office · provisional — added by Muhammad, 12-Oct-2026
[🏙 Change store] …tabs… [👤 Back to customer picker]
```

A buyer's line reads `🏙 Kano office · IDUMOTA` (no chip). `🏙 Change store`
(`cd:cs:<name>` → `cd:css:<i>:<name>`) shows to admins and to employees of the
customer's region, for a customer who has not bought yet; it rewrites col N
alone. Back returns to the page the viewer came from (remembered 30 min).

**➕ Add Contact**: after the notes step — an employee with one store on their
row: nothing asked, the header shows `✓ Store: Kano office (provisional)`;
stores in two regions, or an admin: one chip row of the known places +
`❔ Place later`. The approval card shows `🏙 Kano office · provisional`; the
executor writes the stores cell on approval (a request without a store falls
back to the requester's single store; else the cell stays blank → `❔ Not
placed yet`).

**📦 Supply Request** `🌐 All customers`: employees get every customer of the
store's REGION (blank-store customers included, as CUS-3 does); admins keep
everyone.

## Prerequisites (owner)

1. `node scripts/seed-locations.js` (dry run) → `--commit`: `Lagos → Lagos`,
   `IDUMOTA → Lagos`, `Kano office → Kano`. Until the register has a city for
   a store, that store's customers are in no region.
2. `node scripts/backfill-customer-stores.js --commit` (CUS-3) so buyers carry
   their stores; until then they sit under `❔ Not placed yet`.

## Build

- `src/services/customerRegion.js` — `regionMap`, `classify`, `viewerRegions`,
  `mayTouch`, `page`, `storesLine`, `addedBy`, the Back memory.
- Controller (surgical): `showCustomerDetailsPicker` → region screen / paged
  list; `cd:rg:` `cd:pg:` `cd:cs:` `cd:css:` taps; the card's region line and
  chip; the Add Contact store step (`acst:`) and `stores` on the request;
  `srf_cu:__all__` scope.
- `crmService.addCustomer` takes `stores`; the add_contact executor passes
  `aj.stores` or the requester's single store; `approvalCards.buildAddContactCard`
  prints the line.
- `scripts/seed-locations.js`.
- Tests: `test/unit/services/customerRegion.test.js`;
  `test/characterization/customerRegions.test.js`.

## Later (owner's call)

- The same region step on ➕ Add Note, 📄 Supply Statement, 📒 Supply Ledger.
- A per-region Customer Ranking.
- Quick Add and the typed `add customer` line asking for a store when the
  requester has several.
