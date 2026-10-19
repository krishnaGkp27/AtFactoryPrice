# CUS-3 — A store's customers (Customers columns N + O) · CARD-7 serial numbers

**Status:** SHIPPED 19-Oct-2026 (release 1: the sale pickers). Owner live check in §6.
**Owner's words (19-Oct-2026):** *"Right now, what I can see during data collection is all
the customers from both locations are shown in all sales … Kafaya takes the supply from
Lagos and Idumota, so she must not be shown to the Kano office, and vice versa."* Then:
*"add the next column, which shows the location of the customer based on the store,
separated by commas … Don't go through a real-time check inquiry all the time since it is
a longer process … let the granularity of storing it be store first. Then we'll group all
the stores inside a city together later. Declared customer who has never bought will always
show in last to pick. With some different identification."* On the card: *"Number every
sale card … with serial number separated by dot, elegantly aligned."* And: *"Your
understanding is correct: two columns, not one."*

## 1. What changed on the sheet (trailing columns only, nothing moved)

| Col | Header | Holds | Written by |
|---|---|---|---|
| N | `stores` | CSV of the stores / warehouses this customer buys from, e.g. `Lagos, IDUMOTA` | the approved-sale executors (a store joins the cell the first time a sale from it is approved), `scripts/backfill-customer-stores.js` once, or by hand |
| O | `first_sale_at` | ISO date of the first approved sale on record; blank = never bought | the executors (stamped once, never overwritten), the backfill script once |

`schemaMapper` appends the two header cells to a live 13-column Customers sheet and touches no
data row. `customersRepository` parses them (`stores: []`, `first_sale_at: ''` when blank) and
gains `setStores(id, stores)` / `noteFirstSale(id, iso)`; `append` and `updateRow` carry both.

## 2. The rule (BUSINESS_RULES 19-Oct-2026)

A store's customer picker offers the customers of THAT store, read from column N alone —
never from the stock sheet at pick time:

- **in scope** at a store: the cell names the store, OR the cell is blank (an unplaced customer
  is offered everywhere until placed — nobody is lost by the change);
- **order**: buyers (column O filled) first, alphabetical; a customer who has never bought
  comes LAST, every one of them marked `🆕` in place of `👤` (the "different identification");
- **the door out**: every scoped picker keeps `🌐 All customers` (supply request) /
  `🌐 Everyone` (approval wizard), and typed search still works at every step — an
  out-of-place sale is one tap away, never blocked;
- **granularity**: the store (`Kano office`, `Lagos`, `IDUMOTA`, …), exactly as the stock
  sheet names it. City grouping comes later through the Locations sheet (§7).

`src/services/customerScope.js`: `inStore`, `hasBought`, `chipLabel`, `forStore(customers,
store) → { buyers, fresh, all }`, `noteSale({ name, stores, soldDate })` (best-effort, never
fails a sale, leaves an unresolvable name alone).

## 3. Where the scope applies (release 1)

| Surface | Store | Behaviour |
|---|---|---|
| 📦 Supply Request → customer step (`showSupplyCustomerPicker`) | the store picked on screen 1 (`session.warehouse`) | title `👤 Select customer · 🏭 Kano office`; the ⭐ top-buyers block and the list both scoped; `📋 See More Customers` pages the scoped list; `🌐 All customers` (`srf_cu:__all__`) redraws with everyone, titled `… · every store` |
| Sale approval wizard Step 1 (`approvalEvents.sendCustomerStep` / `sendCustomerPage`) | the place of the request's items (`locationService.placesInAction(aj).place`) | design buyers and recents filtered; `📋 All customers` pages THIS store's list; `🌐 Everyone` (`cust:every:<n>`) pages everyone |
| 🧵 Samples → customer picker (`showSampleCustomerPicker`) | the viewer's own supply scope when it is ONE store (`supplyScopeWarehouses`) | same order; a viewer with several stores sees everyone |

Not yet scoped (release 2, your word): Orders, statements / `/balance`, payment requests,
Return goods, Merge Customers, the CRM lists. These are look-ups by name, not a sale at a
store, so the owner decides whether a scope helps there.

## 4. Stamping at approval (`inventoryService.executeApprovedAction`)

After the one QTA-1 write of a `sale_bundle` (`sellItems`), after `sellThan`, and after
`sellPackage`: `customerScope.noteSale({ name, stores, soldDate })` with the stores of the rows
actually sold (`applied[].item.warehouse`, else the request's warehouse) and the sale date.
Best-effort: a thrown read or write is logged and the sale is already complete.

## 5. CARD-7 — serial numbers on every sale card line

`approvalCards.buildSaleCard` numbers each bale / than line across the whole card (not per
group), the number padded with figure spaces to the widest serial so the dots align:

```
🧾 Sale · 5B · 630 yd
9060-A · 4B · 600 yd
 Shade BLACK
  1. 483 · 150 yd ✅
  2. 577 · 150 yd 🔴
  3. 490 · 150 yd ✅
 Shade WHITE
  4. 526 · 150 yd 🔴
77014 · 1t · 30 yd
 Shade 11
  5. 1100/1 · 30 yd
```

Every consumer of the one builder gets it (inbox, admin DM, hourly reminder, seller confirm,
Sell Bale / Snap). The ⚠️ / ❌ / ➕ detail lines beneath are unnumbered.

## 6. Owner live check

1. `node scripts/backfill-customer-stores.js` (dry run) → read the plan → `--drop "CJE:Kano
   office" --commit` (CJE's Kano sale was a wrong store — §7). Confirm Customers gained exactly
   TWO trailing headers `N = stores`, `O = first_sale_at`, A–M untouched, no row moved.
2. 📦 Supply Request → Kano office → a design → the customer step: only Kano buyers under ⭐
   and in the list, `🆕` names at the end, Kafaya absent; tap `🌐 All customers` → everyone,
   Kafaya present.
3. Approve any pending sale raised at Lagos → Step 1 lists Lagos buyers; `🌐 Everyone` opens
   the full list.
4. Approve a sale to a `🆕` customer → their row gains the store in N and the date in O; the
   next picker shows them as `👤`.
5. Open R-9A74 (or any sale) in 🛂 Approvals: every bale line carries `1.` `2.` … aligned.

## 7. Deferred / action items

- **CJE correction (owner, 19-Oct):** the CJE bill at Kano was sold without an approved transfer.
  Owner's plan: return the bill to Kano office → transfer it → sell it from Lagos. Until then the
  backfill is run with `--drop "CJE:Kano office"` so CJE is not placed at Kano.
- **Prospect door (next build):** ➕ Add Prospect for marketers AND sales staff — name, phone,
  the store they will buy from (writes column N up front), optional business-card IMAGE kept as
  evidence; the row is a `🆕` customer until the first approved sale. Spec to come.
- **City grouping:** `Locations` sheet maps store → city; a city filter over column N.
- **Release 2 surfaces:** §3's unscoped list.
- `customerScope.chipLabel` is the one place the 🆕 mark is drawn — a different mark is one line.
