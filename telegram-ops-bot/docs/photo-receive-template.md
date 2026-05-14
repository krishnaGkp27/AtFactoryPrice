# Photo Receive Goods — operator guide

This is the Abdul-friendly walkthrough for `📷 Photo Receive (image/PDF)`
in the Stock hub. Pin it on the warehouse pinboard, send it to the
inventory team's WhatsApp, or just bookmark it.

Sister documents:
- [Bulk Receive (CSV/XLSX)](csv-import-template.md) — for when you have
  the data already typed out
- [ROADMAP §2.7](../ROADMAP.md#27-photo-receive--p5-in-flight-2026-05-14)
  — locked design decisions and what's still in flight

---

## When to use which path

| Scenario                                                    | Use                             |
|-------------------------------------------------------------|---------------------------------|
| You have the supplier's packaging slip in hand (paper or PDF) | **📷 Photo Receive** (this guide) |
| You've already typed bale data into Excel / Sheets          | [📤 Bulk Receive (CSV)](csv-import-template.md) |
| You're entering one or two bales right at the desk          | 📥 Receive Goods (interactive 6-step flow) |

The three paths write to the **exact same** Inventory tables with the
**exact same** dual-admin approval. They differ only in how the data
gets captured.

## The basic loop

```
1. Tap 📷 Photo Receive in the Stock menu.
2. Pick a Procurement Order to link (or tap "Skip — no PO").
3. Send a photo (camera roll or live capture) or a PDF of the
   packaging slip.
4. Bot replies "🔍 Reading your slip…" — give it 5–15 seconds.
5. Review card appears, one line per than the bot extracted.
6. For each row: tap ✅ Accept / ✏ Edit / ❌ Skip.
   - Red 🔴 rows (low-confidence OCR) MUST be edited or skipped — the
     ✅ button is hidden until you've reviewed them.
7. When every row has a decision, tap ▶ Submit for approval.
8. The 2nd admin gets the approval card. Once they approve, the rows
   land in Inventory.
```

## File requirements

| Limit               | Value             | Notes                                              |
|---------------------|-------------------|----------------------------------------------------|
| Accepted formats    | JPG, PNG, WebP, HEIC, PDF | iPhone HEIC works directly. PDFs can be multi-page (real Vision wiring) or single-page (current stub). |
| Max file size       | 5 MB              | Phone photos: usually 1-3 MB. PDFs: scan at "medium" or "compressed." |
| Max rows extracted  | 10 per upload (v1) | If a slip has more thans, split it. The cap relaxes when real OCR is wired. |

## What you see on the review card

```
📷 Photo Receive Goods
✓ PO: PO-1234
✓ File: slip-9001.jpg 245 KB
✓ OCR: stub (overall 86%)
✓ Drive: https://drive.google.com/file/d/.../view

Review extracted rows

⚠️ Row 3 has smudged yards / netMtrs — confidence 0.55 (review required).

⏳ 1. 9001-T1  Beige Crepe B-12  50.0 yds  (95%)
⏳ 2. 9001-T2  Beige Crepe B-12  48.0 yds  (93%)
🔴 3. 9001-T3  Beige Crepe B-12  52.0 yds  (55%)
⏳ 4. 9001-T4  Beige Crepe B-12  50.0 yds  (91%)
⏳ 5. 9001-T5  Beige Crepe B-12  49.0 yds  (94%)

Decided: 0/5  ·  Pending: 5  ·  Low-conf open: 1

[ ✅ 1 ] [ ✏ 1 ] [ ❌ 1 ]
[ ✅ 2 ] [ ✏ 2 ] [ ❌ 2 ]
[ ✏ 3 — required ] [ ❌ 3 ]   <-- ✅ hidden for low-conf
[ ✅ 4 ] [ ✏ 4 ] [ ❌ 4 ]
[ ✅ 5 ] [ ✏ 5 ] [ ❌ 5 ]
[ ✅ Accept all OK rows ] [ 🔄 Re-upload ]
[ ▶ Submit (decide 5 more) ]
[ ❌ Cancel ]
```

**Status icons**

| Icon | Meaning                                                              |
|------|----------------------------------------------------------------------|
| ⏳   | Pending — admin hasn't decided yet                                   |
| ✅   | Accepted as-is                                                       |
| ✏️   | Edited (one or more fields changed by admin)                         |
| ❌   | Skipped — won't be submitted                                         |
| 🔴   | Low-confidence OCR result — requires explicit edit before acceptance |

## Editing a row

Tap `✏ N` on the review card. The edit panel appears:

```
✏ Editing row 3 — OCR confidence 55% 🔴

PackageNo:  9001
ThanNo:     3
Design:     Beige Crepe
Shade:      B-12
Yards:      52
NetMtrs:    47.5
NetWeight:  19.2

Edited so far: (none)

[ ✏ PackageNo ] [ ✏ ThanNo ]
[ ✏ Design ]    [ ✏ Shade ]
[ ✏ Yards ]     [ ✏ NetMtrs ]
[ ✏ NetWeight ]
[ ✅ Save row 3 ] [ ❌ Skip row 3 ]
[ ↩ Discard edits + back ]
```

Tap any `✏ <field>` button → bot prompts:

```
Set new value for *Yards* (row 3)
Current: `52`
_Numeric > 0._
Send /cancel to abort.
```

Send the corrected value (e.g. `50.5`), bot acknowledges and re-renders
the edit panel with the new value. Edited fields appear in the
"Edited so far" line for audit visibility.

When you're done editing, tap `✅ Save row N`. The row's state flips to
`✏️ Edited` on the review card, and the row counts as decided.

**Discard edits + back** uses the snapshot taken when you entered edit
mode — the row goes back to its pre-edit state and stays `Pending`.

**Editing a low-confidence row automatically clears the 🔴 flag.** By
touching the cell, you've explicitly vetted it.

### Edit shortcuts

| Input | Effect                                                                |
|-------|-----------------------------------------------------------------------|
| `-`   | Clears the field (only for optional fields: Shade, NetMtrs, NetWeight). Required fields refuse to clear. |
| `/cancel` | Abandons the *current field edit* and returns to the edit panel. Different from "Discard edits + back," which abandons the *whole edit session*. |

### Field validation rules

| Field      | Rule                                                            |
|------------|-----------------------------------------------------------------|
| PackageNo  | Required, max 32 characters                                     |
| ThanNo     | Positive integer 1–999 (decimals are truncated, e.g. `5.7` → `5`) |
| Design     | Required, max 80 characters                                     |
| Shade      | Optional, max 80 characters. Send `-` to clear.                 |
| Yards      | Required, positive number (e.g. `50`, `52.5`)                   |
| NetMtrs    | Optional, ≥ 0. Send `-` to clear.                               |
| NetWeight  | Optional, ≥ 0. Send `-` to clear.                               |

## Mass actions

| Button              | Effect                                                                 |
|---------------------|------------------------------------------------------------------------|
| `✅ Accept all OK rows` | Flips every **pending non-low-conf** row to Accepted. Already-decided rows untouched, 🔴 rows untouched. Useful when OCR nailed it. |
| `🔄 Re-upload`      | Discard the current extraction, prompt for a new image / PDF.          |
| `↩ Undo N`          | (Replaces per-row buttons after a decision.) Reverts row N to Pending. |

## After submit

```
⏳ Submitted for 2nd admin approval.
Request: `req-…`
Hash: `5966762ef68d3b…`

[ 📷 Upload another ] [ 🏠 Menu ]
```

The 2nd admin gets a card like:

```
📷 Photo Receive — Kano · 1 bales / 5 thans · 249 yds · ocr_vision_stub
  · PO PO-1234 · 1 edited

Requester: ABDUL-001
Reason: dual_admin_required

[ ✅ Approve ] [ ❌ Reject ] [ 💬 Ask for changes ]
```

On approval:
- 1 row in `GoodsReceipts` (with `source = ocr_vision_<provider>`,
  `file_hash` = image hash, `notes = "bulk: <filename> · 5 thans"`)
- N rows in `Inventory` (one per than, fresh `bale_uid` + `addedAt`)
- N rows in `Stock_Ledger` (one "received" entry per than)
- If a PO was linked: the PO's lines advance (counts of *distinct
  bales*, summed *yards*), status auto-recomputed.

