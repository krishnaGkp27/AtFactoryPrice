# Abdul's Test Playbook — Receive Goods Workflows

**Audience:** Abdul (inventory manager), reading on his phone.
**Purpose:** Verify that the two new "receive goods" flows work end-to-end before they go live for daily use.
**You'll need:** your phone (Telegram), a packing slip (paper photo or PDF), and one CSV file the admin will share.
**Estimated time:** 15–20 minutes total.

> **Important:** You are an admin **for the test only.** When you submit, you'll see "Submitted for approval" — that's normal. The admin (John) will approve from his phone within a minute or two. **You cannot approve your own request** — that's the safety rule.

---

## TEST 1 — Photo Receive (the new OCR feature)

Abdul photos a packing slip → bot extracts the bales → Abdul accepts/edits each row → submits → admin approves → bales appear in inventory.

### Steps

1. Open the bot, send `/menu`.
2. Tap **📦 Inventory** (or the equivalent stock hub).
3. Tap **📷 Photo Receive (image/PDF)**.
4. The bot asks: link to a Procurement Order? Tap **⏭ Skip (no PO)** for the first test.
5. The bot asks for a file. Either:
   - Take a photo directly with your phone of a real packing slip, OR
   - Upload a PDF of a packing slip you have saved.
6. Wait 5–15 seconds for OCR (the bot will say "🔍 Reading your slip…").
7. The bot shows a **review card** — one row per "than" (bale subdivision) the OCR found. Each row has 3 buttons:
   - ✅ **Accept** — looks correct
   - ✏ **Edit** — fix one or more fields
   - ❌ **Skip** — this row is wrong/duplicate, ignore it
8. **Low-confidence rows are marked 🔴** — you MUST tap ✏ Edit on them before submitting. The Accept button is hidden until you do.
9. Tap through each row. For at least one row, deliberately tap ✏ Edit to test:
   - Bot asks which field to edit (PackageNo / ThanNo / Design / Shade / Yards / NetMtrs / NetWeight).
   - Tap the field, type the corrected value as a plain message, send.
   - Bot confirms the edit, returns to the review card.
10. Once every row is decided (✅ or ❌), tap **✅ Submit for approval**.
11. You'll see: *"Submitted for approval — request `req-...` waiting for the 2nd admin."*

### What John verifies (parallel)

- He gets a notification: **"📷 Photo Receive — {warehouse} · N bales / M thans · {source} · …"**
- The approval card shows:
  - Warehouse, supplier, bales, thans, total yards
  - Source: `ocr_vision_stub` (or `_openai` when real OCR is on)
  - File hash (lets him spot duplicates)
  - Number of rows you edited
- John taps **Approve**. He should see "✅ Approved."

### After approval — verify in 3 places

1. **Telegram:** Abdul gets a "✅ Approved — N bales appended to {warehouse}" message.
2. **Google Sheet — `GoodsReceipts`:** the bottom row should have:
   - `grn_id` like `GRN-20260515-001`
   - `source` = `ocr_vision_stub`
   - `file_hash` = a 16-character hex string
   - **`source_url`** = a clickable Google Drive link → **tap it from the sheet, the photo should open**
   - **`source_filename`** = `2026-05-15__abdul__<original-name>__<hash8>.jpg` (or .pdf)
3. **Google Sheet — `Inventory`:** N new rows at the bottom, each with `grn_id` matching the GRN. Older rows untouched (append-only).
4. **Google Drive — the source folder:** open it, find the YYYY-MM subfolder.
   - File should be named exactly like `source_filename` above — readable, dated, with your name.
   - Right-click the file → **Details** → "Description" should read **`GRN-20260515-001 | <supplier> | <warehouse> | <timestamp>`** (stamped automatically after approval).

### Re-upload the same photo (idempotency test)

5. Start Photo Receive again, upload the **exact same photo**.
6. Bot should reject it with: *"⚠️ This photo was already imported as `GRN-…` on YYYY-MM-DD."*
7. Tap **Cancel** — flow ends cleanly. **No duplicate row in inventory.**

---

## TEST 2 — Bulk CSV Receive

Same approval flow, but Abdul uploads a CSV instead of a photo. Faster, more reliable than OCR, the right choice when the supplier emails you a spreadsheet.

### Steps

