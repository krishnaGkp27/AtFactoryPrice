# 2026-05-14 — Photo Receive (P5) shipped as 5 commits

Same day, same chat. User pivoted from "Bulk Receive done?" to "How
about photo-OCR for the same slips?" — they realised the natural next
move was to let Abdul photo the packaging slip instead of typing the
CSV.

Their verbatim ask:

> Since I already have the image of the Bale once it get offloaded. If
> I provide you(bot) the pdf of all nearly visible and easily human
> understandble writing, such that bot get mapped to actual bale number
> in the packing list (I as the approver or admin will approve each bale
> addition even after AI parsing) which in turn help to mark it sold
> when any supply agent supplies from the store in later dates with
> image pdf uploaded to the bot with other customer details.

Two halves to that ask:
1. **Inbound (P5a/b):** photo of packaging slip → OCR → per-row admin
   review → existing dual-admin approval → Inventory rows.
2. **Outbound (P5c):** photo of dispatch slip → OCR → bale matching
   against current Inventory → mark sold.

I scoped the first round to **inbound only** with stub OCR (no real
Vision API yet). User signed off explicitly: `stub_only` /
`inbound_first` / `local_drive` / `no_advanced_features` / `no_cap`.

## What shipped

| Commit | Title | Why |
|---|---|---|
| `5ae3a82` P5-C1 | Vision client + stub provider | Provider abstraction so we can swap stub ↔ OpenAI ↔ Google later without touching the flows. |
| `2fa1f6b` P5-C2 | Drive backup + local archive | Every upload gets a `data/ocr/{hash}.{ext}` copy AND (when configured) a `{YYYY-MM}/` Drive folder copy. Drive failure ≠ data loss. |
| `dd769cc` P5-C3 | photoReceiveFlow + per-row review UI | The Telegram flow itself: PO link → upload → review card → submit. Per-row buttons (✅/✏/❌). Low-conf rows lose their ✅ button until edited. |
| `35ba5ac` P5-C4 | Edit subflow + submit bridge | Tap ✏ → field-by-field text-input edit. Submit bridges into the existing `bulk_receive_goods` action. Same approval gate as CSV bulk. |
| (this set) P5-C5 | docs + journal + cap polish | `docs/photo-receive-template.md` operator guide for Abdul. ROADMAP §2.7 fully populated. |

## Architectural notes

The big design lock was: **Photo Receive does NOT introduce a new
action type.** All photo-extracted batches go through
`bulk_receive_goods` (same as CSV). The only thing that differs is the
`source` tag (`ocr_vision_<provider>` vs `bulk_csv`). Consequences:

- Append-only contract (machine-enforced via S14c.8) covers photo
  receives automatically — no new code path touches Inventory.
- Dual-admin approval (machine-enforced via `ALWAYS_APPROVAL_ACTIONS`)
  applies the same way.
- Idempotency: same image → same SHA-256 → `file_hash` collision →
  rejected as duplicate. Race-condition guard at persist time (existing
  in inventoryService) catches simultaneous approvals.
- File-level validator invariants (single warehouse, (PackageNo,
  ThanNo) unique, per-bale design/shade uniformity) apply uniformly.

The OCR layer is *pure capture*. It feeds the same pipe as typing into
Excel does.

## Stub provider design

The stub returns a deterministic 5-than single-bale fixture matching
`docs/samples/bulk-receive-sample-single-bale.csv`, with row 3
intentionally low-confidence (0.55 < threshold 0.70). This means:

- Smoke tests run offline, deterministically, every time.
- The review UI's "force-edit on low-confidence" path is *always*
  exercised in development — you can't ship code that makes 🔴 rows
  silently acceptable.
- During Abdul's first manual test, the stub returns the same fixture
  regardless of what he actually photos. That's intentional — we want
  to validate the review UX before trusting a model.

Real Vision API wiring is a single follow-up commit: implement
`src/services/vision/openai.js`, set `OCR_PROVIDER=openai` +
`OPENAI_API_KEY=...` in `.env`. The dispatcher already routes to it.

## What I'd do differently

- **Skipped the cost cap.** User opted out. If real Vision wiring ever
  goes live without my supervision, I'd revisit — even a generous
  $10/day cap is a cheap insurance policy against a buggy retry loop.
- **Stuck to inbound only.** Outbound (P5c) is the higher-value half
  for daily operations (supply happens more often than receive), but
  inbound is the lower-risk testbed for the OCR pipeline. I think we
  picked correctly.
- **MAX_VISIBLE_ROWS = 10 is conservative.** Real packaging slips can
  hit 30+ thans. Will relax once we see real OCR accuracy.
- **Edit panel field order.** Currently rendered in declaration order
  (PackageNo first). For Abdul, "Yards" is the field most likely to be
  wrong. Should consider a "most-likely-edited" order based on
  field-level confidence once we have real data.

## Smoke harness arc

| Section | Coverage | Checks added |
|---|---|---|
| S15a | Vision dispatcher + stub | 15 |
| S15b | Drive backup + local archive | 10 |
| S15c | Photo flow state machine | 14 |
| S15d | Edit subflow + submit bridge | 24 |
| **Total P5** | | **+63 checks** |

Harness now at **216 green** (was 153 before P5 started this evening).

## Open follow-ups for the user to drive

1. Provide `OCR_GDRIVE_FOLDER_ID` (paste a Drive folder ID) so backups
   start working immediately. Local archive works regardless.
2. When ready: provide `OPENAI_API_KEY` + flip `OCR_PROVIDER=openai`.
   I'll wire `src/services/vision/openai.js` properly in a single
   follow-up commit.
3. Manual test with Abdul per the playbook at the bottom of
   `docs/photo-receive-template.md`.
4. Sign off on P5c (outbound photo dispatch) after a week of inbound
   usage data.
