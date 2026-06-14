# Spec: Marketing Group Catalog — Controlled supply_request View (Design Price + Design Visibility)

**Status:** 📋 Planned — scope reduced per owner ("design-by-design now, shade-by-shade later"), no code yet.
**Covers:** commits MG-1 (group warehouses + marketer pinning) + MG-2 (design price badge + design visibility, dual-admin). Per-shade quantity/pricing is deferred to MG-3 (future).
**Priority:** Owner to choose build order vs `dispatch-assignment.md`.
**Parent:** `ROADMAP.md` §4.11.
**Touches:** `Departments` sheet (one append-only column), the **existing `supply_request` flow inside `telegramController.js`** (warehouse-select + design list + shade-picker header — surgical, diff shown first), `risk/evaluate.js` (one new dual-admin action — owner-approved), admin hub.
**Reuses:** `Departments`/`departmentsRepository` (the group **is** a department), `usersRepository` (marketer = employee user), the existing supply_request warehouse→design→shade picker (we overlay it), `inventoryService` (real stock), the dual-admin approval queue (`approvalEvents` / `ALWAYS_APPROVAL_ACTIONS`).
**New storage:** `MarketingGroupPrices` sheet + one new `warehouses` column on `Departments`. No existing column reordered/renamed.

---

## §0 Scope decisions (settled with owner)

- **Price — design by design, compulsory, dual-admin.** Every design a marketing group is allowed to sell **must** carry a price, set per design and approved by **two distinct admins**. Shown as the `/yard` badge on the design header (per the reference screenshot: `9006 — Lagos → 400/yard`).
- **Quantity — original by default.** The marketer sees the **real per-shade bales available** (same numbers as admin). No per-shade reduction yet.
- **The only "quantity moderation" now = design visibility.** Admin controls **which designs are visible** to a marketing group. Implemented as: a design is visible to the group **iff** it has an `active` dual-admin price (pricing a design = enabling it; retiring the price = hiding it). This unifies "price is compulsory" with "which design is visible."
- **Shade-by-shade quantity AND shade-level pricing = later (MG-3).** The screenshot's reduced per-shade numbers represent that future phase, not this one.
- **Marketer = employee `Users` row** assigned to a marketing-group **department**; **pinned** to the group's warehouse. Admins/non-marketers see today's supply_request unchanged.

---

## §1 Goals & non-goals

### Goals
- **Overlay, not rebuild.** Reuse the existing supply_request flow; change only what a *marketer* sees.
- **Per-design group price (dual-admin, compulsory).** A `/yard` badge from the approved design price.
- **Design visibility per group.** Marketer sees only the designs priced (enabled) for their group.
- **Real quantities.** Per-shade bales shown = actual stock (no change this phase).
- **Pinned warehouse.** Marketer auto-pinned to the group's warehouse.
- **Admins/non-marketers unchanged.**

### Non-goals (this spec)
- **Per-shade quantity control** — deferred to MG-3.
- **Shade-level pricing** — deferred to MG-3.
- **New screens / `supply_details` styling** — pure overlay.
- **Stock reservation** — `Inventory` remains the over-sell guard.
- **`Marketers` sample-loan sheet** — untouched.
- **The Edit / upload icons** in the screenshot — out of scope.

---

## §2 Data model

