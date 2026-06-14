# Spec: Dispatch Bale Picker — Merged Supply → Pick → PDF → Sell

**Status:** 📋 Planned — design fully signed off, no code yet.
**Covers:** commit DBP-1 (single commit).
**Priority:** 🥈 **2nd highest** in the forward roadmap, sitting immediately after `Commit 4 — Reports` (ROADMAP §4.1) and ahead of Templates / Adaptive UI / Customer-side / Payment Automation.
**Parent:** `ROADMAP.md` §4.10.
**Touches:** dispatch approval flow, sell pipeline, Telegram file routing.
**Reuses:** existing supply-request flow, `inventoryService.listPackages`, `markPackageSold`, `approvalQueueRepository`, `driveClient`, `sessionStore`, `sharp`.
**New dependency:** `pdf-lib` (~50KB pure-JS, zero deps).

---

## §1 Goals & non-goals

### Goals

- **Collapse two approval cycles into one.** Today a supply request needs dispatch confirmation, admin approval of the supply, and a separate manual `sell package …` command (also admin-approved). DBP-1 merges these into one approval at the end.
- **Zero typing on the dispatcher's path.** Everything that was manual data entry (package numbers, customer, salesperson, payment mode, sales date) is either auto-filled from the supply request or selected by tap.
- **Bale-level precision at admin approval.** Admin sees which specific bales the dispatcher pulled, with photographic proof (PDF), before approving the sale.
- **Same data, less duplication.** No new sheet schemas except one append-only column on `Transactions`. All in-flight picklist state lives inside `ApprovalQueue.ActionJSON._dispatch.*` — restart-safe, no extra storage layer.
- **Build the foundation for future warehouse-distance filtering** today, even though it's a no-op until warehouses are physically distant.

### Non-goals (this spec)

- **Replace the manual `sell` command for walk-in sales.** Manual `sell` / `sell_package` / `sell_batch` paths stay — DBP only governs the supply-request-driven path.
- **Partial shipments.** Bot already prevents over-orders at the sales-rep step, so shortage is a race-condition edge case handled via Cancel-with-reason (not via partial submit).
- **Cross-warehouse transfer initiation.** The bales view already groups by warehouse and lists the request's warehouse first; the actual transfer-from-other-warehouse button is left for a future DBP-2.
- **Customer-facing visibility.** Customer doesn't see the picklist; sales rep gets 3 milestone DMs.
- **Tier-based dispatch flow.** All requests go through the same picker regardless of customer tier.

---

## §2 The merged flow at a glance

```
Sales rep ──supply_request──▶ Dispatch dept (compact card)
                                          │
                                  ✅ Confirm & start picking
                                          │
                                          ▼
                              Stage B: Select Design (collapsed)
                                          │
                            (taps a design line) │
                                          ▼
                              Stage C: bales expand inline
                              (multi-select; toggle ⬜ ↔ ✅)
                                          │
                            (all lines ✅ N/N) │
                                          ▼
                              Stage D: Upload PDF / photos
                                          │
                            (file received; auto-submit) │
                                          ▼
                              Stage E: Admin sell approval
                                          │
                                ┌─────────┴─────────┐
                          ✅ Approve            ❌ Reject
                                │                   │
                                ▼                   ▼
                       markPackageSold       Dispatcher gets
                         per bale +          DM with reason;
                       Transactions          picks preserved
                       row per bale          for re-pick &
                       (with new             re-submit
                       RequestID col)
```

**Approval boundary:** the *single* admin approval at Stage E is what enforces the existing `ALWAYS_APPROVAL_ACTIONS` policy. Before Stage E nothing in inventory mutates — picks are purely metadata on the queued request.

---

## §3 Data model

### 3.1 In-flight state — `ApprovalQueue.ActionJSON._dispatch`

A namespaced sub-object on the existing `actionJSON` JSON blob. No Sheets schema change.

