# PDF batch sale — first-round test steps (SNAP-3)

Hand this to the tester. Owner is testing today — Admin 1 submits,
Admin 2 approves.

## A. Prerequisites (2 minutes)

1. `ANTHROPIC_API_KEY` must be on Railway. Quick check: send any PDF to
   📸 Snap Sale — if the bot replies "PDF reading runs on the Claude
   provider — add ANTHROPIC_API_KEY", stop and do that first.
   Single photos work either way (they use the other provider).
2. TWO admin accounts (A1 submits, A2 approves).
3. Build a test PDF (≤10 MB) containing:
   - 3–5 label photos of bales that ARE available in the Inventory sheet,
   - 1 label of a bale that is sold or doesn't exist (negative check),
   - 1 page duplicated (copy of one of the good labels — dedupe check).

## B. Submit — Admin 1

1. 📸 Snap Sale → send the PDF (as a file/document, not as a photo).
2. Expect "📄 Reading every label in the PDF… up to a minute."
3. Review card checks:
   - Every good label listed ✅ with the SHEET's warehouse/thans/yards
     (not whatever the PDF says).
   - The duplicated page appears ONCE (count says e.g. "4 bale(s)
     matched", not 5).
   - The bad label appears under ⚠️ skipped WITH a reason ("not available
     in the sheet" / "ambiguous — N locations"). **FAIL if it silently
     disappears or, worse, gets matched.**
4. Pick the customer (recent buyers first, or 📋 All customers).
5. "Confirm batch sale" shows the full list + totals + the customer →
   Submit. Expect "✅ Submitted… Request: <id>".
6. **A1 must NOT receive an Approve/Reject card for this request.**

## C. Approve — Admin 2

1. A2 receives: "Sale Request (Snap PDF batch)" — customer (with phone if
   on file), salesperson name, date, ONE LINE PER BALE (design, thans,
   yds, warehouse), totals, the skipped-labels note, AND the PDF itself
   as an attached document. **FAIL if the PDF doesn't arrive.**
2. Before A2 acts: have A1 try to approve their own request from any
   surface — must be blocked (self-approval guard).
3. A2 taps ✅ Approve → the rate/payment entry opens (same as any sale).
   Enter rate and payment mode.
4. On completion expect: bales flip to sold in the Inventory sheet (all
   of them, to the chosen customer), a ledger posting, and the invoice
   PDF delivered with its live web link.

## D. Negative checks

1. A PDF over 10 MB → refused with the size message.
2. A PDF whose labels match NOTHING → "Read N label(s) but NONE
   matched…" with reasons + a Sell Bale fallback button. Nothing queued.
3. A normal single PHOTO still works exactly as before (own flow).
4. Optional cost-guard check: set `OCR_DAILY_CAP` to `1` in the Settings
   sheet, do two reads — the second must be refused with the daily-limit
   message. Set it back (blank or 100) after.

## E. Verify the records

- ApprovalQueue row: action `sale_bundle`, source `snap_pdf`, status
  approved.
- Inventory: every batch bale sold to the customer; none of the skipped
  ones touched.
- Ops dashboard (📊 Dashboard tile) → Overview: the OCR reads counter
  moved.

## What to report

Screenshots per section — and if any label was MISREAD (wrong bale or
design number on the review card), send the review-card screenshot plus
that page of the PDF: the reading prompt gets tuned from real samples.