You and the approver both see `📥 Goods received` in the admin feed.

## Idempotency

The bot SHA-256-hashes the image bytes. If you re-upload the same file
(same camera shot, same PDF), it's detected and rejected with:

```
⚠️ This photo was already imported as `GRN-20260514-001` on 2026-05-14.
Hash: `5966762ef68d3b…`
```

So if you're not sure whether your last upload made it through, just
upload it again. Either it processes (new) or you see the GRN ID (old).

The hash is also stored on the GRN, so admins can audit which images
produced which Inventory rows months later.

## Where do the images go?

- **Local copy** → `data/ocr/{hash}.{ext}` on the bot host.
- **Google Drive** → if `OCR_GDRIVE_FOLDER_ID` is configured in
  `.env`, a copy is auto-uploaded to a `{YYYY-MM}/` subfolder under
  the parent folder you specified. The Drive link appears in the
  flow header.
- **Audit log** → an `approval_queued` entry references the hash,
  source tag, and edit count.

If Drive upload fails for any reason (quota, network, permission), the
local copy still goes through and the flow continues normally. You
won't lose the slip.

## Common errors and fixes

| What you see                                                    | What to do                                                       |
|-----------------------------------------------------------------|------------------------------------------------------------------|
| `⚠️ Unsupported file type "application/zip"`                    | Send a JPG / PNG / WebP / HEIC photo or a PDF — not a zipped folder. |
| `⚠️ OCR did not find any bale rows on this slip.`               | Take a sharper photo with better lighting, or fall back to 📤 Bulk Receive (CSV). |
| `🔴 Row 3 — required` (no ✅ button)                            | Tap `✏ 3` and verify / fix the values before accepting.          |
| `⚠️ File mixes 2 warehouses`                                    | The OCR thinks bales are going to different warehouses. Edit each row's warehouse to match, or re-photo one warehouse at a time. |
| `⚠️ Bale 9001 has inconsistent design`                          | A bale is one design — OCR misread one row. Edit the rogue row. |
| `▶ Submit (decide 3 more)` button greyed                        | Three rows still pending. Decide ✅ / ✏ / ❌ on each.            |
| `⚠️ This photo was already imported as GRN-…`                   | Idempotency check — same image went through earlier. Nothing to do. |
| Bot replies with stub data even after I send a real photo       | OCR is currently running the **stub provider** for development. Set `OCR_PROVIDER=openai` and `OPENAI_API_KEY=...` in `.env` to switch to real Vision. (Pending in a future commit.) |

