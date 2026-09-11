# UX-2 — Card alignment sweep: short, crisp, one fact per line

**Status: PROPOSAL — awaiting the owner's go (11-Sep-2026).** Single-pass
review of every Telegram card the bot renders, prompted by the supply cart:

```
🛒 Supply Cart — 🏭 IDUMOTA
━━━━━━━━━━━━━━━━━━━━━━
🧵 202/201 │ Shades: 1 - White, 3 - Navy Blue │ ×2 bls
━━━━━━━━━━━━━━━━━━━━━━
📦 Total: 2 bales
```

Why it cannot align: Telegram draws cards in a proportional font about 32
characters wide, so a line built as three "│" columns wraps at a random
point and nothing lines up. The same card names one unit two ways ("×2
bls", "2 bales"), neither of them the locked rule-6c grammar (`2B`), and
the 22-character rule lines add nothing on a phone.

## 1 · Five rules for every card

1. **One fact per line.** No "│", "|" or "—" pseudo-columns; "·" is the
   only inline separator.
2. **Design is a header line, shades are bullets.** `🧵 202/201 · Cashmere`
   then `  • 3 - Navy Blue · 1B` (shade text stays `formatShadeRef`).
3. **Quantities in the rule-6c grammar, tallies as Σ.** `2B`, `5t`,
   `4B + 8t`, `Σ 2B · 60 yd`, always through `unitDisplayService`. Never
   "bales", "bls", "thans", "container(s)" or "item(s)" as a count word.
4. **No rule lines inside a card.** A blank line separates blocks.
5. **Header = `emoji Title · 🏭 Warehouse`; the requester's own cards use
   label-less fact lines** (`👤 CJE` · `🧑 Abdul` · `💳 Not yet paid` ·
   `📅 12 Sep 2026`), as the "submitted" card already does. Approver
   cards keep a label only where it removes ambiguity.

## 2 · The cart card (the owner's example) — before / after

```
🛒 Supply Cart · 🏭 IDUMOTA

🧵 202/201
  • 1 - White · 1B
  • 3 - Navy Blue · 1B

Σ 2B
```

Mixed quantities read naturally (`• 1 - White · 2B`); today's fold hides
them inside "1×2, 3×1". **One fix, six cards:** the line is built by
`src/utils/cartFormat.js`, used by the cart, the confirmation, the
submitted card, the Dispatch full card and the assignment card; the
approval card (`approvalCards.buildSupplyRequestCard`) builds its own
lines and joins the same formatter. The `bls` word comes from the
ProductTypes sheet's `container_short`; the formatter stops using it and
prints rule-6c letters.

## 3 · Every other surface, ranked

| # | Surface | Where | Class | Problem |
|---|---|---|---|---|
| 1 | Supply approval card | `approvalCards.buildSupplyRequestCard` | C, D | `Total: 2 container(s)` — the word §6b bans; `202/201 Shade 3 × 1` ignores the shade name every other card shows |
| 2 | Dispatch compact / full cards, assignment card | `approvalEvents` ~1304, ~1323, ~2246 | A, C, F | rule lines + `📦 Total: *2 bales* across *1 design*` |
| 3 | Confirmation card | controller `showSupplyConfirmation` | D, E | "Supply Request Summary" + `Customer: X` labels while the submitted card is label-less |
| 4 | Design picker header | controller `showDesignsForWarehouse` | B, E | six facts in one header: `📦 Warehouse: IDUMOTA · 📦 Others` / `📊 Total: 217B / 419B · 💰 0` / `🛒 Cart: 2 item(s)` / `Select design: (1–8 of 15)` / `(remaining / opening)`; `💰 0` is a bare zero when no price is set |
| 5 | Quantity card + sold-out card | controller `showQuantityPicker` | A, C | `📦 202/201 │ Shade: 3 - Navy Blue │ 🏭 IDUMOTA` then `4 bales available` |
| 6 | "added to cart" caption | controller `detachShadePhotoAfterQuantity` | E | `✅ 202/201 · Shade 3 - Navy Blue × 1 added to cart` |
| 7 | Check Stock | controller `sendCheckStockReport` | C | `Available: 7 bales (28 thans), 840 yards` prints both units for one stock (banned by §6c; OPEN_ITEMS 12f); `Shade 3: 2 Bales, 60 yds (IDUMOTA)` |
| 8 | List Bales | controller ~3070 | C | `Bale 5804 (Lagos): 5/5 thans avail, 150 yds` · `Total: 3 Bales, 450 yards` |
| 9 | Customer picker header | controller `showSupplyCustomerPicker` | F | rule line under "Select customer:" |
| 10 | Stock Value | controller ~3187 | D | `🧮 Grand Total:` where every other card says Σ |
| 11 | Sale approval card legend | `approvalCards` ~266 | E | `(bale/than · #shade)` reads as code |
| 12 | Inventory Details | controller ~508 | B | dense number runs per shade; a genuine table — the honest fix is a monospace block, or fewer columns |
| 13 | Customer history report | controller ~1396 | F | one rule line |

Clean already: every flow module under `src/flows/` (their "━━" hits are
code comments), the inbox rows, the sentinel report, the evening expense
report (a 10-character rule between two lists, kept).

### Before / after, high and medium

**1 · Supply approval card**
```
Supply Request · 🏭 IDUMOTA
👤 CJE · 🧑 Customer direct
💳 Not yet paid · 📅 12 Sep 2026

🧵 202/201
  • 1 - White · 1B
  • 3 - Navy Blue · 1B

Σ 2B
📎 Bill attached
```

**2 · Dispatch compact card**
```
📦 Supply request · needs Dispatch
🏭 IDUMOTA · 👤 CJE · 📅 12 Sep 2026
Σ 2B · 1 design
```
The full card and the assignment card take the §2 cart block in place
of their rule-lined block.

**3 · Confirmation card**
```
📦 Supply request · 🏭 IDUMOTA

🧵 202/201
  • 1 - White · 1B
  • 3 - Navy Blue · 1B

Σ 2B
👤 CJE · 🧑 Customer direct
💳 Not yet paid · 📅 12 Sep 2026

📎 Receipt photo or PDF, or Skip.
```

**4 · Design picker header**
```
🏭 IDUMOTA · Others
📊 217B / 419B  (remaining / opening)
🛒 2 in cart

Select design (1–8 of 15)
```
`💰` appears only when the value is above zero.

**5 · Quantity card**
```
🧵 202/201 · 3 - Navy Blue
🏭 IDUMOTA · 4B available

How many bales?
```

**6 · Caption** → `✅ 202/201 · 3 - Navy Blue · 1B in cart`

**7 · Check Stock**
```
📦 202/201 · Cashmere
Selling 1,450/yd
Available Σ 7B · 840 yd

By shade
  • 1 - White · 3B · 360 yd · IDUMOTA
  • 3 - Navy Blue · 4B · 480 yd · IDUMOTA, Lagos
🚚 In transit 2B → Kano office
```
(than-visibility stores print `28t`, per §6c — `createQtyLabeller`.)

**8 · List Bales**
```
📋 202/201 bales
  • 5804 · Lagos · 5/5t · 150 yd
  • 5805 · Lagos · 3/5t · 90 yd

Σ 2B · 240 yd
```

Lows (9–13): drop the rule lines; `Σ` for Grand Total; drop the legend
line on the sale card; Inventory Details either becomes a monospace
block (aligned by definition) or loses the sold-% column.

## 4 · Order of work (after the owner's go)

1. `cartFormat.formatCartLines` → the §2 block (one formatter, six cards)
   + `buildSupplyRequestCard` on it. Tests pin every card that inherits it.
2. Controller template changes 3–6, 9, 13 (surgical, one commit each door).
3. Check Stock + List Bales onto `createQtyLabeller` (closes OPEN_ITEMS
   12f for these two).
4. Lows.

Tests that pin today's text (update deliberately): `test/characterization/
supplyFlow.*.test.js`, `supplyCart.transferHandoff.test.js`,
`test/unit/utils/cartFormat*.test.js` (if present), `approvalCards` tests
for the supply card, `checkStock` / `listBales` characterization files.

## 5 · One question

Does the design's category name stay on the cart header (`🧵 202/201 ·
Cashmere`)? Recommended: yes on approver cards, dropped on the
requester's own cards, where the design code is enough.
