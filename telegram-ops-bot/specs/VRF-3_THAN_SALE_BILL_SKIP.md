# VRF-3 — the bill check keys on the GOODS: thans skip, bales verify

**Status: SHIPPED 15-Aug-2026.** Spec locked with the owner first, then
built to it exactly.

One addition found during the build (adversarial review of the diff): on a
mixed sale, a bill row naming an excluded than's SOURCE bale matched
nothing once the than lines were filtered out, so it would have surfaced
as "on the bill but NOT in the request" — the same false alarm this
feature removes, wearing a different icon. Those numbers are now excused
from the extras list (`excusedPackageNos`).

## The owner's ruling (15-Aug-2026, with screenshot)

> "You have to stop doing Bill Checks for the sale which is made in
> Thans, specially since selling in Thans doesn't have detailed
> information in the image attached inside the PDF of the bill, therefore
> there is no use of wasting the credit unless you find that there is a
> complete bill [bale] sold in the approval card."

His screenshot: a 10-than backdated Kano sale whose bill check printed
ten ❌ "Bale XXXX — NOT found on the bill" lines. Every line false — a
than sale's bill is a handwritten receipt photo with no bale rows — and
the OCR read burned an OpenAI credit to produce the noise.

## Why this replaces the Locations dependency

VRF-2 (shipped 14-Aug) skips the check when the origin place is a
registered `store`, but the owner never seeded the Locations sheet, so it
never fired. This rule keys on the GOODS in the request instead — a
thans-only sale never has a bale-row bill *whatever place it ships from*
— so it works immediately and depends on no sheet. VRF-2 stays as a
second, complementary skip (either fires).

## The rule

In `saleDocVerifyService.maybeVerify`, BEFORE the download and the vision
call (the credit must be saved, not spent-and-discarded):

- **Thans-only request → skip entirely.** No download, no OCR, no 🔬
  message. Count goods the way the inbox chips already do
  (`item.type === 'than'` vs whole-bale; the inline `sell_than` shape is
  thans-only, `sell_package` is a bale). The bill still rides the
  approval card for human eyes — only the machine read stops.
- **At least one complete bale → the check runs** ("unless there is a
  complete bale sold in the approval card").

**Mixed sale (bales + thans), the edge the owner flagged and approved:**
the compare covers ONLY the whole-bale items. Than items are excluded
from the ❌/missing counts — today each than's source-bale number prints
a false "NOT found" — and the verdict carries one quiet line:
`N than item(s) not machine-checked`. The verdict stays honest for
exactly the goods it can verify.

**Goods counting must not trust `type` alone**: fall back to the same
shape logic as `approvalsInboxFlow.saleGoods` (items with `thanNo` and no
whole-bale marker are thans). If the goods CANNOT be classified at all
(malformed actionJSON), the check RUNS — uncertainty degrades towards
checking, per the VRF-2 precedent.

## Untouched

Pure bale sales (Lagos Sell Bale) verify as today · snap-source skip ·
`PDF_VERIFY_ENABLED` kill-switch · VRF-2 store skip · bill mandatoriness
at entry (§9b) · the unreadable-bill warning for sales that DO qualify.

## Build steps (done)

1. Goods classifier in `saleDocVerifyService` (pure, exported via
   `_internals`) + the gate before download, with a log line naming the
   skip reason (`than-only sale — bill check skipped (VRF-3)`).
2. Mixed-sale filter in the compare + the one-line verdict note.
3. Tests: thans-only `sale_bundle` (skip, zero vision calls), inline
   `sell_than` (skip), bales-only (runs), mixed (runs; than items absent
   from ❌; note line present), malformed items (runs — fail-safe),
   and the existing VRF-1/VRF-2 suites stay green.
4. BUSINESS_RULES §9b gains the goods rule beside the store rule;
   LOC-1 spec's VRF-2 section gets a pointer; CLAUDE.md untouched
   (no new namespace, no new sheet, no new toggle).
5. Full gate (`npm test` + smoke + lint 0 errors) → commit → ff-push
   `main`.

## Known trade-off (surfaced by the review, owner's call)

Honouring the ruling literally — *"unless you find that there is a
complete bale sold"* — means a **whole bale sold through the bundle door
from Kano office is checked again**, and a Kano bill is handwritten, so
that check will report "could not read the attached bill". The noise
window is narrow (whole-bale sales only; loose thans, the ordinary Kano
case, stay silent) and it **closes the moment the `Locations` sheet names
Kano office as a `store`** — VRF-2 then declines it on the place, before
the goods rule is consulted.

That seeding is already the owner's step 0c. Until then the alternative
would be to skip whole-bale sales too, which contradicts the ruling, so
the noisier-but-obedient side was chosen deliberately.

A cleaner long-term fix belongs upstream: `bundleSaleService.buildApprovalPayload`
hardcodes `type: 'than'` on every cart line, so a bale taken whole loses
that fact before it ever reaches the queue. A real whole-bale marker
there would let every reader — this check, the inbox chips, the approval
card's "Σ 8 than" — stop inferring it.