```jsonc
{
  // ... existing supply_request fields (warehouse, cart, customer, salesperson, paymentMode, salesDate)

  "_dispatch": {
    // Set on Confirm (Stage A → B)
    "confirmedBy":      "8021605452",
    "confirmedByName":  "Yarima",
    "confirmedAt":      "2026-06-04T22:18:31.000Z",

    // Mutated on every bale toggle. Map of cart line index → array of bale numbers
    "picks": {
      "0": ["6584", "5807"],
      "1": []
    },

    // Per-line UI state — which lines are currently expanded (UI only; not auth-critical)
    "expanded": [0, 1],

    // Set on Stage D upload completion
    "pdfDriveFileId":   "1AbC…XyZ",
    "pdfDriveLink":     "https://drive.google.com/file/d/…/view",
    "pdfPageCount":     6,
    "pdfBytes":         2_412_034,
    "pdfSubmittedAt":   "2026-06-04T22:24:08.000Z",

    // Bumped each time admin rejects and dispatcher re-submits
    "pickIteration":    1,

    // Append-only on each cancel-then-resume cycle
    "cancelHistory": [
      {
        "by":      "8021605452",
        "byName":  "Yarima",
        "at":      "…",
        "reason":  "Out of stock — waiting for refill from mill"
      }
    ],

    // Set on admin approval (Stage E success); used for audit + Transactions linkage
    "sellExecutedAt":    "…",
    "sellExecutedBy":    "<admin user_id>",
    "balesSoldCount":    6
  }
}
```

**Why this shape:**
- One JSON blob owns the entire picklist lifecycle → atomic read/write per request.
- Restart-safe: bot restart, phone die, device switch — all state recoverable from Sheets.
- Future-proof: new fields (`_dispatch.allowedWarehouses`, `_dispatch.handOffTo`, …) extend the namespace without migration.
- Pollution-free: existing supply-request consumers ignore `_dispatch.*` they don't know.

### 3.2 New column on `Transactions` sheet — `RequestID`

The only Sheets schema change in this spec. Appended to the end via `schemaMapper.js` so existing deployments auto-migrate on next boot.

Before:
```
Timestamp | User | Action | Design | Color | Qty | Before | After | Status
```

After:
```
Timestamp | User | Action | Design | Color | Qty | Before | After | Status | RequestID
```

Populated with the supply request ID when a bale is sold through DBP-1; empty for legacy `sell` paths and all other actions.

**Why a column not a new sheet:** the existing `Transactions` sheet already captures the canonical "this bale was sold" event with all key fields. Adding a column gives bale-to-request traceability without duplicating data or adding another sheet to maintain.

---

## §4 UI specification

### 4.1 Stage A — Compact card *(existing, one label change)*

Existing message; only the confirm-button label changes from `✅ Confirm` to `✅ Confirm & start picking` so the dispatcher understands they're committing to fulfillment.

```
📦 Supply Request — needs Dispatch confirmation
🏭 Warehouse: Lagos
📦 Total: 6 bales across 2 designs
👤 Customer: Ibrahim
📅 Date: 04-Jun-2026

[ 🔍 Show details ]
[ ✅ Confirm & start picking ]   [ ❌ Reject ]
```

If the request has prior cancel history, a banner appears above the buttons:

```
⚠️ Previously canceled by Abdul · 22:34
   Reason: Out of stock — waiting for refill from mill
```

### 4.2 Stage B — Select Design (all collapsed)

After Confirm. The message edits in place. Cart lines ARE the buttons — no separate body cart, no separate "View details" button.

```
📋 Picking — RID-20260604-001
🏭 Lagos · 👤 Ibrahim · 04-Jun

[ 1. 🧵 44200 │ Sh 3 │ ×4 ▶ ]
[ 2. 🧵 9031  │ Sh 1 │ ×2 ▶ ]

[ ❌ Cancel picking ]
```

### 4.3 Stage C — Bales expanded inline

Tap any design line → it expands; bale buttons appear directly under it (Telegram keyboard rows). Chevron flips `▶` → `▼`. Other lines remain in whatever state they were in (multiple lines can be open at once).

```
📋 Picking — RID-20260604-001
🏭 Lagos · 👤 Ibrahim · 04-Jun

[ 1. 🧵 44200 │ Sh 3 │ ×4 ▼ ]
[ ⬜ 6584 (245y) ]  [ ⬜ 6884 (175y) ]
[ ⬜ 5807 (245y) ]  [ ⬜ 8584 (245y) ]
[ 2. 🧵 9031 │ Sh 1 │ ×2 ▶ ]

[ ❌ Cancel picking ]
```

