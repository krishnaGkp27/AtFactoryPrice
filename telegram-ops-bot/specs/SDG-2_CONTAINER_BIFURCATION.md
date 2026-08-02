# SDG-2 / SDD-2 — container bifurcation + reconciliation on the supply reports

Owner-approved 02-Aug-2026. Extends SDG-1 (Design wise) and SDD-1
(Warehouse wise); shares one engine with SBL-2 (Customer Supplies).

## Why

"44200 — 215B / 416B" clubbed every arrival together. The business now
runs several containers at once, so a design's cumulative pair answered no
useful question: what the owner needs is "of THIS container, how much has
gone out?".

## Locked decisions

1. **Container step first.** The Design-wise drill opens on a container
   picker (`🚢 Jul26 — 3B / 4B`), counts from supplied vs total bales of
   that arrival. Every level below is container-scoped — **both sides** of
   the supplied/total pair, dates, customers, and the detail card. The
   picked container rides every header (`🚢 *Jul26* · …`), so a screenshot
   is never ambiguous.
2. **`🌍 All containers`** keeps the old clubbed view one tap away (shown
   only when more than one container exists) — the only way to see a
   design across arrivals.
3. **Unlabelled rows** bucket under `(unlabelled)` — nothing hides
   pre-backfill. Container matching is case-insensitive ('Jul26'/'JUL26'
   are one physical container, same rule as the pickers).
4. **Approved detail layout** (both reports): printed bale numbers ride
   each row in brackets (TRF-12 grammar); the flat "📦 Bale numbers (N)"
   list is dropped; money/quantities move to a second line per shade.
   Warehouse-wise gains bale numbers it never had (than-visible
   warehouses keep their `t` unit; the numbers are the bales the thans
   came from).
5. **📄 / 🧮 chips** on both detail cards, same behaviour as SBL-2:
   ephemeral doc delivery, in-place 🟢 dots, `✖ Stop check` on the
   reading state, orphan-safe generation counter.
6. **Doc-only numbers hidden on these two cards.** A sale document belongs
   to a customer + DAY; these cards are narrower (one design / one
   warehouse), so numbers in the doc that aren't on the card are usually
   that day's other designs — flagging them as anomalies would be wrong.
   SBL-2 (customer + day, the exact scope of a document) still shows them.

## Shared engine

`src/services/saleDocReconcile.js` — `docsFor` / `sendDocs` /
`readBaleDigits` / `reconcile` / `statusLines` / `dotted`. All three
supply cards use it; matching is digit-exact on printed numbers
(BUSINESS_RULES §1), read-only throughout (§2/§3).

## Files

- `src/services/saleDocReconcile.js` (new, shared)
- `src/flows/supplyDetailsDesignFlow.js` — container level, scoping,
  approved detail layout, chips
- `src/flows/supplyDetailsFlow.js` — bale numbers + chips
- `src/flows/soldBalesFlow.js` — refactored onto the shared engine
- Tests: `test/characterization/supplyDetailsContainer.test.js`,
  `test/characterization/soldBalesSupplyCard.test.js`

## Still clubbed (not changed — needs owner's call)

These are flat TEXT reports in the controller, with no cards to scope:
👤 **Supply Details → Customer wise**, and 📦 **Inventory Details →
Design wise / Warehouse wise** (`inv:`). Converting them to
container-aware drills is a separate task.
