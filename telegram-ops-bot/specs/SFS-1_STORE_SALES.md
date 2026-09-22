# SFS-1 — 🏬 Store Sales (sales by warehouse / store)

**Status:** SHIPPED 22-Sep-2026 (owner go on the refined layout the same day).
**Owner's words (22-Sep):** "I want to see all the sales which have taken place from
selected warehouses/stores/office selected … similarly to what I have attached in the
picture" (the 📒 Customer Supplies day-chip screen) — then, on the first proposal:
"As an admin I just need the tappable chips for existing warehouses or the stores on
screen 1. After I tap in the chips it will show me their sales … **No more
functionalities, no more unnecessary items.**"

## 1. What it is

Three read-only screens, admin-only, reached from 📊 Reporting → 🏬 **Store Sales**.

| Screen | Shows | Buttons |
|---|---|---|
| 1 `pick_place` | `🏬 *Store Sales*` / `Tap a place to see its sales.` | one plain chip per warehouse / store that has sold anything, alphabetical, two per row · `🏠 Back to menu` |
| 2 `pick_date` | `🏬 *Sales — IDUMOTA*` / `Total: *1B + 5t* · *224* yds` / `across *2* sale days · first: 18 Aug 2026` / `_Tap a date for the day's detail._` | one wide tile per day `19 Aug 2026 — 5t (164 yds)`, newest first, 8 per page · `⬇ Older (N more)` / `⬆ Newer` · `🏬 Change place` · `❌ Close` |
| 3 `view_day` | `🧾 *IDUMOTA* · 19 Aug 2026` / `_5t sold · 164 yds_` then per customer `👤 *ABBA*` / ` 🧵 *202/201*` / `  • Shade 1 ×3t (5804)` | `⬅ Dates` · `❌ Close` |

Nothing else appears on any screen: no value line, no sale-doc chip, no full-details
chip, no city shortcuts, no multi-select (all cut by the owner's second message).

## 2. Where the numbers come from

- **Source:** `inventoryRepository.getSoldRows()` — one row per sold than, and every
  sold row keeps the `warehouse` it was sold FROM (`markThanSold` / `markPackageSold`
  copy the than's own warehouse back into the row). So "everything IDUMOTA sold, by
  day" is a read-time filter on the same rows 📒 Customer Supplies is built from.
- **Nothing written**, no new column, no new sheet, no Settings knob.
- **Place identity:** the warehouse cell trimmed and case-folded (`idumota` and
  `IDUMOTA` are one chip, labelled with the first spelling seen).
- **Day identity:** `normDay` (ISO · DD-MM-YYYY · DD/MM/YYYY all collapse to one day),
  the same normaliser Customer Supplies uses.
- **Quantities:** `unitDisplayService.createQtyLabeller` — bales vs thans per the
  `THAN_VISIBILITY_WAREHOUSES` setting, whole vs part-taken bale per the TV-8 roster.
  The header total is the place's whole history in one label, not a sum of per-day
  bale counts (a bale sold across two days is not counted twice).
- **Bale numbers on screen 3:** one entry per physical bale (`baleGroupKey`), sorted
  numeric-aware; three thans of bale 5804 print `×3t (5804)`.

## 3. Rules kept

- **A place is never hidden (LOC-1).** A sold row whose warehouse cell is blank would
  otherwise vanish from every chip's total, so such rows sit under one last chip
  `❔ No place recorded` — shown only when at least one exists. On a clean sheet the
  chip never appears.
- **Never cut silently.** A day card that would pass Telegram's message cap keeps
  as many whole lines as fit and ends with `_…and N more lines_`; the cut never
  strands a customer or design header with nothing under it.
- **Markdown-safe.** Place, customer, design, shade and bale strings are escaped
  (`mdEscape`) before they enter the card.
- **A returned than leaves its sale day.** It is no longer `sold`, so it drops off —
  exactly as Customer Supplies behaves. A day whose thans were all returned reads
  `_Nothing found — it may have been returned._`.
- **Index-carrying callbacks** (`sfs:w:<i>`, `sfs:d:<i>`) resolve against the list
  the session rendered, so a payload never exceeds 64 bytes; a tap on the wrong step
  or an out-of-range index is ignored; a tap on an expired card answers with one line
  and a 🏠 Back to menu button.

## 4. Wiring

| Piece | Where |
|---|---|
| Flow | `src/flows/storeSalesFlow.js` — `SESSION_TYPE = 'store_sales_flow'`, namespace `sfs:` (`close` · `back` · `w:<i>` · `d:<i>` · `pg:<n>`) |
| Tile | `activityRegistry` `store_sales` · 🏬 Store Sales · hub `reporting` |
| Controller | one `FLOW_CALLBACK_ROUTES` line (`sfs:`) + one `act:` case `store_sales` (owner go 22-Sep covered the controller edit) |
| Tests | `test/unit/flows/storeSalesFlow.test.js` (grouping, every screen's exact text and buttons, paging, cut rule, guards) · `test/characterization/storeSalesFlow.test.js` (tile → places → days → day card through the real controller; non-admin refused) |

Non-admins see the tile only if a department's `allowed_activities` lists
`store_sales`, and are then told `🏬 Store Sales is admin-only.` — the gate lives in
`start()`, so the sheet cannot widen it.

## 5. Owner live check

1. 📊 Reporting → 🏬 Store Sales: one chip per selling place, alphabetical, nothing
   else but 🏠 Back to menu. If a `❔ No place recorded` chip appears, some sold rows
   have a blank warehouse cell — tap it to see which days, then fix the cells.
2. Tap IDUMOTA: the header total and the day tiles should agree with what
   📒 Customer Supplies prints for the same days when its customers are added up.
3. Tap a day: every customer who bought from that place that day, with design,
   shade, quantity and bale numbers; no money anywhere.
4. ⬅ Dates → 🏬 Change place → ❌ Close.

## 6. Deliberately not built

- City shortcuts / multi-place selection, the value line, the sale-doc chip and the
  full-details card (first proposal, cut by the owner).
- "Sold that day, including thans returned later" — needs the movement trail, not
  the sold rows; say the word if you want it.