## Fallback paths

The same fallbacks from [csv-import-template.md](csv-import-template.md)
apply. Specifically:

- **Photo path failing for a particular slip** → fall back to 📤 Bulk
  Receive (CSV/XLSX) — same approval gate, same Inventory writes.
- **Both bulk paths failing** → use the interactive 📥 Receive Goods
  flow (P2). Always works for any volume, just slower.
- **Wrong GRN got approved** → void manually in Google Sheets today.
  Set `Status = void` on the new Inventory rows and `status = cancelled`
  on the GRN row. A `🗑 Void GRN` admin action is on the roadmap.

## Operator checklist for the first test with Abdul

1. **Promote Abdul to admin temporarily** so we can do dual-admin testing
   on one device: add his Telegram ID to `ADMIN_IDS` in `.env`, restart
   the bot.
2. Send Abdul a known-good slip photo (or use one of the canonical
   sample CSVs as a control).
3. Have Abdul tap `📷 Photo Receive` from the Stock hub.
4. He picks PO or skips, sends the photo.
5. The bot will return the **canonical stub fixture** (5 thans of bale
   `9001`, with row 3 marked 🔴) regardless of the photo content, until
   real OCR is wired.
6. Walk Abdul through the review buttons. Have him:
   - Tap `✅ Accept all OK` — confirms 4 of 5 rows.
   - Tap `✏ 3` → tap `✏ Yards` → send `50` → tap `✅ Save row 3`.
   - Tap `▶ Submit for approval`.
7. The admin (you) get the approval card. Approve it. Watch the
   confirmation arrive in both chats.
8. Open the Google Sheet → confirm 5 new rows in `Inventory` at the
   tail, 1 new row in `GoodsReceipts` with `source=ocr_vision_stub`.
9. **Demote Abdul** back: remove his Telegram ID from `ADMIN_IDS`,
   restart.
10. Have Abdul try `📷 Photo Receive` again — confirm he can submit but
    needs your approval (no dual-admin shortcut for employees).

If anything looks off during step 8, send me the screenshot or the
GRN ID and we'll iterate.
