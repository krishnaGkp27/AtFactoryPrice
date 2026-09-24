# SSA-1 — 🔐 Sales Access (who may see which store's sales)

**Status:** SHIPPED 24-Sep-2026.
**Owner's words (24-Sep):** "I want to provide access to see all the goods which are
supplied from the respective warehouses … only kano details are being shown to the
kano manager, not the other warehouses" → "Can you make an admin feature where I can
grant access to see the sales from different warehouses to different employees … Once
I give them access through checkboxes for the sales made from different stores,
they'll be able to see it inside their Telegram account."

**Rulings (24-Sep, before the build):** (1) **immediate** — one admin, no second
signature (read access only; one tap revokes); (2) **tell the employee** — a one-line
DM when they gain access (a removal is silent — ruled after shipping); (3) **scope 🏬 Store Sales and 📒 Customer Supplies
together**; 📦 Supply Details "needs more polishing, leave this for now"; (4) an
employee with **nothing ticked sees nothing** — the tiles are hidden and a stale tap
is refused in one line — even if a department CSV lists Customer Supplies.

## 1. The rule (BUSINESS_RULES §18)

Which places' SALES a person may see is decided by the admin-ticked list on their
Users row, never by a department CSV and never by the flow they open:

| Who | 🏬 Store Sales | 📒 Customer Supplies |
|---|---|---|
| Admin (env `ADMIN_IDS` ∪ sheet admins) | every place, unchanged | every customer, unchanged |
| Employee with ticked places | only those places: one place → opens straight on its day tiles, no Change place; several → screen 1 shows only those chips | only rows sold FROM those places: customer chips, day tiles, the day card, the detail card and the sale-doc chip are all filtered |
| Employee with nothing ticked | tile hidden; a stale tap: `🏬 No store is assigned to you — ask an admin.` | tile hidden; `📒 No store is assigned to you — ask an admin.` |

The Departments sheet can still *list* the tiles, but the grant is applied on top:
a grant ADDS both tiles to the person's menu (greeting grid and hub alike), no grant
REMOVES both. Nothing else on the menu changes.

## 2. The admin door — 👥 Human Resources → 🔐 Sales Access (admin-only)

**Screen A — the person.** One chip per active, non-admin person in the Users sheet,
alphabetical, two per row, each showing what they hold today:

```
🔐 Sales Access

Who may see store sales? Tap a person.

[ 👤 Abdul · Kano office ]   [ 👤 Muhammad · — ]
[ 👤 Musa · IDUMOTA, Ketu ]  [ 👤 Bello · — ]
[ 🏠 Back to menu ]
```

**Screen B — the places.** Every warehouse and store the bot knows (the LOC-1
register merged with the places holding stock and `WAREHOUSE_LIST`), tick chips,
toggled in place; a granted place the register no longer lists stays tickable so it
can be removed.

```
🔐 Sales Access — Abdul

Tick the places Abdul may see, then Save.

[ ✅ Kano office ]   [ ⬜ IDUMOTA ]
[ ⬜ Ketu ]          [ ⬜ Balogun ]
[ ✅ Save ]
[ 👤 Change person ]  [ ❌ Close ]
```

**✅ Save** writes the ticks, logs one AuditLog line (`sales_access_updated`: who, whom,
before, after), DMs the person when they GAINED something to see (`🏬 You can now see
the sales of Kano office. Open 📊 Reporting → 🏬 Store Sales or 📒 Customer Supplies.`)
and confirms:

```
🔐 Sales Access

✅ Abdul now sees the sales of Kano office.
They have been told.

[ 👤 Change person ]
[ ❌ Close ]
```

A save with no change is written anyway and says `No change — nothing sent.`