### 4.4 Stage C — Partial pick in progress

Tap a bale → toggles `⬜ ↔ ✅`. The parent line's count format merges in the new state.

```
📋 Picking — RID-20260604-001
🏭 Lagos · 👤 Ibrahim · 04-Jun

[ 1. 🧵 44200 │ Sh 3 │ 2/4 ▼ ]
[ ✅ 6584 (245y) ]  [ ⬜ 6884 (175y) ]
[ ✅ 5807 (245y) ]  [ ⬜ 8584 (245y) ]
[ 2. 🧵 9031 │ Sh 1 │ ×2 ▶ ]

[ ❌ Cancel picking ]
```

### 4.5 Stage C — All lines complete

When every line reads `✅ N/N`, the Upload-and-submit button appears. Dispatcher can collapse the design lines (taps the now-`▼` chevron) to clean up the picker before submit; auto-collapse-all happens on Submit tap regardless.

```
📋 Picking — RID-20260604-001
🏭 Lagos · 👤 Ibrahim · 04-Jun

[ 1. 🧵 44200 │ Sh 3 │ ✅ 4/4 ▶ ]
[ 2. 🧵 9031  │ Sh 1 │ ✅ 2/2 ▶ ]

[ 📤 Upload PDF & submit ]
[ ❌ Cancel picking ]
```

### 4.6 Stage C — Multi-warehouse grouping (foundation)

When a design+shade has bales across warehouses, sub-headers appear within the expanded section. Request's warehouse listed first. **All bales remain selectable today** — grouping is purely visual until `BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE` flips on later.

```
[ 1. 🧵 44200 │ Sh 3 │ 1/4 ▼ ]
🏭 Lagos
[ ✅ 6584 (245y) ]  [ ⬜ 6884 (175y) ]
🏭 Kano office
[ ⬜ 5902 (245y) ]  [ ⬜ 5907 (245y) ]
```

(Sub-headers are message-text lines emitted via a non-tappable button workaround — see §8.3.)

### 4.7 Button label rules

| State | Format | Example |
|---|---|---|
| Design line, untouched | `N. 🧵 DESIGN │ Sh K │ ×Q ▶` | `1. 🧵 44200 │ Sh 3 │ ×4 ▶` |
| Design line, partial | `N. 🧵 DESIGN │ Sh K │ M/Q ▶` | `1. 🧵 44200 │ Sh 3 │ 2/4 ▶` |
| Design line, complete | `N. 🧵 DESIGN │ Sh K │ ✅ Q/Q ▶` | `1. 🧵 44200 │ Sh 3 │ ✅ 4/4 ▶` |
| Design line, expanded | same prefix, `▼` instead of `▶` | `1. 🧵 44200 │ Sh 3 │ ✅ 4/4 ▼` |
| Design line, mixed-type cart | append `[Fabric]` or `[Garment]` after design | `1. 🧵 44200 [Fabric] │ Sh 3 │ ×4 ▶` |
| Bale, unpicked | `⬜ NUMBER (Yy)` | `⬜ 6584 (245y)` |
| Bale, picked | `✅ NUMBER (Yy)` | `✅ 6584 (245y)` |

Yards shorthand: `245y` (4 chars saved vs `245 yds`). Product-type tag hidden unless cart mixes types.

### 4.8 Stage D — Upload PDF prompt

On `📤 Upload PDF & submit`: auto-collapse all expanded design lines, then the message transforms to:

```
📤 Upload bale photos PDF

Review of your picks:
━━━━━━━━━━━━━━━━━━━━━━
1. 🧵 44200 │ Sh 3
   • Bale 6584 (245y)  • Bale 6884 (175y)
   • Bale 5807 (245y)  • Bale 8584 (245y)
   Subtotal: 4 bales · 910y

2. 🧵 9031 │ Sh 1
   • Bale 6105 (245y)  • Bale 6107 (140y)
   Subtotal: 2 bales · 385y
━━━━━━━━━━━━━━━━━━━━━━
Total: 6 bales · 1,295y

👤 Ibrahim   🧑 Abdul   💳 Cash   📅 04-Jun

📎 Send a PDF (or photos) of the picked bales in this chat.

[ ⬅️ Back to picking ]
[ ❌ Cancel picking ]
```

