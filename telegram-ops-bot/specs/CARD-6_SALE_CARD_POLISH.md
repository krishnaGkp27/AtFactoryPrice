# CARD-6 — the sale approval card, one fact per line

**Shipped 10-Oct-2026.** Owner, from a screenshot of a `sale_bundle` card in
the 🛂 inbox (R-DD85, 9045, five bales from IDUMOTA and Lagos): *"I cannot see
it in a proper format. Can you reframe the layout in a more elegant manner"*;
then *"the shade mentioned in the number doesn't show the colour specified as
in the supply details … for a better understanding of the supplier approving,
knowing the facts of which colour is moving"*; *"No need to mention the label,
like cashmira … only the design number is sufficient"*; *"remove this button
chips"* (the proposed 📷 catalogue chips); and *"Let me know if there is any
redundancy?"* → the bill announced twice, the salesperson named twice.

## 1. What was wrong

CARD-3 (10-Aug) packed three bales on a line (`#1 → 1148 ×5 @IDUMOTA · 6487
×5 @Lagos · 6490 ×5 @Lagos`), so a phone wrapped them mid-number; Telegram
rendered `@Lagos` and `#1` as blue tappable links; the tally printed twice
(design line and Σ); the legend `(bale/than · #shade)` explained a grammar
nobody should need; `👤 set at approval` read like a broken field; `📎 Sales
bill` repeated the 📄 button; `🧑 Abdul` repeated the footer's `Requested by
Abdul`.

## 2. The card

```
🧾 Sale · 5B · 718 yd
📅 07-Oct-2026

9045
 1 - Dark Brown
  1148 · 150 yd · IDUMOTA
  6487 · 150 yd · Lagos
  6490 · 150 yd · Lagos
 Shade 3
  6495 · 150 yd · Lagos
  6496 · 118 yd · Lagos

Requested by Abdul · 1d ago · R-DD85
[✅ Approve] [❌ Reject]
[📄 Sales bill]
[⬅ Back to list]
[❌ Close]
```

A one-store sale puts the store on the first line and nowhere else
(`🧾 Sale · Kano office · 5t · 150 yd`). A sale of several designs gives each
design line its own tally under the header's total (`77014 · 3t · 90 yd`).
A than item keeps the owner's typed grammar (`1100/1`). A sold-already bale
keeps `⚠️` on its line and the full sentence at the foot; the BACKDATED
banner is unchanged.

- **Tally once**, on the first line. No Σ line, no legend.
- **One bale per line**: number · yards · store (store only when the sale
  ships from more than one place). Never `×N`, never `@`.
- **Shade heading = catalogue colour**, `1 - Dark Brown`, the form the cart
  block and Check Stock use, from the design's active DesignAssets entry —
  the sale's container first (CAT-C1), else the newest, else the latest of
  any status. No name on file → `Shade 3`. Never a guess. No `#`.
- **No category label.** The design number is enough (owner).
- **No `👤` line until there is a customer**; then `👤 ABBA` + phone/address.
- **No `📎` line.** The inbox has the 📄 button; the admin DM is followed by
  the file itself.
- **`🧑 <salesperson>` only when it is not the requester** the footer names.
  The inbox resolves the requester first and hands it to the builder
  (`buildCardFromActionJSON(aj, { requester })`). Surfaces that pass no
  requester (the admin DM, the hourly reminder, the seller's own confirm
  card) print the line as before.
- **No 📷 catalogue chips** (owner: "remove this button chips").

## 3. Scope

`approvalCards.buildSaleCard` is the ONE builder behind the inbox card, the
admin DM, the hourly reminder, the seller's confirm card and the Sell Bale /
Snap doors, so every surface changed together. The return card
(`buildReturnThansCard`) still prints the CARD-3 grammar — say the word.

## 4. Tests

`test/unit/services/saleBundleCard.test.js` (whole / than / mixed / two
stores / named and unnamed shades / unresolved) ·
`test/characterization/saleCardConvergence.test.js` ·
`sellKanoSaleChain` · `snapSaleFlow` · `approvalReminder`.

## 5. Owner live check

🛂 Approvals → 🧾 Sales → open R-DD85 (or any pending sale): the first line
carries the tally; one bale per line with yards and store; shade 1 reads
`1 - Dark Brown`, shade 3 reads `Shade 3` until 9045's catalogue names it; no
blue links anywhere on the card; `Abdul` appears once (in the footer).