**A removal is silent (owner, 24-Sep, after shipping: "I don't want removal messages
to be seen to employees").** Unticking everything writes the cell, logs the line and
confirms `✅ Musa no longer sees any store's sales.` to the admin — the employee gets
no message; the tiles simply leave their menu.

## 3. Where the grant lives

**Users sheet, column L `store_sales_places`** — a CSV of place names, the one
trailing column after `notification_prefs`. Added by the schema bootstrap the way
`manages` and `notification_prefs` were (header cell only; no data row moved). It is
a master record about a person, so it sits on Users; it is deliberately **separate
from column I `warehouses`**, which is the supply-door scope — granting a report never
changes where someone may raise a supply from. You can also read or fix the cell in
the sheet; the bot re-reads Users within 30 s.

Place matching is trimmed and case-folded (`kano office` = `Kano office`), the same
fold the bale identity and 🏬 Store Sales use.

## 4. Wiring

| Piece | Where |
|---|---|
| Rule | `src/services/salesAccessService.js` — `scopeFor(userId)` (admin → all; else the row's places; a failed Users read scopes to NOTHING, never to all), `filterRows`, `adjustMenu`, `listPlaces`, `grant` |
| Admin flow | `src/flows/salesAccessFlow.js` — `sales_access_flow`, namespace `ssa:` (`u:<i>` person · `p:<i>` toggle · `save` · `back` · `close` · `menu`) |
| Store Sales | `storeSalesFlow.start()` — scope replaces the admin-only gate; `session.scope` / `session.single` |
| Customer Supplies | `soldBalesFlow` — `scopedSoldRows(session)` feeds the customer list, the date list, the day card and the detail card; `saleDocReconcile.docsFor(customer, day, { placeKeys })` drops a bill raised from a place outside the grant (the Supply Ledger's reuse of the day card carries no scope and stays admin-only) |
| Menu | two four-line insertions in the controller (greeting grid + hub renderer) calling `adjustMenu`; one `act:sales_access` case; one `ssa:` route line (owner go 24-Sep covered the controller edits) |
| Sheet | `usersRepository` reads `A2:L`, parses `store_sales_places`, `updateStoreSalesPlaces()`; `schemaMapper` Users headers + bootstrap block |
| Tile | `activityRegistry` `sales_access` · 🔐 Sales Access · hub `hr` |
| Usage | `usageTracker.PREFIX_FEATURES` `ssa:` → `sales_access` |
| Tests | `test/unit/services/salesAccessService.test.js` · `test/unit/flows/salesAccessFlow.test.js` · `test/unit/flows/storeSalesFlow.test.js` (granted cases) · `test/characterization/customerSuppliesScoped.test.js` · `test/characterization/salesAccessMenu.test.js` (menu rule, tile, save through the real controller); smoke S41 fixture now carries a warehouse and a grant |

## 5. Owner live check

1. 👥 Human Resources → 🔐 Sales Access → tap **Abdul** → tick **Kano office** → ✅ Save.
   Abdul receives the one-line DM.
2. On Abdul's phone: 📊 Reporting now shows 🏬 Store Sales and 📒 Customer Supplies.
   Store Sales opens straight on `🏬 Sales — Kano office` (your screenshot, with no
   🏬 Change place button); Customer Supplies lists only buyers who bought from Kano
   office, and their day cards show only Kano goods.
3. Back on your phone: untick Kano office → ✅ Save. Abdul gets NO message; both
   tiles leave his Reporting hub; an old card he taps answers `No store is assigned
   to you — ask an admin.`
4. Check the Users sheet gained exactly ONE trailing header cell `L = store_sales_places`
   and that Abdul's row holds `Kano office` while granted.

## 6. Deliberately not built / owed

- 📦 Supply Details stays unscoped (your ruling: polish it later). Until then, keep it
  out of the Kano department's `allowed_activities`, or every employee holding it
  sees every warehouse's supplies.
- Stock reports (Check Stock, Stock Value, List Bales) are also unscoped — they show
  stock, not sales; say the word if the same ticks should govern them.
- A second admin's approval on a grant (ruled out: immediate).