Dispatcher's next file send is captured by the surgical hook in `handleFileMessage` (see §8.2) and routed to `handlePicklistPdfUpload`.

### 4.9 Stage D — Upload acknowledgment & auto-submit

```
✅ PDF assembled (2.4 MB, 6 pages) → Drive

📤 Submitting to admin for approval…
```

Then:

```
✅ Submitted to admin

You'll be DM'd when admin approves or rejects.

[ 🔍 View what admin sees ]
```

### 4.10 Stage E — Admin sell approval card

Replaces both the legacy "supply request final approval" card and the legacy manual-`sell` admin card for DBP-1-driven requests.

```
🛒 Sell Approval — RID-20260604-001
Submitted by 👷 Yarima (Dispatch) at 22:24
Iteration 1 of N

📋 Picked items:
━━━━━━━━━━━━━━━━━━━━━━
1. 🧵 44200 │ Sh 3   [Fabric]
   • Bale 6584 (245y)  • Bale 6884 (175y)
   • Bale 5807 (245y)  • Bale 8584 (245y)
2. 🧵 9031 │ Sh 1   [Fabric]
   • Bale 6105 (245y)  • Bale 6107 (140y)
━━━━━━━━━━━━━━━━━━━━━━
Total: 6 bales · 1,295y

👤 Customer: Ibrahim
🧑 Salesperson: Abdul
💳 Payment: Cash
📅 Date: 04-Jun-2026
📎 Bale photos: [View PDF]

[ ✅ Approve & mark sold ]
[ ❌ Reject ]
[ 🔍 Show full details ]
```

On 3rd or later iteration, a `⚠️ 3rd attempt` flag appears just below the iteration line.

### 4.11 Cancel-picking prompt

```
❌ Cancel picking — RID-20260604-001
Why are you canceling?

[ 📦 Out of stock ]
[ 👤 Customer changed mind ]
[ 🚚 Logistics issue ]
[ ⚠️ Quality concern ]
[ 📝 Other (type reason) ]

[ ⬅️ Continue picking ]
```

On pick: cancel history appended; request returns to Dispatch queue with banner (see §4.1). `📝 Other` prompts for a free-text reply (captured by sessionStore type `dispatch_picklist_cancel_reason`).

### 4.12 Admin-reject DM to dispatcher

```
❌ Admin rejected your pick — RID-20260604-001
Reason: "PDF doesn't show bale labels clearly"

Your picks are preserved. You can swap any bale,
re-upload a clearer PDF, and re-submit.

[ 📋 Resume picking ]
[ ❌ Cancel request ]
```

Tap `📋 Resume picking` → opens Stage B with all picks still ✅; `pickIteration` increments on next submit.

### 4.13 Sales-rep DMs (3 milestones)

Quiet, factual, no buttons:

```
✅ Dispatch confirmed your supply request RID-….
Yarima is picking the bales now.
```

```
📤 Yarima picked 6 bales for your request RID-….
Awaiting admin approval.
```

On approve:
```
✅ Approved! 6 bales sold to Ibrahim for your request RID-….
Ledger updated.
```

On reject:
```
❌ Admin rejected the pick for your request RID-…
Reason: "PDF doesn't show bale labels clearly".
Dispatch is re-picking. You'll be DM'd again when done.
```

### 4.14 Resume entry point — `/mypicks`

A new command (also exposed as a hub-menu button) that lists every supply request the dispatcher confirmed but hasn't yet submitted:

```
📋 Your in-flight picks

[ RID-20260604-001 · Ibrahim · 2/6 picked ]
[ RID-20260603-014 · Adamu  · 0/4 picked ]
```

Tap → reopens the picklist at Stage B.

---

## §5 Lifecycle & state transitions

State lives in `actionJSON._dispatch.*` + `actionJSON.stage`. Valid `stage` values:

