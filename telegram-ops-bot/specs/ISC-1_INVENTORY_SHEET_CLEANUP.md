# ISC-1 — Inventory sheet cleanup: analysis and correction plan

**Status: ANALYSIS + PLAN, no code (08-Sep-2026).** Source: the owner's
`Inventory_Sept4_1.pdf` (33 pages, the bot-managed `Inventory` tab as of
04-Sep-2026), parsed offline row by row. Nothing here touched the live
sheet. Owner rulings R1–R11 (§5) unlock the guarded one-offs in §4.

Companion documents: `docs/SHEET_AUDIT_2026-08-14.md` (F3 container-label
trap, SDN-2 date normaliser), `specs/DATA-INTEGRITY_PLAN.md` (sentinel,
bale identity), `specs/CUS-1_CUSTOMER_ENTITY.md` (aliases / merge),
`specs/EDB-1_EDIT_BALE.md` (the correction door for physical attributes).

---

## 1 · What the sheet holds

| Measure | Value |
|---|---|
| Rows (one row = one than) | 6,153 |
| Physical bales (design · number · container) | 1,246 |
| Designs | 35 |
| Containers (`arrival_batch`) | 2 — Mar26 2,929 rows · Jul26 3,224 rows |
| Warehouses | 3 — IDUMOTA 2,923 · Lagos 2,500 · Kano office 730 |
| Status | available 3,254 · sold 2,899 |
| Distinct `SoldTo` strings | 32 |

Clean already (no action): `Status` has two lowercase values; every
sold row has a buyer and a date, no available row has either; `ThanNo`
is contiguous inside every bale with no duplicates; no printed number is
reused across two (design, indent) pairs; no bale spans two warehouses,
shades or prices.

---

## 2 · Findings

### 2a · Dates — why a date filter fails (the owner's complaint)

`SoldDate` (column M, 2,899 filled cells) holds **five shapes**:

| Shape | Rows | Bot reads it? | Sheets date filter sees it? |
|---|---|---|---|
| `22-April-2026` (day-monthname-year) | 1,492 | yes | only if the cell is a real date |
| `2026-08-05` (ISO) | 1,202 | yes | only if the cell is a real date |
| `07 April 2026` (spaces) | 50 | yes | only if the cell is a real date |
| `13-04-2026` (day-month-year numeric) | 50 | yes (as D-M-Y) | only if the cell is a real date |
| `cashmere 12-February-2026` · `cashmere 2026-07-27` | **105** | **no** | **never** — it is text |

- The 105 word-prefixed cells are 44200 sales to `madam oshodi` (75,
  Feb) and `Madam motunrayo` (30, Jul). The read-side normaliser
  (`isoDay` → `normalizeSalesDate`) returns them unparsed, so those 21
  bales fall outside every date window and sort after every real day
  (Supply Ledger day keys, sales windows, the movement ledger).
  `cashmere 2026-07-27` was typed in July, after SDN-1 made the bot write
  ISO — so this is a HAND edit, and nothing today reports it.
- The other four shapes are the SDN-2 finding: same instant, different
  per-cell number format. The display fix, `scripts/format-date-columns.js
  --commit`, is still an unrun owner step from the 14-Aug audit.
- `DateReceived` (K) is all ISO but carries two meanings: Jul26 rows hold
  the GRN day (2026-07-13); the 2,925 Mar26 rows hold **2026-02-24, the
  day the sheet was imported**, not an arrival, with four hand-edited
  exceptions (9006 bales 6189/6199/6210/6224, Feb 20–23). Any "days in
  stock" reading is wrong for 48% of rows; the container label is the
  real arrival marker.
- `UpdatedAt` (P) is an ISO timestamp with `T…Z` — text to Sheets, so no
  date filter — and it is the BOOKING time, not the sale time: of 1,202
  ISO-dated sales, 914 were booked one or more days after the sale day
  (up to 122 days). Never filter sales on it.
- `addedAt` (S) has three shapes: full timestamp (3,224) · bare day
  `2026-02-24` (76) · blank (2,853).

### 2b · Customers — duplicates and why a merge alone does not fix them

`SoldTo` (L) is free text, no `customer_id`. Clusters in the 32 strings:

