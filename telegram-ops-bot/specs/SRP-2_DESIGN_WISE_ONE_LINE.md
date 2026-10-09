# SRP-2 — Sales Report, Design Wise: one line per design

**Shipped 09-Oct-2026.** Owner, from a screenshot of the Design Wise report
(01 Jul – 27 Aug 2026): *"multiple times a single design is shown with the
bales and the thans sold. Can you make it show the design with how many are
sold written in brackets, first showing the bales (suffix B) + thans (suffix
T) from all the stores or warehouses"* → *"remove shade-wise view"* → *"remove
the value of the goods showing there. Else, everything is fine."*

## 1. What was wrong

The report ranked design+shade rows by value, so a design came back every
time its shades were not neighbours in the ranking, and each row printed
`39 Bales · 195 thans` — both units for the same goods, which rule 6c bans.

## 2. The screen

```
📊 Sales Report — 01 Jul – 27 Aug 2026 — Design Wise
B = whole bales · t = loose thans · yds

1. 44200 (39B) · 5,851 yds
2. 77008 (31B) · 4,930 yds
3. 9059-C (10B) · 1,800 yds
4. 77018 (10B) · 1,500 yds
5. 44201 (8B) · 1,200 yds
6. 202/201 (4B + 4t) · 720 yds
7. 9037-E (3B) · 540 yds
8. 9060-B (2B) · 420 yds

🧮 Grand Total: 107B + 4t · 16,961 yds
```

- ONE line per design; every store and warehouse is summed into the bracket.
- The bracket is the rule-6c grammar from `unitDisplayService.createQtyLabeller`
  (the same engine as 📒 Customer Supplies, 🏬 Store Sales and the audit chip):
  whole bales first, every loose than after, lowercase `t`, never both units
  for the same goods. A bale counts whole only when EVERY than of its roster
  sold in the period.
- Ranked by yards, ties by design. No shade. No money, so no money legend.
- Every design is listed: a line each needs no top-3 cut and no 🔍 Show all.
  The `rxw:sales_d` expand branch is kept only so a 🔍 Show all on a card
  sent before 09-Oct still answers (with the new report).
- Grand Total in the same grammar. Customer Wise is untouched.

## 3. Known limit (carried from rule 6c)

A whole bale sold from a than-visibility store (Kano office by default) reads
in thans — the pending engine alignment of the 31-Aug amendment. This report
agrees with Store Sales and Customer Supplies today and flips with them.

## 4. Code

`src/flows/salesReportFlow.js` `designReport(sold, periodLabel, qty)`; the
controller's `srg:` and `rxw:sales_d` branches call it (the old
`buildSalesDesignReport` is deleted).

## 5. Tests

`test/unit/flows/salesReportDesign.test.js` (grammar: whole / broken / than-
store, ranking, empty) · `test/characterization/salesReportPickDates.test.js`
(the view through the real controller).

## 6. Owner live check

📊 Reporting → 📊 Sales Report → 📆 Pick dates → 01 Jul → 27 Aug → 📦 Design
wise: every design once, `(…B + …t)` then yards, no shade line, no value, no
🔍 Show all; the Grand Total bracket agrees with 🏬 Store Sales summed over
the places for the same days.