```
dispatch_review            (existing — Stage A)
   │  ✅ Confirm
   ▼
picking                    (NEW — Stage B/C)
   │  📤 Submit (after all ✅ N/N + PDF uploaded)
   ▼
admin_review               (existing — Stage E)
   │
   ├── ✅ Approve  ─▶  completed   (existing — runs sell pipeline)
   └── ❌ Reject   ─▶  picking     (NEW — keep picks; bump iteration)

Any non-terminal stage → cancel-with-reason → dispatch_review
                                                (with cancelHistory banner)
```

Invariants:
- Inventory writes happen ONLY on `admin_review → completed` transition.
- `picking → admin_review` is gated on `all picks complete AND pdf attached`.
- `admin_review → picking` (reject) MUST preserve `_dispatch.picks` and bump `pickIteration`.
- Cancel from any non-terminal stage MUST clear `_dispatch.picks` and `_dispatch.pdfDriveFileId`.

---

## §6 Edge cases & race handling

| Case | Behavior |
|---|---|
| Two dispatch members both see compact card, both tap Confirm | Existing Stage-1 race guard wins; only the confirming dispatcher enters picking. Other gets toast `ℹ️ Already confirmed by Yarima`. |
| Bale picked by dispatcher gets sold via another path (manual sell) before admin approves | At Stage E approve, `executeSellFromPicklist` re-checks each bale. Any conflict → admin sees `⚠️ 1 bale conflict: 6584 sold by another route` with two options: (a) Re-pick (returns to dispatcher with conflict note), (b) Approve remaining. No silent partial sale. |
| Dispatcher closes Telegram / phone dies mid-pick | All state in `_dispatch.picks` (Sheet-persisted). On reopen, scroll up to the message OR use `/mypicks`. |
| Bot restart between toggle and refresh | Same as above — JSON blob re-renders correctly. |
| Dispatcher uploads wrong PDF | Until auto-submit completes, they can tap `⬅️ Back to picking`. After auto-submit, they have to wait for admin to reject. |
| Admin rejects | `_dispatch.picks` preserved; dispatcher DM'd; can tap `Resume picking`; `pickIteration` bumps on re-submit; `⚠️ 3rd attempt` flag appears at iter ≥ 3. |
| Dispatcher cancels with reason | Reason appended to `_dispatch.cancelHistory[]`; picks discarded; request returns to `dispatch_review` stage with banner. Sales rep DM'd. |
| Telegram callback data > 64 bytes | Toggle bitmask + lineIdx + RID fits well under limit for typical cart sizes (≤12 lines × ≤32 bales). Long IDs are pre-truncated server-side. |
| Hand-off to colleague | STRICT — not supported. Dispatcher cancels with reason "Reassigning"; colleague re-confirms from queue. |
| Shortage (only 3 of 4 bales available) | NOT a feature — bot prevents over-orders at sales-rep step. Rare race goes through Cancel-with-reason. |
| PDF > 40 MB after stitching | Hard reject: `⚠️ Bundle too large (43 MB). Please re-send with fewer/smaller photos.` |
| 15+ photos sent | Soft warning: `That's a lot of photos. Submit anyway, or send fewer for faster admin review? [Submit] [Re-do]` |

---

## §7 Cross-cutting concerns

### 7.1 Audit
- **Toggles:** none. Picks are transient until submit.
- **Cancel:** appended to `_dispatch.cancelHistory[]` (in JSON blob, not a separate log).
- **Submit:** writes one row to `Transactions` per sold bale on admin approval, with the new `RequestID` column populated. This is the canonical audit row.
- **Existing `BotAuditLog`:** receives the standard `sell_bundle` event on admin approval, unchanged.

### 7.2 Rollback
- Feature flag `MERGED_DISPATCH_FLOW_ENABLED` in `src/config/index.js` (default `true` on launch).
- Flip to `false` → Stage-1 Confirm reverts to today's behavior (admin Stage-2 approval as before).
- In-flight picks: their JSON state remains in `ApprovalQueue`. Emergency `scripts/drain-picks.js` (10-line helper) lets admin manually approve or cancel them.
- Zero data loss in any rollback scenario.