| Likely one person | Variants (thans, store, months) |
|---|---|
| Awunawu | `Awunawu` 205 (Lagos, Mar–May) · `Awurawu` 30 (Lagos/IDUMOTA, Jun–Jul) · `awunawu` 15 (IDUMOTA, Aug) |
| Oshodi | `madam oshodi` 75 (Feb) · `oshodi madam` 25 (Feb) · `Oshodi alaja` 20 (Mar) · `Alhaja oshodi` 50 (Apr) — 170 thans over four spellings |
| Ketu? | `Ketu madam` 150 · `ketu police Man` 55 — probably TWO people, confirm |

Casing is mixed (`CJE`, `ABBA`, `OKESON` upper; `sir pee`, `keyus`,
`chima` lower). Whether each variant also exists as its own Customers
row cannot be seen from this PDF; the sentinel's C5 check DMs admins when
a name resolves to nobody, so silence there means every variant resolves
to SOME customer — possibly a duplicate one.

Structural point: CUS-1 Merge Customers folds a typo into `aliases` on
the canonical row, and alias-aware readers (My Collection, Supply Ledger,
statement, the web API) then unify the history. But **seven readers still
compare the raw cell** — `soldBalesFlow` (exact match), `supplyDetailsFlow`,
`supplyDetailsDesignFlow`, `queryEngine`, and three controller reports
(case-insensitive) — so after a merge the same customer is one person on
some screens and three on others. The durable fix is to rewrite the cell
to the canonical spelling (§4, 2b) and keep the alias for history.

### 2c · Codes and spellings

- **Shade (E), 22 values.** `4-5` (77018/950) vs `4-5.` (75142/6483), plus
  `2-6.` and `7-3.` — trailing dots on one design only, so one shade shows
  as two chips. 188 blank shades: five suffixed designs (`9037-D`,
  `9037-E`, `9059-C`, `9060-A`, `9060-B`) carry NO shade — the letter IS the
  shade — while `9037` proper has shades 1–12 and `9043-A/-B`, `9031-C/-D`,
  `9018-A/-B` carry a suffix AND numeric shades. Three conventions for one
  concept. `BLACK`, `BLUE`, `MIX` words sit beside numerals. Three `9043-A`
  Mar26 rows have no shade at all.
- **Design (D).** `SAMPLE` (bale 6497, indent `SHIPMENT`, shade `SHIPMENT`,
  11 yd, available) is a placeholder booked as stock — it appears in every
  design picker. `R-R` (55 thans, indent `BALENO`, shade `MIX` on 19) puts
  brand words in code fields.
- **Indent (B), 16 values.** 13 follow `XX/nnnn`; `CV SIRO`, `BALENO`,
  `SHIPMENT` are not indents.
- **Warehouse (I).** `IDUMOTA` / `Lagos` / `Kano office` — three casing
  styles, and `Lagos` names a store with the city's name while IDUMOTA is
  also in Lagos. LOC-1 maps stores to cities, but the label itself is what
  reports print.
- **Header A1** prints as `.` in the PDF where the bot expects `PackageNo`
  (schemaMapper rewrites the header row at boot — check the live cell).

### 2d · Quantities and money

- **Yards (G).** 5,585 of 6,153 rows are 30. **64 rows are 40 yd or more**
  (38 at exactly 60) across 20 designs — the 6061 pattern, two 30-yd
  thans booked as one. Each is an EDB-1 Edit Bale job with the label photo.
- **PricePerYard (J).** 2,618 rows (42.5%) hold 0: almost the whole Jul26
  batch plus 41 Mar26 rows. **374 of them are SOLD rows** (Jul–Aug 2026:
  9037 ×120, 77008 ×99, 202/201 ×50, 77016 ×40, 77014 ×35, 9059-C ×30;
  buyers CJE 150, OKESON 224) — exactly why an invoice printed ₦0/PAID.
  The sale executor copies this column unchanged; the booked rate lives
  in Transactions/LedgerTransactions. So J is an intake list price, not
  the sale rate, and reads as both.
- **NetMtrs (N) / NetWeight (O).** Zero on all 3,224 Jul26 rows. Where
  filled, NetMtrs is Yards × 0.9144 (pure derivation). NetWeight has no
  reader in the bot at all.

### 2e · Internal columns

- **bale_uid (R)** is named "bale" but is **per than**: 3,300 distinct ids
  on 3,300 filled rows, five per bale. 2,853 legacy (Mar26) rows are
  blank, so their runtime id is `BAL-LEGACY-<rowIndex>` — **row position.
  Sorting the sheet, or inserting a row, silently re-keys 2,853 thans**
  (transfer pinning, the Postgres mirror and cart keys all use the uid).
  `backfillLegacyBales()` exists but has never been run. One real
  collision: `BAL-20260713-864-bjwg` sits on 77014/864 thans #4 AND #5
  (both sold to ABBA, 30-Aug) — uid-scoped operations treat two thans as one.
