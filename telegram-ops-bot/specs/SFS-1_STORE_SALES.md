# SFS-1 — 🏬 Store Sales (sales by warehouse / store)

**Status:** SHIPPED 22-Sep-2026 (owner go on the refined layout the same day); hardened the same day after an adversarial review (§7).
**Owner's words (22-Sep):** "I want to see all the sales which have taken place from
selected warehouses/stores/office selected … similarly to what I have attached in the
picture" (the 📒 Customer Supplies day-chip screen) — then, on the first proposal:
"As an admin I just need the tappable chips for existing warehouses or the stores on
screen 1. After I tap in the chips it will show me their sales … **No more
functionalities, no more unnecessary items.**"

## 1. What it is

Three read-only screens, reached from 📊 Reporting → 🏬 **Store Sales**. Admin-only at
shipping; since **SSA-1 (24-Sep-2026)** an employee an admin has ticked places for
sees exactly those places (one place → straight onto its day tiles, no Change place;
nothing ticked → tile hidden, stale tap refused). See `specs/SSA-1_SALES_ACCESS.md`.

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
- **Day identity:** `dayKey` — the shared `normalizeSalesDate` (ISO · DD-MM-YYYY ·
  D/M/YYYY · month names all collapse to one day); a cell it rejects keeps its text.
- **Quantities:** `unitDisplayService.createQtyLabeller` — bales vs thans per the
  `THAN_VISIBILITY_WAREHOUSES` setting, whole vs part-taken bale per the TV-8 roster.
  The header total is the place's whole history in one label, not a sum of per-day
  bale counts (a bale sold across two days is not counted twice).
- **Bale numbers on screen 3:** one entry per physical bale (`baleGroupKey`), sorted
  numeric-aware; three thans of bale 5804 print `×3t (5804)`.

## 3. Rules kept

- **Locked layout, nothing added.** A sold row whose warehouse cell is blank belongs
  to no warehouse or store and forms **no chip** (the row is still listed by
  📒 Customer Supplies). *Ruling owed:* if you want such rows surfaced here, say so
  and they get one last `Unassigned` chip in the LOC-1 word — not built unasked.
- **One bale, one line.** Design and shade buckets are case-folded the way the bale
  identity is (ISC-1 C11: `Navy Blue` / `navy blue` on the thans of one bale), so a
  bale prints once under one header and the line agrees with the `1B` in the header.
  The first spelling seen is the label.
- **No fabricated dates.** The sheet's soldDate is normalised once at parse; a cell
  the normaliser rejected (`08/19/2026`, `31-02-2026`) keeps its cell text as its day
  key and tile label instead of being re-converted into an impossible or rolled date.
- **Never cut silently.** A day card that would pass Telegram's message cap keeps
  as many whole lines as fit and ends with `_…and N more lines_`; the cut never
  strands a customer or design header with nothing under it.
- **Legacy-Markdown-safe.** Inside a `*bold*` entity Telegram honours no escapes (a
  backslash would print), so names are bolded with the Bot API's close-and-reopen
  recipe (`2*2` → `*2*\**2*`); outside entities `* _ \` [` are escaped and `]` never
  is (legacy Markdown has no `\]` escape). Same rule as CART-PEEK.
- **A returned than leaves its sale day.** It is no longer `sold`, so it drops off —
  exactly as Customer Supplies behaves. A day whose thans were all returned reads
  `_Nothing found — it may have been returned._`.
- **The card is edited, never duplicated.** ❌ Close and the no-sales screen edit the
  tapped card into `🏬 Closed.` / `_No sales recorded yet._` in place and only then
  end the session; screen 1's 🏠 Back to menu (`sfs:menu`) ends the session **first**
  and then hands the tap to the controller's own menu path, so the greeting menu is
  never left anchored to a dead session for the janitor to delete half an hour later.
  A tap on an old card after the session ended takes that card's buttons down and
  answers with one line and a 🏠 Back to menu button — once.
- **A tile tapped over a live flow is a walk-out, not a silent overwrite.** `start()`
  disposes the previous flow's auxiliary messages (SJ-4) and ends its session with
  `cancelled`, so the janitor's instant cleanup and ANL-2 both hear it — the same
  handoff the controller does before a transfer takes over.
- **Index-carrying callbacks** (`sfs:w:<i>`, `sfs:d:<i>`) resolve against the list
  the session rendered, so a payload never exceeds 64 bytes; a tap on the wrong step
  or an out-of-range index is ignored.