### 7.3 Future warehouse-distance filtering
- Feature flag `BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE` in `src/config/index.js` (default `false`).
- Today: bales from all warehouses freely selectable; visual grouping only.
- Flip to `true` later: bales outside the request's warehouse become non-tappable (greyed labels) AND a `🔄 Request transfer from <warehouse>` button appears beside `❌ Cancel picking`.
- That transfer button is OUT OF SCOPE for DBP-1 — designed-for, not implemented.

### 7.4 Risk policy
- `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS` in `src/risk/evaluate.js`. **Unchanged.**
- The single admin approval at Stage E IS the policy gate.
- No new action enum value needed; the merged sell is executed inside the existing `supply_request` approval handler.

### 7.5 Backward compatibility
- Existing `actionJSON` without `_dispatch` namespace → request follows legacy path (no picklist).
- Existing manual `sell` / `sell_package` / `sell_batch` commands → untouched. Walk-in / phone-order sales continue to use them.
- `Transactions.RequestID` column → empty for non-DBP writes; no consumer of `Transactions` rows breaks.

---

## §8 Implementation plan

### 8.1 Files touched

| File | Change | Risk |
|---|---|---|
| `src/events/approvalEvents.js` | Confirm branch (`smc:c`) → after existing logic, transition to Stage B. New callbacks: `dpl:d:<rid>:<lineIdx>` (toggle design expand), `dpl:t:<rid>:<lineIdx>:<bale>` (toggle bale pick), `dpl:u:<rid>` (start upload), `dpl:b:<rid>` (back to picking from upload screen), `dpl:c:<rid>` (cancel picking), `dpl:cr:<rid>:<reasonCode>` (cancel reason chosen), `dpl:r:<rid>` (resume after admin reject). New helpers: `buildPicklistView`, `buildBaleRows`, `buildUploadView`, `buildAdminSellCard`, `handlePicklistPdfUpload`, `executeSellFromPicklist`. | Low — additive on existing handler; no removal of existing behavior. |
| `src/services/inventoryService.js` | New entry point `executeSellFromPicklist({rid, picks, customer, salesperson, paymentMode, salesDate, userId})` that loops `markPackageSold` per picked bale + writes `Transactions` rows with `RequestID` populated. | Low — composes existing primitives, no policy bypass. |
| `src/repositories/inventoryRepository.js` | **No change.** | — |
| `src/repositories/approvalQueueRepository.js` | Add `updateActionJSON(requestId, patchFn)` (read-mutate-write) if not already present. | Low — additive. |
| `src/repositories/transactionsRepository.js` | Add `RequestID` to `HEADERS` (end of array); extend `toRow` / `parseRow`; bump column count. `schemaMapper.js` handles live migration on boot. | Low — append-only schema change. |
| `src/services/schemaMapper.js` | Ensure `Transactions` sheet auto-adds the new `RequestID` header cell if missing on boot. | Low — existing pattern. |
| `src/controllers/telegramController.js` | **Surgical 5-line patch** to `handleFileMessage`: pre-route to picklist PDF handler when `session.type === 'dispatch_picklist_pdf'`. Explicit per `CLAUDE.md`. | Medium — touches sacred file, but minimum-possible change, gated on session state. |
| `src/risk/evaluate.js` | **No change.** | — |
| `src/config/index.js` | Add `MERGED_DISPATCH_FLOW_ENABLED` (default `true`) and `BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE` (default `false`). | Low. |
| `src/utils/sessionStore.js` | **No change** — reuses existing TTL pattern with new session types: `dispatch_picklist_pdf`, `dispatch_picklist_cancel_reason`. | — |
| `src/utils/pdfStitcher.js` | **NEW** — wraps `sharp` (compress) + `pdf-lib` (assemble) into `stitchToPdf(photoBuffers): Buffer`. Pure function, unit-testable offline. | Low — new isolated module. |
| `scripts/smoke.js` | ~14 new offline assertions (see §8.4). | Low — additive. |
| `package.json` | Add `pdf-lib` dependency. | Low — well-known, pure-JS, zero-dep package. |
| `specs/dispatch-bale-picker.md` | This file. | — |
| `ROADMAP.md` | New §4.10 entry + priority note. | Low — documentation. |