- **addedAt (S)** duplicates `DateReceived` for every bot-born row (parser
  already falls back to K when blank).
- **grn_id (T)** has one value (`GRN-20260713-001`) on Jul26, blank on
  Mar26 — landed cost resolves only for the July container.
- **bin_location (U)** is 100% blank; only the Postgres mirror reads it.
- **ProductType (Q)** has one value (`fabric`); the parser defaults to it.
- **CSNo (C)** is the packing-list serial; it restarts per container
  (9045 · SA/1326 uses CS 1–10 for bales 6487–6496 in Mar26 AND 1143–1152
  in Jul26); no reader.
- **arrival_batch (V)** is fully stamped, two labels — the F3 trap (cells
  are real dates displayed through `mmmd`) still applies: never reformat V.
- **design_category (W)** is stamped on 44200 and 44282 only (985 rows);
  33 designs are uncategorised, and a per-design fact is repeated per than.

### 2f · What else you are missing

1. **Do not sort or insert rows in Inventory** until the legacy uid
   backfill (§4, 2c) has run — see 2e.
2. **Hand edits re-enter junk silently.** The sentinel checks that names
   resolve (C5) and that live numbers are unique (C6), but not that a
   `SoldDate` parses, that a shade spelling is unique per design, or that
   a `bale_uid` is unique. The `cashmere 2026-07-27` cell proves it.
3. Customer analysis rests on spelling forever unless the cell is
   canonicalised — Transactions carries `customer_id`; Inventory does not,
   by your "no unnecessary columns" ruling (OPEN_ITEMS 12h). Your call
   whether that ruling stands for a `customer_id` on sold rows.
4. The 374 sold rows at ₦0 are a data fact on THIS sheet even though the
   money side is deferred by ruling — statements built from J will be wrong
   for those.
5. The 64 oversize thans are a physical audit list, not just data.

---

## 3 · Redundant / eliminable attributes

| Column | Evidence | Verdict |
|---|---|---|
| U `bin_location` | 100% blank; only the PG mirror reads it | **retire now** (stop mirroring; column stays blank) |
| Q `ProductType` | one value; parser defaults to it | **retire now** |
| N `NetMtrs` | = Yards × 0.9144; 52% zero | **retire**; derive at read time (rule 5b) |
| O `NetWeight` | 52% zero; zero readers | **retire**, or move to GoodsReceipts if packing weight matters |
| S `addedAt` | = DateReceived on bot-born rows; three shapes | retire **after** the uid backfill (a minted uid carries its date) |
| C `CSNo` | packing serial, restarts per container, no reader | keep only if you check packing lists against it; else retire |
| J `PricePerYard` | 42% zero incl. 374 sold; not the booked rate | keep until the finance pass rules (R7); never use for money meanwhile |
| T `grn_id` | one value; landed cost needs it | keep |
| W `design_category` | per-design fact on per-than rows | keep for now (your choice); normalise to a Designs master when the storage split reaches it |
| R `bale_uid` | per-than id, 46% blank | keep; backfill (§4, 2c); rename only in docs, never the column |
| K `DateReceived` | import day on Mar26 | keep; document the meaning (R11) |
| P `UpdatedAt` | booking time | keep |

**Deleting a column is a schema change, not a tidy-up.** Every writer
addresses cells by letter (`H:P` on sale, `R:S` on backfill, `V`, EDB-1's
B/D/E/G/P); deleting U shifts V and W and breaks all of them, plus the
Postgres mirror and every test fixture. Cheapest safe path, as with
SHT-1: retire in code (stop reading and writing, leave the column blank),
then delete in ONE coordinated pass later with the letter map updated in
the same commit.

---

## 4 · Correction plan (in order)

Each step is its own commit. Every one-off is dry-run by default, writes
only the cells it names, and re-reads each cell before writing it (the
CUS-ID1 guard pattern) — a cell that no longer matches the audit is
skipped and reported, never guessed.

**Phase 0 — owner, no code, today**
- 0a. `node scripts/format-date-columns.js --commit` (K and M display).
- 0b. No sorting or row inserts in Inventory until 2c is done.
- 0c. Rule R1–R11 (§5).

