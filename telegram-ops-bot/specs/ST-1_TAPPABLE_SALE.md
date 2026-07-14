# ST-1 — Fully tappable sale flow (owner-locked 14-Jul-2026)

Problem: typed sale commands ("Sell package 552 to chima, sales person
abdulazeez, ZENITH BANK, 11 July 2026") produce typos in customer names,
banks, and dates. Owner wants tap-only selling AND tap-only admin
enrichment at approval.

Locked decisions:
1. **Cart**: multiple bales per sale (matches real 10-bale sales).
2. **Typed sales**: keep working for now; RETIRE later once the team is
   comfortable (redirect to the tile, like TRF-5 did for transfers).
3. **Rate chips at approval**: the customer's LAST PAID price for this
   design (+ mandatory "✏️ type custom" fallback). No other chips.

## Part A — `sellBaleFlow.js` (namespace `sb:`, tile in Sales hub)

Steps (anchored message, all taps):
1. Container chips (getArrivalBatches) → 2. Warehouse chips (scoped) →
3. Design chips + CAT-C1 batch-aware photo → 4. Bale multi-select
   (available packageNos w/ thans+yds, checkbox cart, running total) →
5. Customer: recent chips + TAP-1-style full browse; search filters,
   never free-creates; ➕ New customer routes through existing approved
   flow → 6. Salesperson chips (Users sheet, sales-capable roles) →
7. Bank chips (registered banks only) → 8. Date: Today (default) /
   Yesterday / 📅 calendar (order-flow pattern); backdated warning
   preserved → 9. Review card → Submit.

Output: the SAME sell_batch/sell_package actionJSON the typed path
produces → identical approval card, DUAL-1a single-admin rule, identical
executors. Zero executor/semantics changes.

Wiring: activityRegistry tile (hub: sales) + act: case + dispatch block
(controller edits are surgical, pre-authorized by this spec's owner
sign-off). Characterization tests via controllerHarness + smoke S51.

## Part B — Tappable approval enrichment (ships first)

In startApprovalEnrichment / the enrichment answer handlers:
- **Rate/yd**: chip "₦X — last paid by <customer> for <design>" when a
  prior sale exists (source: Transactions sheet, most recent matching
  customer+design), else straight to typed prompt. "✏️ Custom" always
  offered.
- **Payment mode**: chips Cash / Transfer / registered banks (same
  source as Part A step 7).
- **Amount paid**: chips "Paid in full (₦computed)" / "✏️ Custom".
Typed fallbacks remain for every step — chips accelerate, never block.
Smoke S50; unit tests for the last-price lookup.

## Retirement path (decision 2)

After ANL-1 usage data shows tap-flow adoption, typed `sell*` intents
redirect to the tile (keep NLP recognition, drop free-text execution).
Not in v1.