## 4. Wiring

| Piece | Where |
|---|---|
| Flow | `src/flows/storeSalesFlow.js` — `SESSION_TYPE = 'store_sales_flow'`, namespace `sfs:` (`menu` · `close` · `back` · `w:<i>` · `d:<i>` · `pg:<n>`) |
| Tile | `activityRegistry` `store_sales` · 🏬 Store Sales · hub `reporting` |
| Controller | one `FLOW_CALLBACK_ROUTES` line (`sfs:`) + one `act:` case `store_sales` (owner go 22-Sep covered the controller edit) |
| Usage | `usageTracker.PREFIX_FEATURES` maps `sfs:` → `store_sales` so tile and in-flow taps roll up under one feature (ANL-1) |
| Tests | `test/unit/flows/storeSalesFlow.test.js` (grouping, every screen's whole text and buttons, paging, cut rule, escaping, handoff, guards) · `test/characterization/storeSalesFlow.test.js` (tile → places → days → day card and the menu exit through the real controller; non-admin refused) |

**Who sees the tile.** The menus decide visibility with the env `ADMIN_IDS` list:
those admins see every tile. Everyone else — including a Users-sheet-promoted admin
(USR-C3b) — sees 🏬 Store Sales only if one of their departments' `allowed_activities`
lists `store_sales` (the seeded `Admin` department's `__all__` covers it). The gate in
`start()` (`auth.isAdmin`, env ∪ sheet admins) then refuses a non-admin in one line:
`🏬 Store Sales is admin-only.` — the sheet can show the tile, never widen the gate.

## 5. Owner live check

1. 📊 Reporting → 🏬 Store Sales: one chip per selling place, alphabetical, nothing
   else but 🏠 Back to menu (which returns you to the greeting menu in the same
   message).
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
- Surfacing blank-warehouse sold rows under an `Unassigned` chip (§3, ruling owed).
- A legacy unnumbered bale prints `?` here and blank in 📒 Customer Supplies for the
  same rows (`×2B (?, ?)` vs `×2B (, )`); aligning Customer Supplies to `?` is a
  one-line follow-up in `soldBalesFlow`, outside this change.
- House-wide, not this flow: the controller's `act:__back__` leaves any flow's session
  alive, so every flow whose screen carries a session-free 🏠 Back to menu (📒 Customer
  Supplies included) parks a session on the menu message for the janitor. SFS-1 owns
  its exit instead; fixing it once in the controller is an ask-first edit.

## 7. Adversarial review, 22-Sep-2026 (same day as shipping)

Four finders (data · Telegram · sessions · rules), two independent refuters per
finding, 15 findings, 14 confirmed by reproduction against the real modules. Closed:

| # | Finding | What changed |
|---|---|---|
| 1 | one bale printed once per shade/design spelling, disagreeing with the header's bale count | design/shade buckets case-folded, first spelling kept |
| 2 | a DMY cell the normaliser rejected was re-converted into `2026-19-08` / a rolled date | `dayKey` = `normalizeSalesDate(cell) \|\| cell`; `prettyDate` formats ISO only, in UTC |
| 3 | backslash-escaped names inside `*bold*` showed the backslash; a `*` in a name 400'd the card | `bold()` close-and-reopen; `mdEsc` outside entities, `]` never escaped |
| 4 | ❌ Close / no-sales sent a fresh bubble and left the old buttons live | render first, then clear — the card is edited in place |
| 5 | a stale tap answered with a new notice every time | the old card's keyboard is stripped first |
| 6 | screen 1's `act:__back__` left the session anchored to the greeting menu; the janitor would delete the menu | `sfs:menu` ends the session, then the controller's menu path draws the menu |
| 7 | `start()` overwrote another flow's live session silently | SJ-4 handoff: `disposeAux` + `clear('cancelled')` |
| 8 | screens 1 and 2 were regex-matched, so an added line passed the tests | pinned whole with `assert.equal` |
| 9 | the `❔ No place recorded` chip was outside the locked layout and not what LOC-1 says | removed; ruling owed (§3) |
| 10 | `sfs:` missing from `usageTracker.PREFIX_FEATURES` | mapped to `store_sales` |
| 11 | spec note on tile visibility did not cover sheet-promoted admins | §4 rewritten |

Kept as is, documented (§6): `?` for an unnumbered bale (Customer Supplies prints
blank); a printed number reused across two containers prints twice by design (they
are two bales — refuted finding).
