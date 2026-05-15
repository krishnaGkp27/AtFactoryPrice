# TEST 2 — Bulk CSV/XLSX Receive · Step-by-Step Walkthrough

**Audience:** Abdul, reading on his phone.
**Companion to:** `docs/abdul-test-playbook.md`
**Estimated time:** 5–10 minutes for the upload, 1–2 minutes for John to approve.

This document is the **complete, click-by-click walkthrough** of the Bulk CSV upload flow, including:

- The exact CSV file you'll upload (with sample data you can copy)
- What every screen looks like as you tap through
- What John sees on his approval card
- **Exactly which rows appear in the Inventory sheet** after approval — column by column
- What the `GoodsReceipts` row looks like
- What lands in Google Drive

---

## Part A — Prepare the test CSV (1 minute)

The bot accepts CSV or XLSX. **CSV is simpler — start with CSV.**

### Option 1 — use the ready-made sample

The repo already has a working sample at
`telegram-ops-bot/docs/samples/bulk-receive-sample-multi-bale.csv`.
John can WhatsApp it to you, or you can download it from the GitHub repo.

### Option 2 — type your own (recommended for the test)

Open any notes / text app on your phone. Copy this exactly, then save as **`test-receive-abdul-1.csv`**:

```csv
PackageNo,ThanNo,Design,Shade,Yards,NetMtrs,NetWeight,Warehouse,Supplier,Notes
9001,1,Beige Crepe,B-12,50,45.7,18.5,Kano,SupplierA,
9001,2,Beige Crepe,B-12,48,43.8,17.9,Kano,SupplierA,
9001,3,Beige Crepe,B-12,52,47.5,19.2,Kano,SupplierA,
9002,1,Red Silk,R-04,46,42.0,17.0,Kano,SupplierA,VIP hold
9002,2,Red Silk,R-04,48,43.8,17.9,Kano,SupplierA,
```

> **Why this file is good for testing:**
> - **2 bales** (9001 and 9002) with **5 thans total** — exercises the "multiple thans per bale" rule.
> - **One warehouse, one supplier** — the bot rejects mixed files, so this is the legal shape.
> - **A `Notes` value on one row** — confirms optional columns flow through.
> - **NetMtrs and NetWeight populated** — confirms the optional numeric columns work.

> **Replace `Kano` with the name of an existing warehouse** in your bot if you don't have a "Kano" warehouse registered. Same for `SupplierA` — use a real supplier name you've added, OR leave it as `SupplierA` and the bot will treat it as free-text.

> **Important:** the row count = **than** count, NOT bale count. The 5 rows above will create **2 bales / 5 thans / 244 yards** in inventory.

---

## Part B — Walk through the bot (5 minutes)

### B1. Open the bulk receive flow

| Tap | What you see |
|-----|--------------|
| Send `/menu` | Main menu with category buttons |
| Tap **📦 Inventory** (or your "Stock" hub) | Inventory category menu |
| Tap **📤 Bulk Receive (CSV/XLSX)** | Flow starts |

### B2. Skip the PO link

The bot asks:

```
Link this CSV upload to an open Procurement Order (optional):

[📋 PO-… · SupplierA]   ← only shows if there are open POs
[📋 PO-… · SupplierB]
…
[⏭ Skip (no PO)]
[❌ Cancel]
```

**Tap `⏭ Skip (no PO)`** for the test. (Linking to a PO is tested later — it's the same flow but the bot also updates the PO's "received bales" counter on approval.)

### B3. Bot asks for the file

```
Send the CSV or XLSX file as a document.

Accepted columns:
  Required: PackageNo, ThanNo, Design, Yards, Warehouse
  Optional: Shade, Supplier, NetMtrs, NetWeight, Notes

One row = one than. One bale can have multiple thans.
Max 500 rows / 5 MB per upload.

Send /bulkformat for a sample CSV template.

[⬅ Back to PO]
[❌ Cancel]
```

**Send the file** — in Telegram, tap the 📎 attachment icon → File → pick `test-receive-abdul-1.csv`.

> **Don't send it as a photo** — Telegram will compress it. Send as a **Document/File**.

### B4. Bot validates and shows the preview

If the file is valid, you'll see:

```
Review and submit

Warehouse: Kano
Supplier:  SupplierA
Designs:   2 (Beige Crepe, Red Silk)
Bales:     2
Thans:     5
Yards:     244
Net m:     220.50
Net kg:    91.10
Hash:      `a3f4b9c2d1e6f078`

5 thans across 2 bales will be appended to Inventory with fresh bale_uid + addedAt per row.

[✅ Submit for approval]
[🔄 Re-upload different file]
[❌ Cancel]
```

