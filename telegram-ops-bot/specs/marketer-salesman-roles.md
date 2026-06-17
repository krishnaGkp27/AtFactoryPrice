# Spec: Marketer & Salesman roles — warehouse-scoped product visibility

**Status:** ✅ MKT-1 shipped (role-based, per-user warehouse scope, design+shade view).
**Owner decisions:** Role-based (not the MG-2 dual-admin group-price model) · scope by `Users.warehouses` · view = design + shade quantity · salesman also sees today's selling price.

---

## What it does

Two field roles sit below `employee`:

| Capability | Marketer | Salesman | Admin |
|---|---|---|---|
| See designs/shades **available in their assigned warehouse(s)** | ✅ | ✅ | ✅ (all) |
| See **today's selling price** (`Inventory.PricePerYard`) | ❌ | ✅ | ✅ |
| Bale numbers / customers / base cost / sell / receive | ❌ | ❌ | ✅ |

A marketer/salesman opens the bot and sees a **single tile — "📦 My Products"** — which lists, for the warehouse(s) the admin assigned them, every available design grouped by shade as `Bales · thans · yds`. The salesman view appends `· ₦<price>/yd` per shade.

## How it works (no schema change)

- **Role** = `Users.role` set to `marketer` or `salesman`.
- **Warehouse scope** = `Users.warehouses` (CSV) — assigned by admin.
- **Price** = existing `PricePerYard` (set via `update_price`), resolved by `pricingService.resolveSalePrice`. No new sheet, no new approval action — read-only view, so **approval semantics are untouched**.

### Code map
| File | Role |
|---|---|
| `src/services/fieldRoles.js` | `classify(role)`, `isFieldRole`, `canSeePrice` (salesman only). Pure. |
| `src/services/fieldCatalog.js` | `buildCatalog(items, warehouses, {showPrice})` → design→shade text. Pure. |
| `src/services/activityRegistry.js` | `my_products` tile. |
| `src/controllers/telegramController.js` | greeting-menu override for field roles + `act:my_products` handler (gated, additive). |

### Tests
- Unit: `test/unit/services/fieldRoles.test.js`, `fieldCatalog.test.js` (warehouse scoping, per-role price, empty states).
- Characterization: `test/characterization/fieldRoles.myProducts.test.js` (menu = only My Products; salesman price shown, marketer not; other-warehouse stock excluded).

## Onboarding from the bot (no sheet edit)

Admin → **Manage Users → ➕ Add New User** (or the Add Employee tile). The
Step-5 role picker now offers **📣 Marketer** and **💼 Salesman** alongside
Employee/Manager. Pick the warehouse(s) at Step 4 (the confirm card warns if a
field role has none), choose the role, and submit for the usual 2nd-admin
approval. On approval the user is written to `Users` with that role + warehouses
and can use the bot immediately. Implemented in `src/flows/userAddFlow.js`
(picker + validation) and `src/services/inventoryService.js` (`add_user`
executor allow-list); covered by `test/unit/flows/userAddFlow.roles.test.js`
and `test/unit/services/inventoryService.addUser.test.js`.

## How to test on your phone

1. Onboard the test phone via **Manage Users → Add New User** (above), choosing
   role **Marketer** (or **Salesman**) and at least one warehouse — *or* set the
   `Users` row manually (`role`, `status=active`, `warehouses`).
2. Open the bot and send **hi** → you should see only **📦 My Products**.
3. Tap it:
   - **marketer** → designs + shades + quantities for Lagos, **no price**.
   - **salesman** → same, **plus `₦<price>/yd`** per shade.
4. Stock in other warehouses must not appear.

> Tip: the allow-list refreshes from the Users sheet within ~10s; if the bot says "not authorized" right after editing the sheet, wait a moment and resend **hi**.

## Done since first cut
- **Free-text guard:** ✅ field-role users are strictly view-only — any free text just re-shows their My Products tile (never reaches the intent parser).
- **Manage-Users role picker:** ✅ Add Employee Step-5 now offers Marketer/Salesman; onboarding no longer needs a sheet edit.

## Follow-ups (not yet)
- **Change an EXISTING user's role from the bot:** today Manage Users edits dept/warehouses; flipping an existing employee to marketer/salesman is still a sheet edit (or re-add). A small role-change subflow could cover it.
- **MG-2 (separate):** the dual-admin per-design "group price" model in `specs/marketing-group-catalog.md` remains available if richer governance is later wanted.
