# AUD-X2 — Onboarding audit for old-container stock

**Owner request, 30-Jul-2026** (with the `Stock_Summary_by_Store.xlsx` workbook):

> "I wish to provide you a sheet which is comprised of the different designs(Bales)
> available in the stores… I will make a full audit of the design which am going to
> onboard with the correct details. Can you help me to add the extra design number in
> the audit sheet(copy and paste one) … so that I can copy and paste it for my
> warehouse manager to read through the physical details and give it back to me for my
> further auditing and reconciliation?"
>
> "Make sure you don't change any of my inventory details unless auditory conciliation
> is proofed, design by design. Still you don't have the packing details so you cannot
> place the details inside the inventory sheet. **Do not touch inventory sheet details
> at all during this audit.**"

## The rule, and how it is enforced

The audit records counts. It never moves stock. That is now pinned by a test
(`test/characterization/warehouseAuditOnboarding.test.js`, test 1) which drives a full
audit through the **real** repositories over a write-recording sheets client and
asserts the Inventory sheet is byte-identical afterwards, with no write of any kind
targeting `Inventory`, `Transactions`, `LedgerTransactions` or `ApprovalQueue`.

An audit's only writes are `StockTakes` (the counts) and `AuditLog` (the trail).

## What the workbook contains

869.6 bales · 374 rolls · 15,130 pieces · 18 cartons across 4 stores.
125 distinct design labels reached the bot; **no quantities, rates or values did** —
the audit is blind (an auditor who can see the book number confirms it instead of
counting it), and ₦ valuations do not belong in git.

| Store | Bales | Rolls | Pieces |
|---|---|---|---|
| CHINOS STR | 24 | – | – |
| IDUMOTA | 17 | 2 | – |
| MAIN OFFICE | 6 | 15 | 54 |
| CASHMERE STR | 1 | 6 | – |

Regenerate after re-cutting the workbook:

```
node scripts/build-onboarding-stock.js <Stock_Summary_by_Store.xlsx>
```

## Locked decisions

| # | Decision | Why |
|---|---|---|
| 1 | A design number is **not** a key — labels carry the product when ambiguous | CHINOS STR holds `45008` as **both** Chinos (256.6 bales) and DMS (9 bales); MAIN OFFICE holds `45010` in bales *and* rolls. One line could not mean both. |
| 2 | Labels are asserted **whitespace-free** at generation | The batch parser reads a design as the first whitespace-free token; a label with a space could not round-trip. |
| 3 | One count sheet = one packaging unit | "Socks = 12+5" is meaningless on a bales+bundles sheet. A mixed store picks its unit first. |
| 4 | Counts for unknown designs are **recorded**, never rejected | `result=new_design` rows in StockTakes, `sheet_*` = 0. They are the onboarding audit's entire output. |
| 5 | Onboarding data lives in a generated repo module, not a Sheet | No new state sheet (storage rule 5b); the list is a one-time onboarding artefact, not a business ledger. |
| 6 | Reconciliation into Inventory stays **manual** | Per the owner: not until proofed, design by design — and the packing detail (bale numbers, than counts) does not exist yet. |

## Defects this exposed and closed

1. **The filled sheet was being eaten.** Pasting the manager's reply while the ➕ prompt
   was open stored the `AUDIT <store>` header as a design, dropped every
   `9032 = 12+5` line, and replied "Added 1 design(s)". The counts were lost silently.
2. **An audit could reach Inventory.** Text typed mid-audit fell through to the rest of
   the controller. With a pending sale enrichment (held in `approvalEvents`' own map,
   which starting an audit does not clear) a bare number could be taken as that sale's
   rate or amount paid and execute it.
3. **Real design codes were shattered.** `3001,YC-01`, `55170-A,YC-03` and
   `47014,2084/01` were split in half by comma-splitting.
4. **`402/9059 (08) = 12` errored** — the very format the ➕ prompt taught.
5. **Stores holding only old stock were unreachable** — absent from the picker and
   rejected in an `AUDIT` header, because the warehouse list came purely from
   Inventory rows.
6. **StockTakes count columns had blank headers** — `counted_bales`, `counted_bundles`
   and `note` have been written since WAU-3 but were never declared, so the physical
   count landed in an unnamed column.

## Owner actions

- [ ] **Locations.** CHINOS STR / CASHMERE STR / MAIN OFFICE currently fall to Lagos by
      the name heuristic. Set `LOCATION.<store>` rows in Settings if any belong
      elsewhere.
- [ ] **Partial bales.** The workbook carries fractions (256.6, 2.4). The count format
      is whole bales `+` loose bundles — `256+6`, not `256.6`. Tell the manager.
- [ ] **`1,2…..9`** appears as a design for Ladies Gown (pieces) — free text in the
      design column. Harmless, but it will show on a pieces sheet.
- [ ] **Not fixed, pre-existing:** `schemaMapper` re-checks the Inventory **header row**
      on every boot and rewrites it when a column name is missing or spelled
      differently (`src/services/schemaMapper.js:472-508`). Header row only — no data
      row is touched — but it is the one place a deploy can write to Inventory. Left
      alone deliberately; worth a look before the reconciliation phase.