**Verify:**
- "Bales: 2" matches your CSV (2 distinct PackageNos: 9001, 9002).
- "Thans: 5" matches (5 rows).
- "Yards: 244" matches (50+48+52+46+48 = 244).

**Tap `✅ Submit for approval`.**

### B5. Confirmation message

```
✅ Submitted for approval

Request:  req-xxxxxxxx
Awaiting: 2nd admin approval (you cannot approve your own request)

📤 Bulk Receive — Kano · 2 bales / 5 thans · 244 yds · bulk_csv

[📋 My pending requests]
[🏠 Menu]
```

> **You're done from your side.** Wait for John to approve from his phone. Should take less than a minute if he's looking at his phone.

---

## Part C — What John sees & does (parallel)

John will get a notification on his phone:

```
🔔 Approval needed · bulk_receive_goods

From:        Abdul
Warehouse:   Kano
Supplier:    SupplierA
Bales:       2
Thans:       5
Yards:       244 (Net m 220.50, Net kg 91.10)
Source:      bulk_csv
File:        test-receive-abdul-1.csv (1.2 KB)
File hash:   a3f4b9c2d1e6f078

[✅ Approve]
[❌ Reject]
[📄 View full payload]
```

**He taps `✅ Approve`.** That triggers all the writes below.

You'll get a follow-up message:

```
✅ Approved by John

GRN-20260515-001 created in Kano:
  • 2 bales / 5 thans / 244 yds appended to Inventory
  • Source file backed up to Drive: <clickable link>
```

---

## Part D — What appears in the sheets (the part you really want to see)

### D1. `GoodsReceipts` sheet — ONE new row at the bottom

| Column | Value |
|---|---|
| `grn_id` | `GRN-20260515-001` |
| `warehouse` | `Kano` |
| `supplier` | `SupplierA` |
| `supplier_id` | (empty — free-text supplier) |
| `po_id` | (empty — we skipped PO link) |
| `received_by` | `<Abdul's Telegram ID>` |
| `received_at` | `2026-05-15T11:52:34.123Z` |
| `total_bales` | `2` |
| `total_yards` | `244` |
| `photo_file_id` | (empty — this is CSV, not photo) |
| `notes` | `bulk: test-receive-abdul-1.csv · 5 thans` |
| `status` | `received` |
| `source` | `bulk_csv` |
| `file_hash` | `a3f4b9c2d1e6f078` |
| **`source_url`** | **`https://drive.google.com/file/d/…/view`** ← clickable, opens the CSV |
| **`source_filename`** | **`2026-05-15__abdul__test-receive-abdul-1__a3f4b9c2.csv`** |

### D2. `Inventory` sheet — FIVE new rows at the bottom

Each row is one **than**. PackageNo 9001 repeats 3 times, PackageNo 9002 repeats 2 times — that's the design. **The unique identifier is `bale_uid` (column R), not PackageNo.**

| PackageNo | Indent | CSNo | Design | Shade | ThanNo | Yards | Status | Warehouse | PricePerYard | DateReceived | SoldTo | SoldDate | NetMtrs | NetWeight | UpdatedAt | ProductType | **bale_uid** | **addedAt** | **grn_id** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 9001 |  |  | Beige Crepe | B-12 | 1 | 50  | available | Kano | 0 | 2026-05-15 |  |  | 45.7 | 18.5 |  | fabric | `BAL-20260515-9001-a1b2` | `2026-05-15T11:52:34.124Z` | `GRN-20260515-001` |
| 9001 |  |  | Beige Crepe | B-12 | 2 | 48  | available | Kano | 0 | 2026-05-15 |  |  | 43.8 | 17.9 |  | fabric | `BAL-20260515-9001-c3d4` | `2026-05-15T11:52:34.131Z` | `GRN-20260515-001` |
| 9001 |  |  | Beige Crepe | B-12 | 3 | 52  | available | Kano | 0 | 2026-05-15 |  |  | 47.5 | 19.2 |  | fabric | `BAL-20260515-9001-e5f6` | `2026-05-15T11:52:34.138Z` | `GRN-20260515-001` |
| 9002 |  |  | Red Silk    | R-04 | 1 | 46  | available | Kano | 0 | 2026-05-15 |  |  | 42.0 | 17.0 |  | fabric | `BAL-20260515-9002-g7h8` | `2026-05-15T11:52:34.145Z` | `GRN-20260515-001` |
| 9002 |  |  | Red Silk    | R-04 | 2 | 48  | available | Kano | 0 | 2026-05-15 |  |  | 43.8 | 17.9 |  | fabric | `BAL-20260515-9002-i9j0` | `2026-05-15T11:52:34.152Z` | `GRN-20260515-001` |

