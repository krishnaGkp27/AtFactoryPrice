# TV-9 — a store's stock in bales and thans (Kano office included)

Shipped 23-Nov-2026. Rule: `docs/BUSINESS_RULES.md` §6c, amendment of 23-Nov-2026.

## Your words

On the 📦 Supply Request store screen (`🏭 IDUMOTA · 201B + 4t`,
`🏭 Kano office · 273t`, `🏭 Lagos · 102B`):

> "you can see that Kano office is showing only in Thans with suffix T. Make
> sure the bales which are open will always show in Thans plus the bales which
> are closed, showing all the Thans available in that will be treated as bales
> with suffix B. So please make this correction for Kano office, showing both
> in B and T."

## The rule

What a store **holds now** is counted the same way in every store, Kano office
included:

- a **closed** bale — every than of that bale still available in that store —
  counts as **1B**;
- an **opened** bale counts the thans left in it as **t**.

So `1B + 3t` = one sealed bale plus three loose thans. What was sold,
supplied, returned or moved, and carts and requests, are not touched.

## What changed on the phone

Test stock: design 9006 shade BLACK, container Jul26, every than 30 yd.
Kano office: bale 801 sealed (5 of 5), bale 802 opened (3 of 5 left), bale 803
sold out. IDUMOTA: 901 sealed, 902 opened (4 of 5 left). Lagos: 951 sealed.

| Screen | Before | After |
|---|---|---|
| 📦 Supply Request — store chips | `🏭 IDUMOTA · 1B + 4t` · `🏭 Kano office · 8t` · `🏭 Lagos · 1B` | `🏭 IDUMOTA · 1B + 4t` · `🏭 Kano office · 1B + 3t` · `🏭 Lagos · 1B` |
| 📦 Supply Request — Total line | `Total: 5 bls · 660 yds` | `Total: 3B + 7t · 660 yds` (always the sum of the chips) |
| 📦 Check Stock — Available | `Available Σ 2B + 12t · 660 yds` | `Available Σ 3B + 7t · 660 yds` |
| 📦 Check Stock — By shade | `• BLACK · 2B + 12t · 660 yds · Kano office, IDUMOTA, Lagos` | `• BLACK · 3B + 7t · 660 yds · Kano office, IDUMOTA, Lagos` |
| 🎨 Stock by shade card — ✅ Available (Kano as a store) | `✅ Available — 8t` / `801 (5t), 802 (3t)` | `✅ Available — 1B + 3t` / `801, 802 (3t)` |

On the same card, the 💰 Sold section still reads `10-Nov-26 — ABBA (7t)` /
`802 (2t), 803 (5t)`, exactly as before.

### TV-9b — the supply request's design and shade screens (23-Nov-2026)

Asked: *"should the Kano design chips change too, e.g. `9006 (1B + 3t / 3B)`,
with the second figure (stock received) in bales?"* — owner: *"Go with all
your recommendations."* Than-selling stores only (Settings
`THAN_VISIBILITY_WAREHOUSES`). Test stock, Kano office: 9006 BLACK as above
(801 sealed, 802 3 of 5 left, 803 sold out); 9045 RED 820 sealed and BLUE 821
4 of 5 left; K6 = one bale 810 of six thans in six shades, PINK and GREY sold;
T5 two bales (4/4, 3 of 4) received at Lagos and moved to Kano; a 21-character
design `LONGDESIGN-ABCDEFGHIJ` 840 sealed + 841 3 of 5 left.

| Screen | Before | After |
|---|---|---|
| Design screen — header | `📊 36t / 41t _(remaining / opening)_` | `📊 4B + 17t / 8B _(remaining / opening)_` |
| Design chip | `9006 (8t / 15t)` · `9045 (9t / 10t)` · `K6 (4t / 6t)` | `9006 (1B + 3t / 3B)` · `9045 (1B + 4t / 2B)` · `K6 (4t / 1B)` |
| Design chip, no opening at this store | `T5 (7t)` | `T5 (1B + 3t)` |
| Design chip over 34 characters | `LONGDESIGN-ABCDEFGHIJ (8t / 10t)` on the button | button `LONGDESIGN-ABCDEFGHIJ`, body line `LONGDESIGN-ABCDEFGHIJ: 1B + 3t / 2B` (the 34-character rule is unchanged; longer figures overflow more often) |
| Shade chips | `RED (5t / 5t)` · `BLUE (4t / 5t)` | `RED (1B / 1B)` · `BLUE (4t / 1B)` |
| Shade chips of a multi-colour bale (K6) | `RED (1t / 1t)` … `GREY (0t / 1t)` | `RED (1t / 1t)` … `GREY (0B / 1t)` |
| Take ALL | `✅ Take ALL 2 shades (9t)` | `✅ Take ALL 2 shades (1B + 4t)` |

