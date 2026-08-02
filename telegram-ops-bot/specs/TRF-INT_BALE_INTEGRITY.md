# TRF-INT — Bale-number integrity across intake, transfer, sale, return

**Owner-locked decisions (01/02-Aug-2026), verbatim intent:**

1. **GRN intake gate.** Before any intake writes a row into Inventory, the bot
   must prove the incoming bale number does not collide with a **live** bale in
   **that warehouse**. No proof → no row. "Live" = status `available` or
   `in_transit`; a number whose previous bale is fully **sold** may be intaken
   again (packing-list numbers recycle). Collisions reject **only the clashing
   line** with an error naming the existing bale (design, received date); the
   rest of the GRN goes through.
2. **In-transit is a locked state.** Once dispatched, a bale exists in
   *neither* warehouse's stock, and any other transfer touching that number
   must **fail loudly at the dispatcher with an error** — never be silently
   skipped.
3. **Warehouse name rides the bale number** on the cards (picker, requester,
   admin) so a number that legitimately lives in two warehouses is never
   ambiguous to a human.
4. **The printed bale number from the packing list is THE primary key** for
   sale, dispatch, return — it is what users type, see and tap, and it must
   never be replaced or modified for them. Disambiguation comes from the
   warehouse + design context the user is already inside when they pick it.
   (Internally the system may remember exactly which physical rows a pick
   meant — `bale_uid` column R — but no user ever sees or types a uid.)
5. **Pre-existing duplicates**: one-off scan reported to admins so they can be
   resolved physically before the stricter rules matter.

## Build tiers

- **TRF-INT1 (structural):** dispatch resolves the picked printed numbers to
  exact Inventory rows *at pick time* (persisting real uids for legacy rows
  first — the read-time synthetic uid is rowIndex-derived and unstable) and
  stores them on the transfer (`aj.baleUids`). Receive/reject flip exactly
  those rows. Transfers dispatched before this carry no uids: their
  receive/reject falls back to printed-number matching **scoped to the
  transfer's own warehouse**, which already kills the cross-warehouse
  contamination. Every transition's result is **checked**: a dispatch that
  lost bales to a concurrent transaction drops them from its claim (or fails
  outright when nothing flipped); a receive/reject that flips fewer rows than
  expected closes with an admin-visible mismatch warning instead of silently.
  One dispatch at a time **per source warehouse** (in-process lock) so two
  transfers can never pick the same stock from one snapshot. Returns may only
  flip `sold` rows (an in-transit than can no longer be resurrected).
- **TRF-INT2 (guards + visibility):** explicit dispatcher error when a typed/
  searched bale is in transit or lives in another warehouse; stale ❌ Decline /
  ⚠️ Reject stage guards + a confirm step on Reject; double-tap guard on
  transfer creation; doc-attach serialized with stage changes; warehouse name
  on the bale popup and picker.
- **TRF-INT3 (intake gate + report):** the rule-1 collision gate enforced in
  the receive executors (all intake paths) + early warning in the GRN flow;
  boot-time duplicate report DMs admins the same-warehouse live duplicates
  (repeats each boot until resolved — that is the reminder).

## TRF-INT4 — sale/return executors warehouse-scoped (OPEN_ITEMS 12e, owner go-ahead 02-Aug-2026)

The last duplicate-number hole after TRF-INT1–3: sale executors keyed
`sell_package` by printed number + status only, so a cross-warehouse duplicate
sold once could flip both warehouses' bales. Owner-approved shape (02-Aug):

1. **Sale items carry the selling warehouse.** Every guided sale flow already
   knows it in-session; it now rides into the approval-queue item
   (`aj.warehouse`, and per-item `items[].warehouse` for bundles) instead of
   being dropped at handoff.
2. **Executors sell/return only in that warehouse.** `markPackageSold`,
   `markThanSold`, `markPackageAvailable`, `markThanAvailable` and
   `findByPackage` accept an optional `{ warehouse }` scope — same opts
   pattern as TRF-INT1's `transitionBales`. Executors pass the aj's warehouse
   when present. Pre-change pending approvals carry no warehouse and execute
   the old status-guarded way (accepted, called out to the owner).
3. **Typed sales of an ambiguous number get one extra tap.** "sell bale 997"
   with a live 997 in two warehouses shows warehouse chips instead of
   guessing; live in one place → unchanged.
4. **Cards show the warehouse** on sale approval/seal cards (rule 3 above).
5. **The printed number stays the only user-facing key** (rule 4 above) — the
   warehouse is context, never a new ID.

Accepted legacy corners (documented, not closed): rows whose Warehouse cell is
BLANK cannot be pinned — a sale/return that resolves to a blank-warehouse row
keeps the pre-TRF-INT4 unscoped behavior until the cell is filled. Once a
NAMED warehouse is in play for a number, blank rows are excluded from that
sale/return's totals and mutation. Pre-change pending approvals (no
`aj.warehouse`) execute the legacy status-guarded way.