**Things to notice:**

- **5 rows, not 2.** The sheet stores thans, not bales. PackageNo repeats — that's correct.
- **`bale_uid` is unique per row.** Format: `BAL-{YYYYMMDD}-{PackageNo}-{4-char-random}`. This is the FK used by sales, transfers, and PO reconciliation — NEVER use PackageNo as a key, because PackageNo will repeat next month when a new bale also numbered "9001" arrives.
- **`addedAt` is a precise ISO timestamp.** Different from `DateReceived` (which is the supplier's stated date). Two different things.
- **`grn_id` back-points to the GRN.** That's how you walk from a than → the GRN it arrived on.
- **`Status` is `available`.** Sales can immediately pick from these.
- **`PricePerYard` is 0.** The CSV doesn't carry pricing — set it later via the price-update flow.
- **The `Notes` field from the CSV doesn't appear in Inventory.** It's intentionally dropped at this layer — notes go into the GRN-level audit, not the per-than row.
- **Old inventory rows are NEVER touched.** Append-only. If you scroll up in the Inventory sheet, every existing row is byte-identical to before the test.

### D3. `Stock_Ledger` sheet (if you have it open) — FIVE new entries

One per than, all stamped `type='received'`, `qty_in=<yards>`, `reference_id='GRN-20260515-001'`. This is the audit trail.

### D4. Google Drive — ONE new file

Open your Drive folder (the one whose ID is in `SOURCE_GDRIVE_FOLDER_ID` or `OCR_GDRIVE_FOLDER_ID`). Navigate to `2026-05/`.

You should see:

```
📄 2026-05-15__abdul__test-receive-abdul-1__a3f4b9c2.csv
```

**Right-click → View details → Description:**

```
GRN-20260515-001 | SupplierA | Kano | 2026-05-15T11:52:34.123Z
```

This stamp is added **after John approves** — so if you check Drive before approval, the file is there but the description is blank. After approval, the description is populated.

---

## Part E — Idempotency test (1 minute)

**Re-upload the EXACT SAME CSV file** (Steps B1–B3 above).

After the preview screen, the bot should refuse before letting you submit:

```
⚠️ This file was already imported as `GRN-20260515-001` on 2026-05-15.
   Hash: a3f4b9c2d1e6f078

[🔄 Try another file]
[⬅ Back to PO]
[❌ Cancel]
```

**Verify in the Inventory sheet:**
- Still only 5 new rows (not 10). The duplicate was rejected before any write.
- Still only 1 new GoodsReceipts row.

This proves the file hash check works — Abdul can't accidentally double-count goods even if he taps Submit twice.

---

## Part F — Edge cases worth trying

Pick any 1–2 to verify the bot fails safely.

### F1. Mixed warehouses (should reject)

Edit the CSV — change row 4's Warehouse from `Kano` to `Lagos`. Upload.

Expected: bot rejects with `⚠️ File mixes 2 warehouses: Kano, Lagos. Split into one file per warehouse.` **with buttons visible.** No writes.

### F2. Missing required column (should reject)

Delete the `ThanNo` column entirely. Upload.

Expected: bot rejects with a validation error listing the missing column. No writes.

### F3. Same (PackageNo, ThanNo) repeated (should reject)

Duplicate row 1 (so `9001/1` appears twice). Upload.

Expected: bot rejects with `(PackageNo 9001, ThanNo 1) appears more than once`. No writes.

### F4. Inconsistent Design within a bale (should reject)

Change row 2's Design from `Beige Crepe` to `Beige Voile` (while keeping PackageNo = 9001). Upload.

Expected: bot rejects with `bale 9001 has inconsistent Design (Beige Crepe vs Beige Voile)`. No writes.

---

## Part G — Sign-off

After the happy-path test (Parts A–D) + the idempotency test (Part E) + at least one edge case (Part F):

✅ Both the **happy-path write** and the **safety nets** are confirmed working.
✅ The **clickable Drive link** in the GoodsReceipts row is the most user-visible new thing — verify it actually opens for John.
✅ Send John screenshots of:
   1. The bot's preview screen (Part B4)
   2. The bot's "submitted" screen (Part B5)
   3. The 5 new Inventory rows
   4. The 1 new GoodsReceipts row (with the source_url cell visible)
   5. The Drive folder showing the readable filename

That's everything. **~10 minutes of your time.**