1. Open the bot, send `/menu`.
2. Tap **📦 Inventory** → **📤 Bulk Receive (CSV/XLSX)**.
3. Tap **⏭ Skip (no PO)** for this test.
4. The bot asks for a CSV. Send `/bulkformat` first if you want the template — bot returns a sample CSV showing the column headers. Required columns:
   - `PackageNo` — bale number (e.g. `9001`)
   - `ThanNo` — than number within the bale (1, 2, 3, …)
   - `Design` — design code
   - `Yards` — yards on the than
   - `Warehouse` — receiving warehouse name (must already exist in the bot)
   - Optional: `Shade`, `Supplier`, `NetMtrs`, `NetWeight`, `Notes`
5. Upload the CSV (or XLSX) as a Telegram **document** (not a photo).
6. Bot validates and shows a **preview**: warehouse, supplier, designs count, bales count, thans count, total yards, file hash.
7. Tap **✅ Submit for approval**.

### What John verifies

- He gets the approval card with the same data as the preview.
- He taps **Approve**.

### After approval — same 3 places to verify

1. `GoodsReceipts` row with `source = bulk_csv` (or `bulk_xlsx`), clickable `source_url`, readable `source_filename`.
2. `Inventory` has the new rows, old rows untouched.
3. Drive folder has the CSV with the readable filename + GRN-stamped description.

### Re-upload the same CSV (idempotency)

- Should be rejected with the same "already imported as GRN-…" message. **No duplicate row.**

---

## TEST 3 — UX / safety checks (5 minutes)

Pick any 3 of these and tap through. If any one of them leaves you with **no buttons to tap**, ping the admin — that's a UX regression.

| # | Test | Expected |
|---|------|----------|
| 1 | In Photo Receive, upload a `.txt` file (wrong type) | Bot shows "Unsupported file type" **with Try-Again / Back-to-PO / Cancel buttons visible** |
| 2 | In Bulk Receive, upload a `.docx` file | Bot shows "Only .csv and .xlsx accepted" **with the same 3 buttons visible** |
| 3 | In Bulk Receive, upload a CSV missing the `PackageNo` column | Bot shows the validation errors **with retry/back/cancel buttons** |
| 4 | Start any flow, tap **❌ Cancel** at any step | Returns you to the menu with "❌ Cancelled" — no half-finished state |
| 5 | Start any flow, tap **⬅ Back** at a step that has it | Returns you to the previous step with your earlier choices preserved |
| 6 | In Photo Receive review, try **🔄 Accept all non-low-conf rows** | All ✅ buttons (high-confidence rows) flip to accepted in one tap. Low-conf rows stay 🔴 |

---

## What to do if something fails

- **Bot doesn't respond:** ping John, the bot may need a restart.
- **OCR returns nothing on a clear photo:** that's expected for now (the OCR is on the "stub" provider for testing — it returns fixed sample data, not real OCR). The real OCR provider gets switched on later. For now the stub is fine for testing the *flow*, not the *recognition*.
- **Drive link in the sheet doesn't open:** check that `SOURCE_GDRIVE_FOLDER_ID` (or `OCR_GDRIVE_FOLDER_ID`) is set in the bot's `.env`. If neither is set, the sheet row's `source_url` will be empty by design (file is still archived locally on the bot's disk).
- **Got stranded with no buttons:** scroll up in the chat to find the original flow card, OR send `/menu` to reset.

---

## What this test proves (for John's records)

- ✅ Photo Receive (P5) works end-to-end with dual-admin approval.
- ✅ Bulk Receive (P2.5) works end-to-end.
- ✅ Both flows write a clickable Drive link to `GoodsReceipts.source_url`.
- ✅ Both flows use a human-readable filename in Drive.
- ✅ Idempotency works — the same file can't be imported twice.
- ✅ Append-only is preserved — old inventory rows never modified.
- ✅ The new UX standard (every error keeps buttons in view) holds.

---

## After the test

1. John reverts Abdul's admin status:
   - Remove Abdul's Telegram ID from `ADMIN_IDS`.
   - Add it back to `EMPLOYEE_IDS`.
   - Restart the bot.
2. If everything passed, the features are production-ready.
3. If something failed, John captures the failing screen + the bot logs for that timestamp and pings the dev.