### 2.1 `Departments` — the marketing group (+ one column)
The group **is** a department. Add one append-only `warehouses` (CSV) column (CLAUDE rule #4 — new columns at end only); used to pin the marketer.

```
dept_id | dept_name | allowed_activities | status | created_at | parent_department | warehouses
```
`departmentsRepository`: read column G; `getAll` range `A2:F`→`A2:G`; add `updateWarehouses(deptId, csv)`; `schemaMapper` adds the header on boot.

### 2.2 `Users` — marketer assignment (no schema change)
Marketer assigned to the marketing-group department via the existing `Users.departments` CSV. Group resolves via §5.1.

### 2.3 `MarketingGroupPrices` — NEW (dual-admin; active = visible)

Key: **group + warehouse + design** (design-level; no shade this phase).

```
price_id | dept_id | dept_name | warehouse | design | price | status | requested_by | approved_by_1 | approved_by_2 | updated_at
```
- `status`: `pending` → `active` (two **distinct** admins) / `inactive` (retired = hidden).
- **An `active` row both prices AND makes the design visible** to the group. No separate visibility flag needed.
- Marketer badge + design-list membership both read from `active` rows for `(dept_id, warehouse)`.

### 2.4 Repository — `marketingGroupPricesRepository.js` (NEW)
Cached `getAll` (10s TTL), `listActive(deptId, warehouse)` → visible designs + prices, `resolvePrice(deptId, warehouse, design)`, `append` (pending), `recordApproval(priceId, adminId)` (2nd distinct admin → active), `setStatus`.

> Per-shade quantity (`MarketingGroupQty`) is intentionally **not** created this phase — see §10 (MG-3).

---

## §3 Admin price flow — dual-admin (the one risk-policy change)

Per CLAUDE rule #3, the single explicitly-approved `risk/evaluate.js` change:
- Add action **`set_group_price`** to `WRITE_ACTIONS` + `ALWAYS_APPROVAL_ACTIONS` → every design price set/update needs two distinct admins.

Flow:
```
🏷 Group Prices → pick group → pick warehouse → enter design → enter price → submit
        │  (set_group_price → dual-admin queue)
   1st admin approves → row status=pending (approved_by_1)
   2nd distinct admin approves → status=active   ← design now visible + priced to the group
   retire → status=inactive                       ← design hidden from the group
```
Updating a live price proposes a new value through the same gate; the old `active` price stays in force until the new one is approved (no gap).

---

## §4 The overlay on supply_request

All injections are **surgical edits to the existing flow in `telegramController.js`** (parked file — diff shown first), gated on "is this user a marketer in a group?" (§5.1). Non-marketers hit none of it.

### 4.1 Warehouse step — pin the marketer
- Marketer: auto-select the group's warehouse and **skip** the select step when there is one; constrain to the group's warehouses when several.
- Non-marketer: unchanged.

### 4.2 Design list — visibility filter
- Marketer: show **only** designs with an `active` price for `(group, warehouse)`.
- Non-marketer/admin: full design list (unchanged).

### 4.3 Shade picker — badge + real stock
For a marketer viewing design `D` in warehouse `W`:
- **Header badge:** `` `<price>/yard` `` from `resolvePrice(group, W, D)` (always present, since visibility ⇒ priced).
- **Shade buttons:** unchanged — **real per-shade bales** (`inventoryService`), exactly as admin sees them this phase.
- Non-marketer/admin: unchanged (no badge).

### 4.4 Sell guard
- Unchanged — existing inventory over-sell guard applies. (No per-shade group cap this phase.)

---

## §5 Resolution logic

### 5.1 Is the user a marketer, and which group?
```
group = first dept in user.departments whose Departments.warehouses is non-empty   // A1: first wins
isMarketer = group != null AND not acting as admin
```

### 5.2 Render inputs
```
warehouse   = pinned group warehouse (or chosen among group.warehouses)
visible(D)  = exists active MarketingGroupPrices row (group.dept_id, warehouse, D)
priceBadge  = resolvePrice(group.dept_id, warehouse, D)         // present for every visible D
shadeBales  = real stock from inventoryService                  // unchanged this phase
```

### 5.3 Assumptions (flag if wrong)
- **A1 — multi-group user:** first marketing-group department wins.
- **A2 — multi-warehouse group:** marketer picks among group warehouses when >1; single → skipped.
- **A3 — price unit:** `/yard`.
- **A4 — price key includes warehouse:** kept from the prior decision/screenshot; if you want one price across all the group's warehouses, drop `warehouse` from the key.

---

## §6 Edge cases

| Case | Behavior |
|---|---|
| Design has active price | Visible to the group, badge shown, real shade stock. |
| Design has no active price | Not shown to the marketer (visibility = priced). |
| Price pending (1 approval) | Not visible yet (needs 2nd distinct admin). |
| Two approvals by same admin | Rejected; `approved_by_2` must differ. |
| Price update in flight | Old active price/visibility stays until 2nd approval (no gap). |
| Group has multiple warehouses | Marketer picks among them (A2); visibility/price per chosen warehouse. |
| User in no marketing group / admin | Standard supply_request (full designs, real stock, no badge). |

---

## §7 Cross-cutting concerns

- **Risk policy:** one additive action `set_group_price` (dual-admin). `supply_request` policy unchanged.
- **Caching:** new repo 10s TTL; config writes `invalidateCache()`.
- **Backward compatibility:** new `Departments.warehouses` blank everywhere = no change; new sheet additive; overlay only affects marketers; group price doesn't mutate `Inventory`.
- **Flag:** `MARKETING_GROUP_OVERLAY_ENABLED` (default `true`) — off = everyone standard.

---

## §8 Implementation plan

### 8.1 Files

| File | Change | Risk |
|---|---|---|
| `src/repositories/departmentsRepository.js` | Read `warehouses` (col G); add `updateWarehouses`. | Low — additive. |
| `src/repositories/marketingGroupPricesRepository.js` | **NEW** — design price resolve + dual-approval + `listActive`. | Low — mirrors `marketersRepository`. |
| `src/services/schemaMapper.js` | `Departments.warehouses` header + register `MarketingGroupPrices`. | Low — existing pattern. |
| `src/risk/evaluate.js` | Add `set_group_price` to `WRITE_ACTIONS` + `ALWAYS_APPROVAL_ACTIONS`. **Explicit owner instruction.** | Medium — sacred file; single additive action. |
| `src/events/approvalEvents.js` | Handle `set_group_price` dual-admin → activate price row. | Low–Med — additive. |
| `src/flows/groupPriceFlow.js` | **NEW** — `🏷 Group Prices` admin flow (propose/edit/retire, dual-admin). | Low — isolated. |
| `src/flows/userManageFlow.js` | Add assign-marketing-group + set group warehouses step. | Low — additive. |
| `src/services/marketerOverlay.js` | **NEW** — pure helpers: `isMarketer`, `resolveGroup`, `visibleDesigns`, `priceBadge`. Offline-testable. | Low. |
| `src/controllers/telegramController.js` | **Surgical injections** (diff first): (a) pin/scope warehouse, (b) filter design list to active-priced, (c) header price badge. | Medium — minimal, gated on `isMarketer`. |
| `src/services/activityRegistry.js` | Add `manage_group_prices` (admin). | Low — additive. |
| `src/config/index.js` | `MARKETING_GROUP_OVERLAY_ENABLED`. | Low. |
| `scripts/smoke.js` | New offline assertions (§8.3). | Low. |
| `specs/marketing-group-catalog.md` | This file. | — |
| `ROADMAP.md` | §4.11 entry. | Low — docs. |

### 8.2 Commit plan
- **MG-1 — Warehouses + pinning:** `Departments.warehouses` + repo + Manage Users assignment + pin marketer's warehouse in supply_request. (Marketer just gets pinned warehouse; full design list still.)
  ```
  feat(mktg): MG-1 marketing-group warehouses + pin marketer in supply_request
  ```
- **MG-2 — Design price + visibility (dual-admin):** `MarketingGroupPrices` + `set_group_price` + `🏷 Group Prices` flow + design-list visibility filter + header price badge.
  ```
  feat(mktg): MG-2 dual-admin design price badge + design visibility for marketers
  ```

### 8.3 Smoke harness additions (offline)

| # | Assertion |
|---|---|
| M1 | `isMarketer`/`resolveGroup`: dept with `warehouses` → group; none → not a marketer. |
| M2 | Single group warehouse → select step skipped; multiple → constrained chooser. |
| M3 | `recordApproval` flips to `active` only on a **second distinct** admin; same admin twice rejected. |
| M4 | Design list for a marketer = only `active`-priced designs for (group, warehouse). |
| M5 | Visible design always has a price badge; unpriced design absent. |
| M6 | Shade buttons show **real** stock (unchanged) for marketers this phase. |
| M7 | `set_group_price` ∈ `WRITE_ACTIONS` ∩ `ALWAYS_APPROVAL_ACTIONS`. |
| M8 | Price update keeps old active price/visibility until 2nd approval (no gap). |
| M9 | Admin/non-marketer render = full designs, real stock, no badge. |
| M10 | `MARKETING_GROUP_OVERLAY_ENABLED=false` → everyone standard. |

### 8.4 Acceptance criteria
- [ ] `npm run smoke` green with M-checks.
- [ ] Admin sets `warehouses=Lagos` on a marketing-group dept; assigns a test marketer → marketer pins to Lagos.
- [ ] Two distinct admins approve a price for (group, Lagos, 9006) → 9006 appears in that marketer's design list with `400/yard` badge; real shade stock shown.
- [ ] A design with no active price is absent from the marketer's list.
- [ ] Single-admin "approval" never activates/visualizes a design.
- [ ] A second group with a different price sees a different badge for the same design.
- [ ] `MARKETING_GROUP_OVERLAY_ENABLED=false` → marketer sees the standard picker.

---

## §9 Locked decisions log

| # | Decision | Choice |
|---|---|---|
| 1 | Surface | **Overlay** on existing supply_request (not a new tile) |
| 2 | Marketer | Employee `Users` row in a marketing-group department |
| 3 | Group | **Is a department**; warehouses via new `Departments.warehouses` column |
| 4 | Warehouse | Marketer **pinned** (skip select if one) |
| 5 | Price | **Design-level**, per (group + warehouse + design), **compulsory** |
| 6 | Price governance | **Dual-admin** — new `set_group_price` ∈ `ALWAYS_APPROVAL_ACTIONS` (owner-approved) |
| 7 | Visibility | A design is visible to a group **iff** it has an `active` price (pricing = enabling) |
| 8 | Quantity | **Real stock (original)** this phase; no per-shade control |
| 9 | Shade-level qty + pricing | **Deferred to MG-3** |
| 10 | Edit/upload icons | Out of scope |
| 11 | Marketers sheet | Untouched |
| 12 | Commits | MG-1 (warehouses+pin) + MG-2 (price + visibility) |

---

## §10 Out of scope (future MG-N)
- **MG-3 (shade-by-shade):** `MarketingGroupQty` (per group + warehouse + design + shade → allowed_bales) controlling the per-shade numbers the marketer sees (the screenshot's reduced counts), plus optional shade-level pricing. Governance decided with the finance pass.
- **MG-4 (finance pass):** caps tied to stock, cumulative budgets, approval changes.
- **MG-5 (AI velocity):** auto-suggest allowed bales from remaining stock × sales velocity.
- **MG-6 (catalog → order polish):** Edit/upload cart UX.
- **MG-7 (online channels):** apply the overlay to non-Telegram sources.

---

## §11 Open assumptions to confirm before build
1. **Multi-group user (A1):** first group wins, or pin to one primary?
2. **Multi-warehouse group (A2):** marketer picks among group warehouses when >1 — OK?
3. **Price key (A4):** per (group + warehouse + design), or one price across all the group's warehouses?
4. **Hub placement** for `🏷 Group Prices` (admin hub assumed).

---

## §12 Implementation anchors (for the implementing model)

> **How to use this section.** Line numbers are accurate as of authoring but **will drift** — always locate by the **search string** first, then confirm with the line. Every edit is additive and gated; if a gate (`isMarketer`) is false, the original code path must run **unchanged**. Run `npm run smoke` after each commit.

### 12.0 Map of touch points

| # | File | Locate by | Line (approx) |
|---|---|---|---|
| A | `src/services/schemaMapper.js` | `Departments: {` headers + `existing.includes('Departments')` | 38, 373 |
| B | `src/repositories/departmentsRepository.js` | `readRange(SHEET, 'A2:F')` | 29 |
| C | `src/repositories/marketingGroupPricesRepository.js` | **NEW FILE** (template: `marketersRepository.js`) | — |
| D | `src/risk/evaluate.js` | `const WRITE_ACTIONS`, `const ALWAYS_APPROVAL_ACTIONS`, `function formatAction` | 14, 59, 144 |
| E | `src/services/marketerOverlay.js` | **NEW FILE** (pure helpers) | — |
| F1 | `src/controllers/telegramController.js` | `async function startSupplyRequestFlow` | 4933 |
| F2 | `src/controllers/telegramController.js` | `async function showDesignsForWarehouse` (after `const designs = Array.from(`) | 4969 / 4981 |
| F3 | `src/controllers/telegramController.js` | `async function showShadesForDesign` (**two** headers: `caption: \`📷 *${design}*` and `📦 *${design}* in *${warehouse}*`) | 5030 / 5106 / 5132 |
| G | `src/flows/groupPriceFlow.js` | **NEW FILE**; submit via `requireApproval(...)` (`telegramController.js:74`) | — |
| H | `src/events/approvalEvents.js` | mirror the `isAddUser` / `isDesignAsset` special-cases in the approve branch | 722 / 739 |
| I | `src/services/activityRegistry.js` | `hub: 'admin'` block | ~118 |

---

### 12.A `Departments.warehouses` — schemaMapper

**A1 — extend the canonical header + seed (`schemaMapper.js:38`):**
```js
Departments: {
  headers: ['dept_id', 'dept_name', 'allowed_activities', 'status', 'created_at', 'parent_department', 'warehouses'],
  seed: [
    ['DEPT-001', 'Sales', '…', 'active', '', '', ''],   // add trailing '' for warehouses
    ['DEPT-002', 'Dispatch', '…', 'active', '', '', ''],
    ['DEPT-003', 'Admin', '__all__', 'active', '', '', ''],
  ],
},
```
**A2 — live migration for existing sheets — mirror the `parent_department` block (`schemaMapper.js:373`):**
```js
if (existing.includes('Departments')) {
  try {
    const deptHeader = await sheets.readRange('Departments', 'A1:Z1');
    const h = deptHeader[0] || [];
    if (!h.includes('parent_department')) { /* existing block */ }
    if (!h.includes('warehouses')) {
      const nextCol = colLetter(h.length + 1);
      await sheets.updateRange('Departments', `${nextCol}1:${nextCol}1`, [['warehouses']]);
      logger.info('SchemaMapper: extended Departments with warehouses (MG-1)');
    }
  } catch (e) { logger.warn('SchemaMapper: could not extend Departments —', e.message); }
}
```
> Note: read the header fresh after adding `parent_department` so `h.length` is right, or compute both additions from the same initial `h` with sequential `colLetter` offsets.

### 12.B `departmentsRepository.js`
- `getAll`: `readRange(SHEET, 'A2:F')` → `'A2:G'`.
- `parse`: add `warehouses: str(r[6]).split(',').map((w) => w.trim()).filter(Boolean),`.
- `HEADERS`: append `'warehouses'`.
- Add `updateWarehouses(deptId, csv)` writing column `G` (mirror `updateParentDepartment`, which writes `F`).

### 12.C `marketingGroupPricesRepository.js` (NEW — copy `marketersRepository.js` shape)
```
HEADERS = ['price_id','dept_id','dept_name','warehouse','design','price',
           'status','requested_by','approved_by_1','approved_by_2','updated_at'];
```
Required exports: `getAll` (10s cache), `listActive(deptId, warehouse)` (status==='active'),
`resolvePrice(deptId, warehouse, design)` (active row → Number(price) | null),
`append(row)` (status='pending', generate `MGP-…` via `idGenerator.generate('MGP')`),
`recordApproval(priceId, adminId)` (set `approved_by_1` if empty; else if `adminId !== approved_by_1` set `approved_by_2` + status='active'; if `adminId === approved_by_1` return `{ ok:false, reason:'same_admin' }`),
`setStatus(rowIndex, status)`, `invalidateCache`, `ensureHeader`.

### 12.D `risk/evaluate.js`
- Append `'set_group_price'` to `WRITE_ACTIONS` (line 14) **and** `ALWAYS_APPROVAL_ACTIONS` (line 59).
- Add to `formatAction` map (line 145): `set_group_price: 'group price update',`.
- No logic change — `evaluate()` already routes `ALWAYS_APPROVAL_ACTIONS` to dual-admin.

### 12.E `marketerOverlay.js` (NEW — pure, no I/O except the two repos)
```js
async function resolveGroup(user) {
  // first user department that is a marketing group (has warehouses set)
  // returns { dept_id, dept_name, warehouses:[] } | null
}
function isMarketer(user, isAdmin) { return !isAdmin && !!group; } // group from resolveGroup
async function visibleDesigns(deptId, warehouse) {
  return (await pricesRepo.listActive(deptId, warehouse)).map(r => r.design);
}
async function priceBadgeSuffix(deptId, warehouse, design) {
  const p = await pricesRepo.resolvePrice(deptId, warehouse, design);
  return p == null ? '' : `   \`₦${p}/yard\``;
}
```

### 12.F The three supply_request injections (`telegramController.js`)

**F1 — pin warehouse (`startSupplyRequestFlow`, 4933).** Right after `const user = await usersRepository.findByUserId(userId);`:
```js
// MG-1: marketers are pinned to their marketing group's warehouse(s).
const isAdminUser = config.access.adminIds.includes(userId);
const mGroup = await marketerOverlay.resolveGroup(user);
const isMarketer = !!mGroup && !isAdminUser;
const warehouses = isMarketer
  ? mGroup.warehouses
  : (user && user.warehouses.length ? user.warehouses : []);
```
Then the existing `length === 1 → showDesignsForWarehouse` and multi-select branches work unchanged (single group warehouse auto-pins; multiple → constrained chooser, because the list is already the group's).

**F2 — filter design list (`showDesignsForWarehouse`, after `const designs = Array.from(...)` at 4981):**
```js
// MG-2: marketers only see designs priced (= enabled) for their group.
const user = await usersRepository.findByUserId(userId);
const mGroup = await marketerOverlay.resolveGroup(user);
let visibleDesigns = designs;
if (mGroup && !config.access.adminIds.includes(userId)) {
  const allowed = new Set(await marketerOverlay.visibleDesigns(mGroup.dept_id, warehouse));
  visibleDesigns = designs.filter((d) => allowed.has(d.design));
}
```
Then use `visibleDesigns` (not `designs`) for paging/rendering below. Empty → show `🛈 No designs released to your group yet.`

**F3 — price badge — ⚠️ TWO headers (`showShadesForDesign`, 5030).** Build the suffix once near the top:
```js
const user = await usersRepository.findByUserId(userId);
const mGroup = await marketerOverlay.resolveGroup(user);
const badge = (mGroup && !config.access.adminIds.includes(userId))
  ? await marketerOverlay.priceBadgeSuffix(mGroup.dept_id, warehouse, design)
  : '';
```
Append `${badge}` to **BOTH**:
- **Path A** caption (5106): `caption: \`📷 *${design}* — *${warehouse}*${badge}\`,`
- **Path B** text (5132): `\`📦 *${design}* in *${warehouse}*${badge}\n\nSelect shade:\``

> Missing either path = badge shows only for designs with/without a photo. Patch both.

### 12.G `groupPriceFlow.js` (NEW admin flow) — submit through approval
At the end of the add/edit flow:
```js
const actionJSON = { action: 'set_group_price', dept_id, dept_name, warehouse, design, price };
const summary = `🏷 Group price — ${dept_name} · ${warehouse} · ${design} → ₦${price}/yard`;
await requireApproval(bot, chatId, msg, userId, 'set_group_price', actionJSON, summary);
```
Callback namespace `mgp:*` (`mgp:g:<deptId>`, `mgp:add:<deptId>`, `mgp:wh:<deptId>:<wh>`, `mgp:edit:<priceId>`, `mgp:retire:<priceId>`). Text steps (design, price) via `sessionStore` types `mgp_design` / `mgp_price`.

### 12.H Activate on approval (`approvalEvents.js`, approve branch ~692–714)
Mirror the `isAddUser` (722) / `isDesignAsset` (739) special-cases — detect the action **before** the generic `inventoryService.executeApprovedAction` and handle it dedicated (group price isn't inventory):
```js
const isGroupPrice = item?.actionJSON?.action === 'set_group_price';
if (isGroupPrice) {
  const aj = item.actionJSON;
  // append the row on FIRST approval (pending) if not yet created, then recordApproval;
  // OR create as pending at submit and recordApproval here. Pick one and be consistent.
  const res = await marketingGroupPricesRepository.recordApproval(aj.price_id, adminId);
  // edit the approval card to reflect 1/2 vs active; on same_admin → answerCallbackQuery toast.
  return; // skip executeApprovedAction (no inventory mutation)
}
```
> Decide at build time: create the `pending` row at **submit** (so `price_id` exists for both approvals) — simplest. Then both approvals call `recordApproval(price_id, adminId)`.

### 12.I `activityRegistry.js`
Add to the `admin` hub (near line 118):
```js
{ code: 'manage_group_prices', label: 'Group Prices', icon: '🏷', callback: 'act:manage_group_prices', hub: 'admin' },
```
Route `act:manage_group_prices` in the controller to `groupPriceFlow`. Visibility: admin-only (inject per-user like other admin tiles; do **not** add to any department's `allowed_activities`).

### 12.J Config + flag
`src/config/index.js`: add `marketing: { overlayEnabled: process.env.MARKETING_GROUP_OVERLAY_ENABLED !== 'false' }`. Gate every F-injection on `config.marketing.overlayEnabled` so the whole overlay is reversible.

---

*Spec authored: Jun 2026. Scope reduced to design-level price + visibility per the owner's "design-by-design now, shade-by-shade later" decision. §12 anchors added for low-tier-model handoff. Implementation pending owner go-ahead and resolution of §11.*
