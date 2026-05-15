# Add Warehouse (WH-C1)

Standalone admin activity to add a new warehouse as a first-class operation,
with dual-admin approval, strict canonical naming, and consistent visibility
across the bot.

## Where to find it

- **Admin Hub → 🏭 Add Warehouse** (top of the admin activity list, just
  before "Manage Warehouses").
- Callback: `act:add_warehouse`.

## Flow

1. Admin taps **🏭 Add Warehouse** → anchored card asks for the warehouse name.
2. Admin types a name (e.g. `kano main`).
3. Bot **canonicalizes** it (`Kano Main`) and shows a confirmation card with:
   - Canonical name
   - List of existing warehouses (Inventory ∪ `WAREHOUSE_LIST`)
   - **Confirm / Back / Cancel** buttons.
4. **Confirm** → request enters dual-admin approval queue
   (`add_warehouse` is in `ALWAYS_APPROVAL_ACTIONS`).
5. A second admin approves → warehouse is appended to `WAREHOUSE_LIST` in
   the `Settings` sheet and immediately appears in:
   - Goods Receipt flow (warehouse picker)
   - Manage Warehouses screen
   - Bulk Receive validator (accepts the new name)

## Naming rules

- Trimmed, internal whitespace collapsed, Title-Cased.
- Allowed characters: letters, digits, single spaces, `-`. Length 1–50.
- Must start with an alphanumeric character.
- Examples:
  - `  kano   MAIN  ` → `Kano Main` ✅
  - `LAGOS MAIN` → `Lagos Main` ✅
  - `Aba-North` → `Aba-North` ✅
  - `Kano,Lagos`, `Ka=no`, `Kano!`, ` Kano`, 51+ chars → ❌ rejected with clear error

## Deduplication

A name is rejected if it already exists (case-insensitive) in **either**:

- the `Inventory` sheet's existing warehouse column, **or**
- the `Settings.WAREHOUSE_LIST` value.

This fixes a prior bug where a name appearing only in Inventory could be
re-added via Settings.

## UX-C1 compliance

- Single anchored card (`editOrSendAnchored`) — no stranded messages.
- Every screen has **Back** and **Cancel**.
- All error paths render via `renderError()` with **Try again / Back / Cancel**.

## Smoke coverage

`scripts/smoke.js` → **S16.1–S16.10**: canonicalization, regex bounds,
merged-list dedup, risk policy, registry placement, service-level dedup fix,
and export surface.