- **Remaining** is what the store holds (closed bale `B`, opened bale's thans
  `t`); nothing left reads `0B`.
- **Opening** (what the slice received — GRN-anchored, in transit left out,
  as TV-6) counts a bale as `1B` only when every than of it belongs to that
  design or shade, judged against the whole bale wherever its thans sit now
  (a bale moved to another store still counts as received). So **one shade of a
  multi-colour bale reads `1t`, never `1B`** — the K6 shades above.
- **The cart.** The screen keeps its old assumption that the cart takes
  bales in sheet order: with one bale of 9006 in the cart, 801 is skipped and
  the chip reads `9006 (3t / 3B)`, the header `📊 3B + 17t / 8B`. No new
  cart rule.
- The photo combo, the album picker, the morph-back caption and the text
  picker draw the same chips.
- Bale stores keep their pair exactly: IDUMOTA `📊 4B / 4B`, `9006 (2B / 2B)`,
  `RED (1B / 1B)`, `✅ Take ALL 2 shades (2 bales)` (§6c: "stays in bales").

## What "closed" means — the honest edge cases

- **A bale split between two stores** (three thans in Lagos, two in IDUMOTA)
  reads as loose thans in each store (`3t` and `2t`), never as a bale — on
  every TV-9 screen. The supply request Total adds the chips, so it says
  `… + 5t`, not `1B`; Check Stock, which shows every store at once, adds the
  stores the same way, so its `Available Σ` equals that Total.
- **A than with no printed bale number** counts as one loose than (`1t`),
  never as a bale.
- **A than sold and later returned** is available again — if it was the only
  missing than, the bale reads closed (`1B`) again.
- **A than in transit or out as a sample** is not available, so the bale reads
  opened.
- **Two bales sharing one printed number in one container** are counted as
  one bale (the sheet has no per-bale id): when every than of both is
  available they read as ONE closed bale (`1B`, an undercount); when any than
  is gone they read as loose thans. Rare; it stays until a per-bale id exists.
- **A bale whose thans carry two container labels** (three under Mar26, two
  under Jul26 — a data slip) is counted as two bales, each closed when all its
  rows are available. Fixed by correcting the container on the sheet.

## What was NOT changed, and why

- Store Sales, Customer Supplies, Supply Details, Sales Report — they count what
  a customer took (TV-8, "packaging wins"); Kano's sold thans still read `7t`.
- Sale, return and supply cards, the cart — the same reason.
- The supply request's `🚚 In transit (2t)` chip and card, and the quantity
  card (`🏭 Kano office · 2B available` / `How many bales?`) — your word
  needed on the card, below. (The design and shade screens changed: TV-9b
  above.)
- The container and category filter chips — a stock-position count you ruled
  stays readable as it is.
- The Stock-by-shade design / shade chip `20B · 34t/120t` — your handwritten format.
- Screens that count bales by hand: Business Glance, Stock Value, Inventory
  Details, List Packages, the typed `Stock` line, transfer and Sell Bale chips,
  inline search, the web pages — each needs its own look; waiting for your word.
- No Settings key, sheet, column or approval changed.

## Your word needed

1. **The quantity card** still asks "How many bales?" and counts an opened bale
   as one bale. Should an opened bale be offered by thans there?
2. **The hand-counted screens** listed above — switch them to the same rule?

(The design and shade screens were asked here first; ruled 23-Nov-2026 and
built as TV-9b above.)

## Live check (on the phone)

1. 📦 Supply Request → the store screen: the Kano office chip reads `…B + …t`
   (not thans only), and the Total equals the chips added up.
2. Open a Kano design you know has a sealed bale → 📦 Check Stock: the
   `Available Σ` line counts it as `1B`.
3. 📊 Supply Details → 🎨 Stock by shade → Kano office → a design → a shade:
   a sealed bale is a plain number, an opened one `802 (3t)`. The ✅ Available
   header reads `…B + …t` only once the Locations sheet marks Kano office as a
   **store** (`node scripts/seed-locations.js --commit`, still pending); until
   then the header counts bales (`5 Bales`) as it always has for a warehouse.
4. 🏬 Store Sales → Kano office: the totals are the same as yesterday.
5. (TV-9b) 📦 Supply Request → Kano office: the 📊 line and each design chip
   read `…B + …t / …B`; open a design of several shades → the shade chips and
   `✅ Take ALL` use the same grammar; IDUMOTA's screens still read `…B / …B`.
