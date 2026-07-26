# SDG-2 — Supply Details "🎨 By shade" axis (PARKED, ready to build)

**Status:** designed and owner-approved on layout (25-Jul-2026). **NOT built.**
Parked at the owner's request to make room for other work — pick this up
whenever it comes back round.

**Depends on:** SDG-1 (`src/flows/supplyDetailsDesignFlow.js`, live since
`5a6ed8f` + `ae53307`), which already implements the design → date →
customer → detail axis this plan extends.

---

## Why

The 📦 Supply Details tile still carries a flat **Design Wise (Summary)**
text dump (`buildDesignWiseReport` in `src/services/supplyDetailsReport.js`).
It looked redundant next to the SDG-1 drill, but it is **not** — it holds two
things the drill cannot answer:

1. **Shade totals across all time.** In SDG-1 shade appears only at level 4
   (one customer, one date), so "how much of design 9006 Shade 11 have I
   supplied in total?" has no answer.
2. **"Top buyer" per design** — computed by yards; exists nowhere else in
   the bot.

Owner decision: **do not abandon it — merge it into the drill as a second
axis**, so the tile ends up with one entry and two ways to slice it, instead
of two competing drills.

---

## Locked layout

### The fork — after tapping a design

```
📦 44200 · top buyer: soldier madam
Supplied 209B / 240B

   📅 By date        🎨 By shade

⬅ Designs    ❌ Close    🏠 Menu
```

`📅 By date` is the existing SDG-1 path, unchanged. "Top buyer" moves here
from the flat Summary — it is most useful while choosing.

### 🎨 Level 2 — shades for that design

```
📦 9006 · 🎨 By shade
Tap a shade:
(supplied / total bales)

🎨 Shade 11 — 5B / 9B
🎨 Shade 10 — 4B / 4B ✅
🎨 Shade 9 — 4B / 12B
🎨 Shade 4 — 4B / 6B
        ◀ Prev   1/2   Next ▶
⬅ Axis      ❌ Close     🏠 Menu
```

Most supplied first. ✅ = nothing of that shade left anywhere.

### 🎨 Level 3 — who takes this shade

```
📦 9006 · 🎨 Shade 11
Supplied 5B / 9B

👤 CJE — 3B
👤 mama kafaya — 2B

⬅ Shades     ❌ Close     🏠 Menu
```

### 🎨 Level 4 — detail

```
📦 9006 · 🎨 Shade 11
👤 CJE

📅 12 Feb 2026 — 2 Bales · 10 thans · 300 yds · ₦651,000
📅 21 Feb 2026 — 1 Bale · 5 thans · 150 yds · ₦325,500

Total: 3 Bales · 15 thans · ₦976,500

📦 Bale numbers (3)
  824, 831, 840

⬅ Customers  ❌ Close     🏠 Menu
```

Both axes are 4 levels deep:

- **By date:** design → date → customer → detail
- **By shade:** design → shade → customer → detail (dates inside the detail)

---

## Rules this must honour (already locked by the owner elsewhere)

- **Yards granularity (25-Jul):** yards appear ONLY where the line is one
  customer, on one date. In the level-4 card above each `📅` line qualifies,
  so it carries yards; the `Total` spans dates and therefore does NOT.
  Levels 1–3 are aggregates — bales only.
- **No `=` pairs** (TV-7). Use `supplied / total`, never `NB=Mt`.
- **Bale counting** via `inventoryPickers.baleGroupKey` — a bale sold as
  loose thans counts ONCE.
- **Money** stays env-admin only (`config.access.adminIds`), the same gate
  the flat report used. Never widen it in this change.
- **Buttons stay short** — long labels truncate on phones (TV-4b lesson).
- Every screen carries ⬅ Back / ❌ Close / 🏠 Menu (NAV-3), and an expired
  card self-heals to the design list.

---

## What this change removes

- The tile's **"Select view: 📦 Summary / 📅 Date-wise"** sub-menu — tapping
  📦 Design / Product wise goes straight to the design list, and the axis is
  chosen after a design is picked.
- **`buildDesignWiseReport`** and its `sdv:design_summary` branch.
- The admin **"💰 Show prices per row"** toggle (`supply_ds`) — money already
  renders inline where it means something.

---

## Two questions still open

1. **Shade sort** — plan uses *most supplied first*, matching the design
   list. The old flat Summary sorted shades by **yards**. Owner has not
   ruled; bales are the consistent choice now that yards are detail-only.
2. **`supplied / total` pair on shades** — the owner only asked for the pair
   on designs. It is the most valuable figure on the shade screen (it
   exposes slow-moving colours) but costs one extra Inventory read. Fallback
   is a plain `5B`.

---

## Implementation notes

- Extend `src/flows/supplyDetailsDesignFlow.js` rather than adding a module:
  same session, same `sdg:` namespace, new steps `pick_axis`, `pick_shade`,
  and a shade-scoped customer/detail pair. Suggested callbacks:
  `sdg:ax:date`, `sdg:ax:shade`, `sdg:s:<idx>`, `sdg:sc:<idx>`.
- `renderDesigns` already loads all Inventory rows for the supplied/total
  pair — reuse that read for shade totals rather than adding another.
- Retire the `sdv:` branch in `telegramController.js` once nothing routes to
  `design_summary` (the `sd:design` case then calls the flow directly).
- Tests: extend `test/characterization/supplyDetailsDesignFlow.test.js` —
  pin the axis fork, shade ordering, the yards rule on BOTH axes (negative
  assertions at levels 1–3), and admin-only money.

---

## Related parked work (same review, not yet scheduled)

- **Transfer browser** — designed, awaiting three owner defaults (units,
  where rejected transfers appear, access). Would replace the flat
  `📋 Transfers` tile (`transferFlow.showList`) with In transit / To dispatch /
  Completed tabs, Completed grouped by **receive date**. The receive date is
  already stored (`resolvedAt` on the approval row) — no schema change.
- **Sales Browser yards** — three genuine breaches of the yards-granularity
  rule (day list, day header, per-customer rows inside a day). Admin-only
  tile, so low visibility, but the same clutter.
- **Supply Details → Customer-wise** — the weakest of three overlapping
  customer views (📒 Customer Supplies and the Sales Browser 👤 Customer tab
  both already drill). Candidate for retirement once the owner confirms it
  is unused.
- **📊 Sales Report** — the last flat wall worth keeping for now: the only
  period-scoped report (7/30/90/365 days). Convert later.