**Phase 1 — agent, read-only, can start now**
- 1a. `scripts/audit-inventory-sheet.js` — this census against the LIVE
  sheet, reading cells UNFORMATTED so text-vs-date is known for certain,
  emitting the row lists each one-off consumes (and re-runnable after each
  to confirm zero remaining).
- 1b. Sentinel checks **C9** (sold row whose `SoldDate` does not
  normalise), **C10** (duplicate `bale_uid`), **C11** (two spellings of
  one shade inside a design, e.g. `4-5` vs `4-5.`). Read-only, daily,
  admin DM — the hand-edit alarm that does not exist today.

**Phase 2 — agent, guarded one-offs (dry-run → `--commit`)**
- 2a. `repair-inventory-sold-dates.js` — the 105 word-prefixed M cells →
  ISO (the normaliser must agree on the day both sides); also any M cell
  stored as TEXT but parseable, rewritten so Sheets stores a real date.
- 2b. `canonicalise-sold-to.js` — for each cluster ruled in R1–R3: run
  Merge Customers in-bot (aliases keep history resolvable), then rewrite
  column L to the canonical spelling; guard: the cell must equal one of
  the ruled variants exactly.
- 2c. Legacy uid backfill — change `backfillLegacyBales` to mint real ids
  (`BAL-<yyyymmdd>-<pkg>-<rand4>`) instead of the position-bearing
  `BAL-LEGACY-<row>-<pkg>`, run it once (2,853 rows), and re-mint the
  duplicate on 864 #5. After this, sorting is safe. Code change +
  smoke S10.6 pin update.
- 2d. Shade spellings per R4; the three blank `9043-A` shades from you.
- 2e. Bale 6497 (`SAMPLE`) per R5 — only AFTER 2c if it is a row delete.
- 2f. The 64 oversize thans through EDB-1 Edit Bale, each with its label
  photo (dual-admin, already shipped) — no script, this is the door.

**Phase 3 — code so it stays clean**
- 3a. Retire U and Q (§3) — stop reading/writing, mirror skips them.
- 3b. BUSINESS_RULES: a short "hand edits to Inventory" rule (dates ISO,
  buyer spelled as in Customers, no sorting, shade spelling matches the
  design's existing chips) — needs your go, it is a rule.
- 3c. Design category: seed the 33 uncategorised designs through the
  DCAT-1 door (dual-admin) or a one-off list from you.

---

## 5 · Rulings needed (recommended answer in brackets)

- **R1** `Awunawu` / `Awurawu` / `awunawu` — one person? [yes → `Awunawu`]
- **R2** `madam oshodi` / `oshodi madam` / `Oshodi alaja` / `Alhaja oshodi`
  — one person? Which spelling is canonical? [yes → `Alhaja Oshodi`]
- **R3** `Ketu madam` vs `ketu police Man` — two people? [two]
- **R4** `2-6.` `4-5.` `7-3.` on 75142 — what do they mean (two-tone? a
  range?) and the spelling to keep? [strip the dot: `2-6`, `4-5`, `7-3`;
  77018's `4-5` already matches]
- **R5** Bale 6497 `SAMPLE / SHIPMENT`, 11 yd — real stock or a placeholder?
  [remove after 2c; record it in Samples if it matters]
- **R6** `9037-D/-E`, `9059-C`, `9060-A/-B` with blank shade — is the
  suffix the shade? [keep the codes (catalogue and movement ledger key on
  them); leave Shade blank only if each truly has one colour]
- **R7** 374 sold rows and 2,244 available rows at ₦0 in J — [deferred to
  the finance pass by your ruling; the sentinel just lists them]
- **R8** Run the legacy uid backfill (2c)? [yes — it is the sorting fix]
- **R9** Retire list (§3) — [U and Q now; N, O, S after 2c; C your call]
- **R10** Warehouse label `Lagos` — rename to the store's name? [leave;
  LOC-1 carries the city; renaming is a dual-admin `rename_warehouse`]
- **R11** Mar26 `DateReceived` = import day — leave, or set to the offload
  date? [leave; treat `arrival_batch` as the arrival marker]

---

## 6 · Method note

Parsed with `pdftotext -layout`, header positions per page, one token per
cell, 6,153 rows recovered with zero unparseable yardage. Counts are exact
for the PDF; text-vs-date cell TYPE cannot be seen in a PDF, which is why
Phase 1a reads the live sheet unformatted before any one-off writes.
