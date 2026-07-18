# APU-1 — One approval channel, full-detail cards

Owner directive (18-Jul-2026, from the Snap Sale approval screenshot):
1. Every approval system rides ONE channel with the SAME stages.
2. The detail level of the earlier (classic sale) card remains intact everywhere.

Full findings: `docs/AUDIT_APPROVALS_2026-07-18.md`. Plan below is phased so
the owner can green-light incrementally. Phases 1-2 do NOT change who approves
what (pure card/detail work); Phases 3-4 touch semantics and need explicit
sign-off per CLAUDE.md.

## Phase 1 — Snap Sale card parity (the screenshot fix)

- Build the Snap Sale admin card with the SAME fields as the classic sale card:
  Customer (+ phone/address from CRM), Salesperson, Date (canonical DD-MMM-YYYY),
  bale line `Bale 896: 77016 5, N thans, N yds (WAREHOUSE)`, total line, and
  `📎 Sales bill attached (see below)`.
- Forward the label photo to every non-excluded admin
  (`📷 Sales bill for request <id>`), exactly like controller 6205-6216.
- Move notify out of the swallow-all try/catch: if no admin card could be sent,
  tell the requester instead of claiming success.
- Mechanism: extract the classic card builder + doc-forward loop into
  `src/services/approvalCards.js` (new file, no controller surgery beyond
  calling it — ask-first rule respected) and call it from snapSaleFlow.

## Phase 2 — Single presentation channel for ALL sites

- `approvalCards.js` becomes the ONE place approval cards are rendered:
  `buildCard(actionJSON, ctx)` registry per action type; unknown actions fall
  back to `risk/evaluate.formatAction`. Sites stop hand-writing summaries.
- `notifyAdminsApprovalRequest` gains first-class attachment support: any
  `actionJSON.sale_doc_file_id` / doc URL is auto-forwarded with the card
  (replaces per-site sendPhoto loops; keeps `opts.previewPhoto`).
- Central `getRequesterDisplayName` use — no more raw numeric ids on cards.
- riskReason: card and queue row always carry the SAME string, preferring
  `riskEvaluate` output over hardcoded text.
- Reminder + morning digest reuse the same builder (stage-aware: skip or
  correctly render transfer/supply lifecycle rows).
- Fix MarkdownV2 double-escaping (literal `*` on add_user/userManage cards).

## Phase 3 — Broken paths (owner sign-off required; no semantics loosened)

| # | Fix | Semantics change? |
|---|---|---|
| 3.1 | Map `new_customer_registration` → the working `new_customer` action at its 3 queue sites (order/receipt/sample flows), so approve executes + paused flows resume + reject cleans up | No — restores intended behavior |
| 3.2 | `srf_acc:`/`srf_ack:`: validate the row is a `supply_request` at the right stage AND the tapper is the assigned warehouse boy (or admin) before any status flip | Tightens (closes forge hole) |
| 3.3 | approvalReminder: action filter — never emit approve/reject buttons for `transfer_stock` or mid-stage `supply_request`; pass proper excludeUserId | Tightens |
| 3.4 | `update_price`: queue AFTER the solo-admin auto-approve branch (kill the orphan pending row) | No |
| 3.5 | Receipts (`rcapr:`/`rcrej:`): keep the UX, but back it with an ApprovalQueue row + AuditLog entries + H1 guard + block approved-after-rejected flips | Tightens |
| 3.6 | Rejection cleanup for eager `Pending` sheet rows (customers/marketers) | No |

## Phase 4 — Stage truth-up (each line is an owner policy decision)

- Cards must state the REAL gate. Where wording and policy disagree, which wins?
  - `add_warehouse`: evaluate.js records an owner dual-admin mandate (theft
    history) but the action is not in DUAL_ADMIN_ACTIONS → add it, or drop the
    mandate note?
  - `add_user`, `design_asset_upload`, `set_design_category`: currently
    "2 humans" only because the flows are admin-gated; formalize in
    DUAL_ADMIN_ACTIONS or leave as-is and fix the card wording?
  - `sale_bundle` backdated sales: card comment says "force 2-admin" but policy
    is single-admin since 14-Jul — confirm single-admin stands.
- Admin pool: unify on env ADMIN_IDS everywhere, or teach cards/taps/forwards
  to include sheet-cache admins? (Today: split-brain.)
- `approve_task:`: retire in favor of the tsk: state machine (which has a
  proper reject), or add a reject path?
- `rename_warehouse`: dead approval surface — build the missing request flow or
  remove from ALWAYS_APPROVAL_ACTIONS?

## Test plan

- Characterization: pin the classic sale card TEXT (gold standard) before any
  refactor; per-action card snapshot tests via approvalCards unit tests.
- snapSaleFlow characterization extended: admins receive card + photo; notify
  failure surfaces to requester.
- Reminder filter tests: transfer_stock/mid-stage supply rows produce no
  approve/reject buttons.
- Full `npm test` + `npm run smoke` + lint 0 before any push, as always.

## Status (updated 18-Jul-2026, owner green-lit "go ahead with the fix")

- [x] Phase 1 — Snap Sale gold-standard card + label-photo forward (APU-1a)
- [x] Phase 3.1/3.6 — new_customer action rename + reject cleanup (APU-1b)
- [x] Phase 3.2 — srf_acc validation (APU-1b)
- [x] Phase 3.3 — reminder skip-list + full-detail reminder cards (APU-1c)
- [x] Phase 3.4 — update_price orphan row (APU-1c)
- [x] Phase 3.5 — receipts audit trail + H1 guard + final decisions (APU-1d).
      **Deviation:** the ApprovalQueue shadow row is NOT added — it would
      mint a new action code + executor (CLAUDE.md rule 3 sign-off) and
      create dead standard buttons meanwhile. Moved to the Phase-4 menu.
- [x] Phase 2 (first wave) — detail parity for returns, add_user,
      promote/deactivate, contact network, catalog_return, landed cost,
      bulk/photo receive, unit display; plain-text cards; display names
      (APU-1e). Remaining Phase-2 items (record_payment outstanding
      balance, remove_bank context, goods-receipt supplier/PO lines,
      supply-request phone/address, morning-digest reuse) are open.
- [ ] Phase 4 — owner decision menu (unchanged, plus: migrate receipts
      fully onto ApprovalQueue with a receipt_approval executor?)
