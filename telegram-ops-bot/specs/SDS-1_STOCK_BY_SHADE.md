# SDS-1 — 🎨 Stock by shade (available vs sold vs in-transit bale numbers)

**Owner request (07-Aug-2026, layout confirmed):** "on tapping the
particular colour … show me the bale number which is available and the
bale number which is sold inside this … in supply details only for admin
or dispatcher (Abdul)." Hand-drawn card: design — warehouse header, shade,
an Available bracket of bale numbers, a Sold bracket of
`number — date — customer` lines.

Survey verdict (07-Aug three-reader sweep): **no existing screen** showed
available + sold numbers together for a design+shade — every drill was
single-status (pickers list available only; Supply Details / Customer
Supplies list sold only, sliced per customer+day). Closest was the
one-bale NLP card (`Details of Bale N`).

## Locked decisions

- **Path:** 📦 Supply Details → **🎨 Stock by shade** (button visible only
  to eligible users) → warehouse → design → shade → card.
- **Access:** admins (`auth.isAdmin`) **plus active users in the
  `Dispatch` department** (`usersRepository.findByDepartment('Dispatch')`)
  — there is no durable dispatcher role; the department is the durable
  equivalent the bot already uses for dispatch notifications.
- **Card blocks:** ✅ Available (numbers, comma list) · 💰 Sold
  (`number — DD-MMM-YY — customer`, oldest → newest) · 🚚 In transit
  (`number → destination`), which only renders when non-empty and is
  NEVER merged into the others (owner's in-transit bucket ruling).
- **In-transit scope:** design+shade wide, not warehouse-filtered — an
  in-transit row's Warehouse column holds the DESTINATION, so a travelling
  bale belongs to no store yet and must not vanish from the origin's view.
- **Part-taken bales appear on BOTH sides** with TV-8 (§6c) labels from
  `unitDisplayService.createQtyLabeller` — e.g. `9830 (2t left)` under
  Available and `9830 (3t) — date — customer` under Sold. A whole-bale
  line carries no annotation.
- **Container bifurcation (§6b):** when the card's rows span more than one
  arrival container, Available groups per container and Sold/In-transit
  lines carry the container tag — a re-used printed number never merges.
- **Counts in block headers are bales-only** (`— 8 Bales`) — the owner's
  stock-position exception to §6c.
- Sold rows missing a date/customer still render (with `—`) — this is a
  reconciliation surface; hiding an odd row is worse than showing the gap.

## Shape

`src/flows/stockByShadeFlow.js`, session `stock_by_shade_flow`, namespace
`sds:` (`sds:start` from the Supply Details view menu, `sds:w:` warehouse,
`sds:d:`/`sds:pg:` design, `sds:s:` shade, `sds:back`, `sds:designs`).
Controller wiring: one prefix-dispatch line + the conditional view button
in the two `supply_details` cases (explicitly owner-requested feature).
Shade names via the DesignAssets catalog (`buildShadeLabel` — "11 - White").