### 8.2 Surgical patch to `telegramController.js`

Justification: per `CLAUDE.md`, surgical one-line patches to the sacred file are permitted when explicitly asked. Owner gave explicit instruction in the design conversation.

Shape:
```js
async function handleFileMessage(bot, msg) {
  const sess = sessionStore.get(String(msg.from.id));
  if (sess && sess.type === 'dispatch_picklist_pdf') {
    return require('../events/approvalEvents')
      .handlePicklistPdfUpload(bot, msg, sess);
  }
  // ... existing handler continues unchanged
}
```

Five lines, pure prepend, no removal. Documented in the commit message as `... per explicit user instruction`.

### 8.3 Multi-warehouse sub-header workaround

Telegram inline keyboards have only buttons, no header rows. To render a non-tappable warehouse label between bale buttons:

- Render warehouse name as a button with `callback_data: 'noop'`, label `🏭 <name>`.
- `noop` callback is answered silently (`bot.answerCallbackQuery(id, { text: '' })`).
- Visually reads as a header row.

(Alternative: insert the warehouse name as a non-button row in message text and split bales into separate sub-messages. Rejected — breaks the "one message" pattern.)

### 8.4 Smoke harness additions (~14 checks)

| # | Assertion |
|---|---|
| S1 | `dpl:d` callback toggles `expanded` array correctly (open → close → open). |
| S2 | `dpl:t` callback toggles bale into/out of `picks[lineIdx]`. |
| S3 | Design button label format renders correctly for `×Q`, `M/Q`, `✅ Q/Q` states. |
| S4 | Chevron renders `▶` for collapsed, `▼` for expanded. |
| S5 | `📤 Upload PDF & submit` button is absent when any line is incomplete; present when all complete. |
| S6 | Cancel-with-reason appends to `cancelHistory[]` and re-renders compact card with banner. |
| S7 | `Other` reason captures next text message via `sessionStore.type === 'dispatch_picklist_cancel_reason'`. |
| S8 | Auto-collapse on Submit clears `expanded` array before rendering upload view. |
| S9 | `stitchToPdf` produces valid PDF for 1 photo, 3 photos, 15 photos (no crash). |
| S10 | PDF size > 40 MB rejects with clear message; PDF size < 40 MB accepts. |
| S11 | Admin reject preserves `_dispatch.picks` and bumps `_dispatch.pickIteration`. |
| S12 | `⚠️ 3rd attempt` flag appears at iter ≥ 3. |
| S13 | `executeSellFromPicklist` writes one `Transactions` row per bale with `RequestID` populated. |
| S14 | Stateless re-render after simulated bot restart: load actionJSON from sheet, render exact same picklist view. |

All offline. Zero real Telegram / Sheets / OpenAI / Drive calls.

### 8.5 Commit plan

One commit on a branch (recommended):

```
feat(dispatch): DBP-1 merged supply→pick→PDF→sell flow with tappable bale picker

Implements ROADMAP §4.10 / spec dispatch-bale-picker.md.

- Collapses supply-request + sell into one approval cycle.
- New picklist UI: cart-line buttons, inline expand/collapse, multi-select bales.
- New session types: dispatch_picklist_pdf, dispatch_picklist_cancel_reason.
- New entry executeSellFromPicklist composes existing markPackageSold per bale.
- Adds RequestID column to Transactions sheet (schemaMapper auto-migrates).
- Adds pdf-lib dependency for stitching photos → single PDF.
- Adds MERGED_DISPATCH_FLOW_ENABLED + BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE flags.
- Surgical 5-line route in telegramController.handleFileMessage per explicit user instruction.
- 14 new smoke checks; full harness green.

Risk policy unchanged; supply_request stays in ALWAYS_APPROVAL_ACTIONS.
```

Branch: `feat/dispatch-bale-picker`.

### 8.6 Acceptance criteria (done definition)

