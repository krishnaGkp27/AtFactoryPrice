# CAT-C1 — Container-aware catalogue photos (owner-locked 13-Jul-2026)

Owner: same design number can arrive with DIFFERENT shades in different
shipment containers, so one global photo per design misleads (live case:
Jul26's 44200 showed Mar26's photo). Photos become keyed by
(design, container) and the bot ASKS for fresh photos when a container lands.

Locked decisions:
1. Container-scoped screens (Supply Request, Bundle Sale) with no fresh
   photo → NO old photo: notice "📷 Fresh catalogue pending for <batch>"
   + hint to upload. Never silently show another container's shades.
2. When a new container lands (bulk_receive/PL-1 executes), ALL env admins
   get one checklist card listing the container's designs that still lack
   a fresh photo.
3. Screens without container context (Update Price, Check Stock, Samples,
   Orders) show the NEWEST active photo for the design (uploadedAt desc),
   falling back across containers.

## Mechanics

- DesignAssets sheet: new column P `ArrivalBatch` (end-of-range append per
  schema rules; ensureHeader auto-migrates). Empty batch = generic/legacy.
- Repo: `findActive(design, arrivalBatch?)` — batch given: exact
  (design, batch) active match only; omitted: newest active by uploadedAt.
  `deactivatePriorActive(design, arrivalBatch?)` retires only same-batch
  actives, so one active photo PER (design, batch) can coexist.
- Upload flow gains a container step after the design is chosen: chips from
  arrival batches that hold available stock of that design, plus
  "🌐 Generic (all containers)". Batch rides staged row → actionJSON →
  activation.
- Resolution: `getPhotoForSend(design, { arrivalBatch })` single choke
  point feeds sendDesignPhoto + sendShadePicker; both accept arrivalBatch.
  Batch-scoped miss → caller sends the pending-notice text instead.
- Checklist: bulk_receive_goods executor returns
  `photoChecklist: { batch, missingDesigns }` (designs in the landed batch
  without an active (design,batch) asset); approvalEvents broadcasts one
  card to env ADMIN_IDS after approval.

## Out of scope (v1)

- Per-design deep-link buttons on the checklist (upload flow starts from
  its normal tile; the card lists the designs to photograph).
- Backfilling Mar26 assets with the batch label (owner can re-upload per
  container as needed; legacy photos stay as generic fallbacks).
