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

## How to test on your phone

1. In the **Users** sheet, set your test user's:
   - `role` = `marketer` (or `salesman`)
   - `status` = `active`
   - `warehouses` = e.g. `Lagos` (the warehouse(s) they should see)
2. Open the bot and send **hi** → you should see only **📦 My Products**.
3. Tap it:
   - **marketer** → designs + shades + quantities for Lagos, **no price**.
   - **salesman** → same, **plus `₦<price>/yd`** per shade.
4. Stock in other warehouses must not appear.

> Tip: the allow-list refreshes from the Users sheet within ~10s; if the bot says "not authorized" right after editing the sheet, wait a moment and resend **hi**.

## Follow-ups (not in MKT-1)
- **Manage-Users role picker:** add `marketer`/`salesman` options to the admin Manage-Users flow (today the role is set directly in the sheet).
- **Free-text guard:** field-role users currently only get the menu tile; a guard that routes any free-text back to their catalog (so they can't reach other read paths via typing) is a small future hardening.
- **MG-2 (separate):** the dual-admin per-design "group price" model in `specs/marketing-group-catalog.md` remains available if richer governance is later wanted.