- [ ] `npm run smoke` green with the 14 new checks.
- [ ] Manual end-to-end on a staging bot with a 2-line cart: confirm → pick all → upload PDF → admin approves → bales marked sold in Inventory, Transactions rows include `RequestID`, sales rep got 3 milestone DMs, dispatcher got the "approved" confirmation.
- [ ] Manual cancel-with-reason path: dispatcher cancels with "Out of stock" → request returns to Dispatch queue with banner.
- [ ] Manual admin-reject path: admin rejects → dispatcher gets DM → taps Resume → re-submits → admin approves on iteration 2.
- [ ] Flag toggle test: set `MERGED_DISPATCH_FLOW_ENABLED=false` → confirm falls back to legacy admin-only Stage-2.
- [ ] `Transactions` sheet has the `RequestID` column populated for new DBP-1 sales, empty for legacy `sell` writes.

---

## §9 Locked decisions log

Every design call settled during the design conversation. No open questions remain.

| # | Decision | Choice |
|---|---|---|
| 1 | Trigger | Post-Confirm in dispatch Stage-1 card |
| 2 | Cart-line UI | Whole line IS the button (no separate "View details") |
| 3 | Expansion | Inline `▶ / ▼` chevron; multiple open at once |
| 4 | Bale selection | Multi-select toggle `⬜ ↔ ✅` |
| 5 | Bale label | `Bale 6584 (245y)` — number + yards only |
| 6 | Multi-warehouse | Grouped sub-headers from day one; request's warehouse first |
| 7 | Warehouse filter | Feature flag `BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE` (default `false`) |
| 8 | Back-button warning | Only when zero picks made (toast, non-blocking) |
| 9 | Toggle audit | None — picks transient until submit |
| 10 | Submit gate | Only when ALL lines `✅ N/N` |
| 11 | Auto-collapse | All expanded lines collapse before PDF screen |
| 12 | PDF input | PDF or photos (stitched to single PDF) |
| 13 | Stitching | `sharp` (compress) + `pdf-lib` (assemble) |
| 14 | Size cap | 40 MB hard cap; soft warning at 15+ photos |
| 15 | Cancel flow | Preset reasons + Other (free text); returns to Dispatch queue with banner |
| 16 | Sales-rep DMs | 3 milestones: confirmed, picked & awaiting admin, approved/rejected |
| 17 | Admin reject | Keep picks; iteration counter; `⚠️ 3rd attempt` flag at iter ≥ 3 |
| 18 | Audit storage | Existing `Transactions` sheet + new `RequestID` column |
| 19 | Schema changes | Only one — `RequestID` appended to `Transactions` (via schemaMapper) |
| 20 | Handoff | STRICT — not supported; cancel-with-reason instead |
| 21 | Shortage | Not a feature — bot prevents over-orders upstream |
| 22 | In-flight state | `actionJSON._dispatch.*` namespace; restart-safe |
| 23 | Resume path | `/mypicks` command + hub-menu button |
| 24 | Rollback | Feature flag `MERGED_DISPATCH_FLOW_ENABLED` (default `true`) |
| 25 | Controller touch | Surgical 5-line patch — explicit per `CLAUDE.md` |
| 26 | Risk policy | Unchanged — `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS` |
| 27 | Design label | Minimal: `N. 🧵 DESIGN │ Sh K │ count ▶/▼` |
| 28 | Product-type tag | Hidden by default; shown only on mixed-type carts |
| 29 | Confirm button label | Renamed to `✅ Confirm & start picking` for clarity |
| 30 | Smoke checks | ~14 new offline assertions |

---

## §10 Out of scope (future DBP-N candidates)

- **DBP-2:** Activate `BALES_PICKLIST_FILTER_TO_REQUEST_WAREHOUSE` + `🔄 Request transfer from <warehouse>` button. Triggered when warehouses become physically distant.
- **DBP-3:** Optional partial-shipment flow if commercial reality changes (currently locked out by upstream over-order guard).
- **DBP-4:** Customer-side DMs richer than the 3 milestones (e.g. ETA, courier tracking).
- **DBP-5:** Bulk operations — select-all / deselect-all per design when bale counts grow large.
- **DBP-6:** Integration with future Task Templates (commit 5a/5b/6) — auto-generate a "Deliver order RID-X" task on admin approval.

---

*Spec authored: Jun 2026. All decisions captured from the design conversation that preceded this commit. Implementation pending owner go-ahead.*
