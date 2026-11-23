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
- The supply request's design and shade screens (the `📊 8t / 15t` line, the
  design and shade chips, Take ALL, the `NB available / How many bales?` card) —
  your word needed, below.
- The container and category filter chips — a stock-position count you ruled
  stays readable as it is.
- The Stock-by-shade design / shade chip `20B · 34t/120t` — your handwritten format.
- Screens that count bales by hand: Business Glance, Stock Value, Inventory
  Details, List Packages, the typed `Stock` line, transfer and Sell Bale chips,
  inline search, the web pages — each needs its own look; waiting for your word.
- No Settings key, sheet, column or approval changed.

## Your word needed

1. **The supply request's design and shade screens.** Should a Kano design chip
   read e.g. `9006 (1B + 3t / 3B)` — and is the "opening" half in bales or thans?
2. **The quantity card** still asks "How many bales?" and counts an opened bale
   as one bale. Should an opened bale be offered by thans there?
3. **The hand-counted screens** listed above — switch them to the same rule?

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
