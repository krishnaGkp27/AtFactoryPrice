# SBL-2 — compact supply card + sale doc + in-place OCR reconciliation

Owner-approved layout, 02-Aug-2026. Extends the Sold-Bales Lookup (SBL-1).

## Locked decisions

1. **New intermediate card.** Customer → date now lands on a COMPACT
   supply card in the transfer-card grammar: `🧵 design` header (with
   DCAT-1 category), then ` • Shade X ×N (bale numbers)` — nothing else.
   Thans/yards/₦ live only behind `🔎 Full details` (the old SBL-1 card,
   whose Back returns to this card, not to the date list).
2. **📄 Sale doc.** The day's bill photo/PDF(s), found on resolved
   approval rows (`sale_doc_file_id`, snap flows), delivered as
   EPHEMERAL views (TRF-9b: swept on any next `sbl:` tap + the
   DOC_VIEW_MINUTES backstop). Hidden when no doc is on file.
3. **🧮 Reconcile sale doc.** OCRs the doc(s) via the existing vision
   layer (photos + multi-page PDFs, daily-cap guarded) and re-renders the
   SAME card in place — no new card:
   - `🟢` in front of every bale number the document contains
     (digit-exact match, both sides normalized);
   - `📑 Doc check: X/Y matched` + `⚠️ Not in doc: …` (the owner's
     narrowing shortlist) + `Doc-only numbers: …` (never guessed onto a
     bale);
   - chip flips to `🔁 Re-check`; unreadable docs show a failure line and
     leave the card undotted.
3b. **✖ Stop check (SBL-2b, owner 02-Aug).** The reading state must never
   strand the card buttonless: it shows `⏳ Reading sale doc… (doc i/n)`
   with a single `✖ Stop check` button. Stop restores the card instantly;
   the in-flight OCR is orphaned by a session generation counter
   (`_recGen`) and its late result is discarded — switching to another
   day bumps the generation too, so a stale read can never dot the wrong
   card. After a stop, 🧮 can be re-tapped immediately.
4. **Read-only, rules-clean.** No sheet writes; dots are session state
   only (reopening the card starts clean). Complies with BUSINESS_RULES
   §2 (bot selects nothing — it only reports what the document says) and
   §3 (image is the reconciliation truth). Payment receipts (bank slips)
   are OUT of scope — separate feature if ever wanted.

## Files

- `src/flows/soldBalesFlow.js` — `view_summary` step, `sbl:doc` /
  `sbl:rec` / `sbl:full` callbacks, ephemeral sweep on every sbl tap.
- Tests: `test/characterization/soldBalesSupplyCard.test.js`.
