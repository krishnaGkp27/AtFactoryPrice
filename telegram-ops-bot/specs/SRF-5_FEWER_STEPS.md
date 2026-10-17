# SRF-5 — Supply Request: fewer steps

**Shipped 17-Oct-2026.** Owner, 14-Oct: *"I need to get an option of showing all
from both/any of the containers so that the location, while selecting the store,
can be seen with all the designs available"*; 15-Oct: *"Is there any chance of
minimising the drill-down steps?"*; 16-Oct: *"I don't want to display anything
on typing"*; 17-Oct: go, with a live check to follow and a revert if it does not
look good.

## 1. What changed

The flow used to open on a container, then a category, then the store, then
the design list — four screens before the first design, and the seller
restating what the stock already knows. Now:

1. **The tile opens on the STORE** (`📦 Supply Request · Total: 543 bls ·
   74,669 yds · Select warehouse:`), every container and category in. Each
   store chip carries what it holds in the rule-6c grammar from the one
   labeller (`🏭 Kano office · 143B + 12t`). A seller scoped to one store
   lands straight on its designs. The way back is `🏠 Back to menu`.
2. **The design screen's header names the containers it covers**
   (`🏭 Kano office · 🚢 All containers`, or `· 🚢 Jul26` under a filter) and
   carries **two filter chips** on its first keyboard row — `🚢 Container ▾`
   and `🏷 Category ▾` — each shown only when the store offers a choice (or a
   filter is active, when the chip reads the pick: `🚢 Jul26 ▾`,
   `🏷 Cashmere ▾`).
3. **A chip redraws the same message** as a picker: `All ✓` first, then the
   containers (`🚢 Jul26 (347 bls · 1675 thans)`) or categories
   (`🧶 Cashmere (210 bls)`) with stock at THIS store, the live choice ticked,
   `⬅️ Back to designs`. The per-container yards/value block that used to open
   the flow (CV-1, admins only) sits on the container picker. A pick narrows
   the list in place; a category with no stock under a newly picked container
   is dropped rather than shown empty.
4. **Under All, the shade picker's album** shows every container's catalogue
   page, captioned `📷 9006 · 🚢 Mar26 + Jul26`, so no page passes as another
   shipment's (the CAT-C1 promise, kept). Shade figures are summed across
   containers; a shade named only in an older container shows as a bare
   number.
5. **Nothing typed.** Paging, the cart, Add More, the checkout questions, the
   approval card and the dispatch step are unchanged. A request raised under
   All carries no container (the dispatcher picks from whichever has the
   shade); one raised under a container filter stays pinned to it as before.

Taps to the quantity card: 8 at worst before, 5 now (6 with a design on page
two); a one-store seller 4.

## 2. Compatibility

`srf_ct:<batch>` and `srf_back:container` / `srf_back:category` taps from
cards sent before SRF-5 still answer: a container tap with no store yet lands
on the store step with that container as the filter; the two Back targets
land on the store step. New callbacks: `srf_fc:ct` · `srf_fc:cg` (open a
filter), `srf_ct:*` · `srf_cg:*` (clear it).

## 3. Code

`telegramController`: `startSupplyRequestFlow`, `proceedAfterContainer` (the
store step), `showDesignsForWarehouse` (header, filter row, back row),
`showSupplyFilterPicker` (new), the `srf_ct:` / `srf_cg:` / `srf_fc:` /
`srf_back:` handlers, `maybeSendDesignPreview` (album caption).
`showContainerPicker`, `showSupplyCategoryPicker` and
`proceedAfterContainerToCategory` are deleted. `inventoryRepository.
getArrivalBatches` reads through the export so the harness can feed it.

## 4. Tests

`test/characterization/supplyFlow.fewerSteps.test.js` (replaces the SRF-CAT
category-step test): the tile → store screen with figures; the design
screen's header, chips and back row; the category picker and its pick / All;
the container picker with the admin block and its pick / All; a stale
category dropped; a one-store seller; a pre-SRF-5 container tap.

## 5. Owner live check

📦 Supply Request → the store list shows figures and no container screen →
Kano office → header `🚢 All containers`, both chips → `🏷 Category ▾` → pick
one → the list narrows and the chip names it → `All` → `🚢 Container ▾` →
the ₦ block and the two containers → pick one → header `🚢 Jul26` → `All` →
a design → the album is captioned with both containers → a shade → quantity.
Then the same as a seller scoped to one store: tile → designs at once.
