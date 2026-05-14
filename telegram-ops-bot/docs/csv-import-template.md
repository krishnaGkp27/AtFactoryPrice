# Bulk Receive Goods — CSV / XLSX Format

This is the operator reference for `📤 Bulk Receive (CSV/XLSX)` in the
Stock hub. Print it or pin it inside Excel/Sheets for the team.

The bot also returns the same template inline if you message it
`/bulkformat`.

---

## Domain model — read this first

- **1 bale** (`PackageNo`) = **1 or more thans** (rolls cut from it)
- **1 row in the CSV = 1 than** (it maps 1:1 to one Inventory row)
- All thans of the same bale share the same `Design`, `Shade`,
  `Warehouse`, `Supplier` — they came off the same physical bale in the
  same delivery
- A bale with 5 thans → **5 rows** in the file, all sharing `PackageNo`,
  each with its own `ThanNo` (1, 2, 3, 4, 5)

A single file = a single delivery to a single warehouse from a single
supplier. If you have goods for two warehouses, save two files.

## File format

| Column     | Required | Notes                                                                          |
|------------|:--------:|--------------------------------------------------------------------------------|
| PackageNo  | ✅       | The number printed on the bale. May repeat across the file (same bale, multiple thans) and across history (composite-key model — the bot stamps a unique internal `bale_uid` per row). Max 32 chars. |
| ThanNo     | ✅       | Positive integer 1–999. Identifies which than within the bale. Must be unique within a PackageNo (you can't have two ThanNo=1 for the same bale). |
| Design     | ✅       | E.g. `Beige Crepe`, `Mint`, `Red Silk`. Max 80 chars. **Must be identical for every than of the same bale.** |
| Yards      | ✅       | Numeric, > 0. One value per than.                                              |
| Warehouse  | ✅       | Must already exist (`Kano`, `Lagos`, …). Use ⚙️ Admin → Manage Warehouses to add one (dual-admin sign-off). |
| Shade      | optional | E.g. `B-12`, `R-04`. Max 80 chars. **Must be identical across thans of one bale.** |
| Supplier   | optional | Name as it appears in Contacts (auto-created if new). Max 80 chars.            |
| NetMtrs    | optional | Net metres (metric length of the than). Numeric, ≥ 0. From the packaging slip. |
| NetWeight  | optional | Net weight in kg. Numeric, ≥ 0. From the packaging slip.                       |
| Notes      | optional | Free-text, max 200 chars. Quote with `"..."` if it contains commas.            |
| Color      | optional | Reserved for future visual filters.                                            |

Header names are case-insensitive — `PackageNo`, `packageno`, or
`Package No` all work. Extra columns are rejected (so a stray
`DateReceived` will fail rather than silently drop data).

## Sample — single bale, 5 thans

Recommended for the very first test. The file ships in
`docs/samples/bulk-receive-sample-single-bale.csv`.

```csv
PackageNo,ThanNo,Design,Shade,Yards,NetMtrs,NetWeight,Warehouse,Supplier,Notes
9001,1,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,
9001,2,Beige Crepe,B-12,48,43.8,17.9,Kano,SupplierA,
9001,3,Beige Crepe,B-12,52,47.5,19.2,Kano,SupplierA,
9001,4,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,
9001,5,Beige Crepe,B-12,49,44.8,18.2,Kano,SupplierA,
```

Preview card you'll see: *1 bale · 5 thans · 249 yards · 227.5 net m · 92.3 net kg*

## Sample — multi-bale, mixed designs

The file ships in `docs/samples/bulk-receive-sample-multi-bale.csv`.

```csv
PackageNo,ThanNo,Design,Shade,Yards,NetMtrs,NetWeight,Warehouse,Supplier,Notes
9001,1,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,
9001,2,Beige Crepe,B-12,48,43.8,17.9,Kano,SupplierA,
...
9002,1,Red Silk,R-04,46,42.0,17.0,Kano,SupplierA,VIP hold
9002,2,Red Silk,R-04,48,43.8,17.9,Kano,SupplierA,
...
9003,1,Mint Voile,M-03,52,47.5,15.5,Kano,SupplierA,
9003,2,Mint Voile,M-03,50,45.7,15.0,Kano,SupplierA,
```

Preview card: *3 bales · 10 thans · 495 yards*

## Limits

| Limit                  | Value             |
|------------------------|-------------------|
| Max rows (thans) per file | 500            |
| Max file size          | 5 MB              |
| Allowed extensions     | `.csv`, `.xlsx`   |
| Warehouses per file    | 1                 |
| Suppliers per file     | 1                 |
| ThanNo range           | 1–999 (per bale)  |

If you have more than 500 thans in one delivery, split into multiple
files. The same approval flow runs per file.

## What happens after upload

1. Bot parses your file, runs all validations, and shows a preview card
   with **bales / thans / yards / file hash**.
2. You tap **✅ Submit for approval**.
3. The request goes to the **admin queue** for dual-admin sign-off.
   - You as the requester are excluded from the approver pool — even if
     you're an admin yourself.
4. On approval, the bot:
   - Writes one **GoodsReceipts** row (`GRN-…`) with `source = bulk_csv`
     or `bulk_xlsx`, the file's hash, and `total_bales = distinct
     PackageNos`.
   - Appends **N new Inventory rows** (one per than) with fresh
     `bale_uid` + `addedAt` per row — existing rows are *never* touched.
   - Each new row carries its own `ThanNo`, `Yards`, `NetMtrs`,
     `NetWeight`.
   - Logs N **Stock_Ledger** "received" entries.
   - If you pinned a Procurement Order at the start, the PO's lines
     update (counts of *distinct bales*, summed *yards*) and its status
     advances automatically.
5. You and the approver see a "📥 Goods received" confirmation in the
   admin feed.

## Common errors and fixes

| Error message                                                    | Fix                                                                  |
|------------------------------------------------------------------|----------------------------------------------------------------------|
| `Missing required header "thanno"`                               | Add the `ThanNo` column.                                             |
| `ThanNo must be a positive integer 1–999 (got "")`               | Number every row, starting at 1 for the first than of each bale.     |
| `Duplicate (PackageNo=9001, ThanNo=1) — already at row 2.`       | A bale can't have two thans with the same number. Renumber.          |
| `Bale 9001 has inconsistent design: "Beige" vs "Mint".`          | A bale = one design. Split into two PackageNos if they're separate.  |
| `Yards must be a positive number (got "fifty")`                  | Use `50`, not the word.                                              |
| `Warehouse "Lagos" is not registered`                            | Register via Admin → Manage Warehouses (dual-admin) before re-upload.|
| `File mixes 2 warehouses: Kano, Lagos`                           | Split into one file per warehouse.                                   |
| `Already imported as GRN-20260514-001`                           | This exact file was already uploaded — nothing to do.                |

## Idempotency

The bot computes a short hash (SHA-256, first 16 hex chars) of the file
bytes and stores it on the GRN. Re-uploading the same file is detected
and rejected — so if you're not sure whether your last upload went
through, just upload it again. Either it's new (it'll process) or it's
already in the system (you'll see the existing GRN ID).

## Fallback paths

If for any reason bulk upload doesn't work for a particular delivery:

| Situation                                  | Fallback                                                                                  |
|--------------------------------------------|-------------------------------------------------------------------------------------------|
| Validation keeps rejecting (e.g. a stubborn cell)              | Use the interactive **📥 Receive Goods** flow one bale at a time (P2 — works for any volume but is slower) |
| You uploaded the wrong file and admin approved it              | Today: void manually in the Google Sheet — set `Status = void` on the new Inventory rows and `status = cancelled` on the GRN row. A future commit will add a `🗑 Void GRN` admin action.    |
| You want to test the format without committing                  | Submit, then *don't* approve — the request sits pending in `ApprovalQueue` and no rows land in Inventory. Cancel/reject from the admin's chat card. |
| Network blocks .xlsx                                           | Save as `.csv` from Excel/Sheets — identical schema.                                       |
| Excel "smart quotes" mangle the CSV                            | In Excel: File → Save As → CSV UTF-8 (Comma delimited) (*.csv). Don't use "CSV Macintosh." |
| You need to add 100s of rows fast and don't have packaging slips digitized yet | Use the [P5 OCR add-on](../ROADMAP.md#25c-inbound-supply-loop--p1-p4-2026-05-14) when it ships — designed exactly for the photo-of-slip → CSV auto-fill path. |

The two paths (interactive GRN flow and bulk CSV) write to the exact
same `GoodsReceipts`, `Inventory`, and `Stock_Ledger` tables — they
differ only in how the data is captured. There's no lock-in on either
side.
