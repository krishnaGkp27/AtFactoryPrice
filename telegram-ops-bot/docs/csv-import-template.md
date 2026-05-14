# Bulk Receive Goods — CSV / XLSX Format

This is the operator reference for `📤 Bulk Receive (CSV/XLSX)` in the
Stock hub. Print it or pin it inside Excel/Sheets for the team.

The bot also returns the same template inline if you message it
`/bulkformat`.

---

## File format

A single file = a single delivery to a single warehouse from a single
supplier. If you have goods for two warehouses, save two files.

| Column     | Required | Notes                                                                  |
|------------|:--------:|------------------------------------------------------------------------|
| PackageNo  | ✅       | The number printed on the bale. May repeat — the bot stamps a unique internal `bale_uid` per row. Max 32 chars. |
| Design     | ✅       | E.g. `Beige Crepe`, `Mint`, `Red Silk`. Max 80 chars.                  |
| Yards      | ✅       | Numeric, > 0. One value per bale.                                      |
| Warehouse  | ✅       | Must already exist (`Kano`, `Lagos`, …). Use ⚙️ Admin → Manage Warehouses to add one (dual-admin sign-off). |
| Shade      | optional | E.g. `B-12`, `R-04`. Max 80 chars.                                     |
| Supplier   | optional | Name as it appears in Contacts (auto-created if new). Max 80 chars.    |
| Notes      | optional | Free-text, max 200 chars. Quote with `"..."` if it contains commas.    |
| Color      | optional | Reserved for future visual filters.                                    |

Header names are case-insensitive — `PackageNo`, `packageno`, or
`Package No` all work. Extra columns are rejected (so a stray
`DateReceived` will fail rather than silently drop data).

## Example

```csv
PackageNo,Design,Shade,Yards,Warehouse,Supplier,Notes
9001,Beige Crepe,B-12,50,Kano,SupplierA,
9002,Beige Crepe,B-12,48,Kano,SupplierA,
9003,Red Silk,R-04,52,Kano,SupplierB,VIP hold
```

## Limits

| Limit                  | Value             |
|------------------------|-------------------|
| Max rows per file      | 500               |
| Max file size          | 5 MB              |
| Allowed extensions     | `.csv`, `.xlsx`   |
| Warehouses per file    | 1                 |
| Suppliers per file     | 1                 |

If you have more than 500 bales in one delivery, split into multiple
files. The same approval flow runs per file.

## What happens after upload

1. Bot parses your file and shows a preview card with totals.
2. You tap **✅ Submit for approval**.
3. The request goes to the **admin queue** for dual-admin sign-off.
   - You as the requester are excluded from the approver pool — even if
     you're an admin yourself.
4. On approval, the bot:
   - Writes one **GoodsReceipts** row (`GRN-…`) with `source = bulk_csv`
     or `bulk_xlsx` and the file's hash.
   - Appends **N new Inventory rows** with fresh `bale_uid` + `addedAt`
     per row — existing rows are *never* touched.
   - Logs N **Stock_Ledger** "received" entries.
   - If you pinned a Procurement Order at the start, the PO's lines
     update and its status advances automatically.
5. You and the approver see a "📥 Goods received" confirmation in the
   admin feed.

## Common errors and fixes

| Error message                                | Fix                                       |
|---------------------------------------------|--------------------------------------------|
| `Missing required header "yards"`            | Add the column. Headers are case-insensitive. |
| `Yards must be a positive number (got "fifty")` | Use `50`, not the word.                  |
| `Warehouse "Lagos" is not registered`        | Register it via Admin → Manage Warehouses (dual-admin) before re-uploading. |
| `File mixes 2 warehouses: Kano, Lagos`       | Split into one file per warehouse.         |
| `Already imported as GRN-20260514-001`       | This exact file was already uploaded — there's nothing to do. |

## Idempotency

The bot computes a short hash (SHA-256, first 16 hex chars) of the file
bytes and stores it on the GRN. Re-uploading the same file is detected
and rejected — so if you're not sure whether your last upload went
through, just upload it again. Either it's new (it'll process) or it's
already in the system (you'll see the existing GRN ID).
