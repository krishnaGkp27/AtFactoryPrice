# Spec: Dispatch Assignment — Receipt-Aware Approval → Broadcast → Accept → Pick

**Status:** 📋 Planned — design signed off, no code yet.
**Covers:** commits DA-1 (receipt-aware supply approval) + DA-2 (broadcast assignment & first-accept-wins) + DA-3 (bridge into the bale picker).
**Priority:** Owner to choose build order vs `sales-channel-segmentation.md`.
**Parent:** `ROADMAP.md` (new §4.12). **Sits directly upstream of** `dispatch-bale-picker.md` (DBP-1) — DA-3 hands an accepted request into the DBP-1 picker as the task's execution body.
**Touches:** supply-request approval flow (`approvalEvents.js`), task lifecycle (`taskStateMachine.js`), Telegram notification routing.
**Reuses:** `approvalQueueRepository`, `tasksRepository`, `taskStateMachine`, `usersRepository` (warehouse + dept), `deptGraph.listAssignableUsers`, `driveClient` (receipt storage), `sessionStore`, `telegramUI`, existing supply-request card.

---

## §1 Goals & non-goals

### Goals

- **One approval that also checks payment.** The sales head (admin for now) reviews the supply request **with its payment receipt**, can **attach the receipt themselves** if the sales rep didn't, confirms payment received, then approves.
- **Broadcast, first-accept-wins assignment.** Approved requests are **broadcast to a pool of candidate dispatchers** (those tied to the warehouse holding the product). The **first to accept wins**; the task is created **only on acceptance**. Inspired by hyper-delivery dispatch (Blinkit/Zomato/Swiggy) — no pre-created tasks, no losers to clean up.
- **Quiet sibling cleanup.** When one dispatcher accepts, every other candidate's card is **edited in place to "already taken"** — no extra DMs, no details leaked.
- **Immediately workable.** An accepted task is workable **right away**; the **dispatch day is a deadline, not a start gate** — the dispatcher may start picking (DBP-1) before the dispatch day if it helps.
- **No-accept fallback + optional force-assign.** If nobody accepts, the request **returns to the admin inbox**. Admin may re-broadcast or **force-assign** to a specific dispatcher.
- **Lower-model-implementable.** Prescriptive enough that a smaller model can build it exactly as designed.

### Non-goals (this spec)

- **The picking UI itself.** That is `dispatch-bale-picker.md` (DBP-1). DA-3 only **bridges** an accepted request into it.
- **A separate Sales Head role.** "Sales head" = the existing **admin** for now. Role split is future.
- **Zenith Bank payment automation.** Payment is **manually confirmed** by the admin from the attached receipt. Bank-API automation is future.
- **Multi-task / partial dispatch across several dispatchers.** One request → one accepted task → one dispatcher.
- **Order state machine.** Order status transitions beyond what `ordersRepository`/approval already track are out of scope.

---

## §2 End-to-end flow

```
Sales rep ──supply_request──▶ (receipt OPTIONAL)
        │                          design→shade→price→order created
        ▼
Admin (Sales Head) approval card
   • sees request + receipt (if attached)
   • can 📎 Attach receipt  (if rep didn't)
   • 💳 confirms payment received
        │
   ✅ Approve & assign
        │
        ▼
Candidate pool = dispatchers tied to the product's warehouse
   • Broadcast ONE card to each candidate (with schedule / dispatch day)
        │
   ┌────┴──────────────┬───────────────────────────┐
   ▼                   ▼                            ▼
✅ first Accept   ❌ Decline (one)            ⏳ nobody accepts
   │                   │                            │
   ▼                   ▼                            ▼
Task CREATED      candidate removed           returns to ADMIN inbox
+ assigned        from pool; others           [ 🔁 Re-broadcast ]
to accepter       still pending               [ 👤 Force-assign ]
   │
   ▼
Siblings' cards EDITED → "✅ Taken — no longer available"
   │
   ▼
Task in accepter's My Tasks — workable NOW (dispatch day = deadline)
   │
   ▼  (DA-3 bridge)
DBP-1 picker  ──▶  pick → PDF → admin sell approval (per dispatch-bale-picker.md)
```

---

## §3 Data model

### 3.1 Receipt + payment state — `ApprovalQueue.ActionJSON._supply`

Namespaced sub-object on the existing supply-request `actionJSON` blob. No Sheets schema change.

```jsonc
{
  // ... existing supply_request fields (warehouse, cart, customer, salesperson, salesDate, price)

  "_supply": {
    "receiptDriveFileId": "1AbC…",      // set by rep at request time OR admin at approval
    "receiptDriveLink":   "https://drive.google.com/file/d/…/view",
    "receiptAttachedBy":  "<userId>",
    "receiptAttachedAt":  "…",

    "paymentConfirmedBy": "<adminId>",  // set when admin ticks "payment received"
    "paymentConfirmedAt": "…"
  }
}
```

### 3.2 Assignment state — `ApprovalQueue.ActionJSON._assign`

```jsonc
{
  "_assign": {
    "stage":          "broadcasting",   // broadcasting | accepted | no_accept | force_assigned
    "warehouse":      "Lagos",
    "dispatchDay":    "2026-06-08",     // deadline, not a start gate
    "scheduleNote":   "morning load",

    // Candidate pool snapshot at broadcast time
    "candidates": [
      { "userId": "111", "name": "Yarima", "chatId": 111, "messageId": 9001, "state": "pending" },
      { "userId": "222", "name": "Abdul",  "chatId": 222, "messageId": 9002, "state": "declined" }
    ],

    "acceptedBy":     "111",
    "acceptedByName": "Yarima",
    "acceptedAt":     "…",
    "taskId":         "T-20260608-003",  // created only on accept

    // Append-only audit of broadcast cycles (re-broadcast bumps this)
    "broadcastCount": 1,
    "history": [
      { "event": "broadcast", "at": "…", "by": "<adminId>", "candidateCount": 2 }
    ]
  }
}
```

**Why JSON blob, not new sheet:** mirrors the proven DBP-1 pattern (`_dispatch.*`). Atomic per-request read/write, restart-safe, no new storage layer. `candidates[].messageId` is what makes the **quiet sibling edit** possible (we know which message to overwrite on each candidate's chat).

### 3.3 Task creation (on accept only)

On first accept, create one `Tasks` row via `tasksRepository` with:
- title: `Dispatch RID-… · <customer> · <warehouse>`
- assignee = accepter
- due = `dispatchDay`
- a back-reference field to the request id (reuse existing task→source linkage; if none exists, store the RID in the task notes/`source` field — no schema reorder).

**No tasks are created for non-accepters.** This is the core "candidate pool" win — nothing to cancel.

---

## §4 Task state machine touch

`taskStateMachine.js` is a pure engine. DA-2 adds **one** transition so the assignment is representable without bypassing the engine:

- **New transition `assigner_proposed`** — represents "request broadcast to a candidate pool, awaiting acceptance," resolving to the standard accepted/assigned state on first accept.

No other engine changes. Existing transitions/roles untouched. (Owner-approved: exactly one new transition.)

---

## §5 UI specification

### 5.1 DA-1 — Admin approval card (receipt-aware)

Extends the existing supply-request approval card. Two states by whether a receipt is attached.

**Receipt present:**
```
🛒 Supply Approval — RID-20260608-003
👤 Customer: Ibrahim   🧑 Rep: Abdul
🏭 Warehouse: Lagos    📅 04-Jun
📦 6 bales · 2 designs · ₦ …

📎 Payment receipt: [View]

[ 💳 Payment received ✓ ]
[ ✅ Approve & assign ]   [ ❌ Reject ]
```

**Receipt missing (rep didn't attach):**
```
🛒 Supply Approval — RID-20260608-003
…
⚠️ No payment receipt attached.

[ 📎 Attach receipt ]
[ 💳 Payment received ✓ ]
[ ✅ Approve & assign ]   [ ❌ Reject ]
```

- `📎 Attach receipt` → sets sessionStore `supply_receipt_upload`; admin's next file is stored to Drive and linked into `_supply`.
- `💳 Payment received ✓` toggles a confirmed badge; recommended (not hard-required) before approve — a soft confirm prompt appears if approving without it.
- `✅ Approve & assign` → proceeds to candidate-pool broadcast (§5.2).

### 5.2 DA-2 — Candidate dispatcher card (broadcast)

One identical card sent to every candidate. `callback_data` carries the RID so any accepter resolves the same request.

```
🚚 New Dispatch — RID-20260608-003
🏭 Lagos · 👤 Ibrahim
📦 6 bales · 2 designs
📅 Dispatch day: 08-Jun (morning load)

First to accept gets it.

[ ✅ Accept ]   [ ❌ Decline ]
```

### 5.3 DA-2 — Sibling card after someone accepts

Every **other** candidate's card is **edited in place** (no new DM):

```
✅ Taken — RID-20260608-003 was accepted by another dispatcher.
```

(No customer, no who-accepted detail — owner decision: quiet, minimal.)

### 5.4 DA-2 — Accepter confirmation

The accepter's card transforms into the task entry point:

```
✅ You accepted RID-20260608-003.
🏭 Lagos · 👤 Ibrahim · 📅 due 08-Jun

It's in your tasks now. You can start picking any time.

[ 📋 Open task / start picking ]
```

`📋 Open task / start picking` → DA-3 bridge into DBP-1 Stage B (§6).

### 5.5 DA-2 — No-acceptance return to admin

If the pool is exhausted (all declined) or a timeout/manual check finds none accepted:

```
⏳ No dispatcher accepted RID-20260608-003.

[ 🔁 Re-broadcast ]
[ 👤 Force-assign… ]
[ ❌ Cancel request ]
```

- `🔁 Re-broadcast` → re-sends to the (optionally refreshed) candidate pool; `broadcastCount++`.
- `👤 Force-assign…` → admin picks one dispatcher (via `deptGraph.listAssignableUsers` filtered to the warehouse); task created directly, `stage='force_assigned'`.

### 5.6 Decline (single candidate)

`❌ Decline` edits only that candidate's own card to `❌ You declined RID-…`, sets their `candidates[].state='declined'`, leaves others pending. When the **last** pending candidate declines → trigger §5.5.

---

## §6 DA-3 — Bridge into DBP-1

DA-3 is intentionally thin: it connects "accepted dispatch task" → "DBP-1 picking."

- The accepted request already carries the supply cart in `actionJSON`. DA-3 routes `📋 Open task / start picking` (and the task's entry in **My Tasks**) to **DBP-1 Stage B** (`buildPicklistView`) for that RID.
- From there, the entire `dispatch-bale-picker.md` flow runs unchanged (pick → PDF → admin sell approval).
- **Dependency:** DA-3 requires DBP-1 to be implemented (or stubbed). If DBP-1 isn't built yet, DA-3 falls back to the legacy manual sell path and just marks the task in-progress. Build order: DBP-1 before DA-3, or ship DA-3 behind a flag.

---

## §7 Lifecycle & invariants

```
supply_request approved (DA-1)
        │
        ▼
_assign.stage = broadcasting        ← candidates notified, no task yet
        │
        ├── first Accept ─▶ accepted        (task created, siblings edited)
        ├── all Decline ──▶ no_accept        (admin inbox: re-broadcast / force / cancel)
        └── Force-assign ─▶ force_assigned   (task created directly)
```

Invariants:
- **A task is created at most once per request** — guarded by an atomic check-and-set on `_assign.acceptedBy` (first writer wins; later accepters get the "taken" toast).
- **No task exists for any non-accepter**, ever.
- **Inventory is not mutated** by DA at all — DA only assigns; the sell happens later in DBP-1's admin approval.
- **Re-broadcast preserves history** (`_assign.history[]`, `broadcastCount`).
- **Dispatch day is a deadline**, never blocks starting work.

---

## §8 Edge cases & race handling

| Case | Behavior |
|---|---|
| Two dispatchers tap Accept within milliseconds | Atomic check-and-set on `_assign.acceptedBy`; first wins, creates the task. Loser gets toast `ℹ️ Already taken` and their card edits to §5.3. |
| Accepter's chat message can't be edited (deleted/old) | Best-effort edit; failure is non-fatal — accept still succeeds; sibling edits are best-effort too. |
| A candidate is added/removed from the warehouse between broadcast and accept | Pool is a **snapshot** at broadcast (`_assign.candidates`); changes apply only on re-broadcast. |
| Admin approves without ticking "payment received" | Soft confirm: `Approve without confirming payment? [Approve anyway] [Back]`. Not a hard block. |
| Rep attached receipt AND admin attaches another | Latest attach wins in `_supply`; both Drive files retained (no delete). |
| Nobody accepts, admin does nothing | Stays in admin inbox at `no_accept`; no auto-escalation in this spec (future: timed reminder). |
| Force-assigned dispatcher never starts | Normal task SLA/reminders apply (existing task reminder system). |
| Request canceled after acceptance | Reuse existing approval cancel; accepted task is closed via existing task lifecycle. |
| Callback data > 64 bytes | Only RID + short verb in callback; well under limit. |

---

## §9 Cross-cutting concerns

### 9.1 Risk policy
- `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS` — **unchanged**. DA-1 is that same approval, enriched with receipt/payment UI.
- Assignment/accept are **not** new risk-gated actions (they're routing, not inventory writes). The inventory-mutating step remains DBP-1's single admin sell approval.
- **Do not change approval semantics in `risk/evaluate.js`** without explicit instruction (CLAUDE rule #3). DA needs none.

### 9.2 Controller / parked file
- Receipt upload routing needs a **surgical hook** in `handleFileMessage` (same shape as DBP-1's): when `session.type === 'supply_receipt_upload'`, route to the DA handler. Explicit per CLAUDE rule #2; show diff first.

### 9.3 Notifications
- Broadcast + sibling edits go through existing bot send/edit helpers. Sibling cleanup is **edit-in-place** (store `messageId` per candidate), not new messages.

### 9.4 Flags
- `DISPATCH_ASSIGNMENT_ENABLED` (default `true`).
- `DISPATCH_FORCE_ASSIGN_ENABLED` (default `true`).
- DA-3 bridge gated by the DBP-1 flag (`MERGED_DISPATCH_FLOW_ENABLED`).

### 9.5 Backward compatibility
- Requests without `_assign`/`_supply` namespaces follow the legacy approval path.
- No existing sheet schema changes.

---

## §10 Implementation plan

### 10.1 Files

| File | Change | Risk |
|---|---|---|
| `src/events/approvalEvents.js` | DA-1 receipt/payment UI on the supply approval card; DA-2 broadcast, accept (`da:acc:<rid>`), decline (`da:dec:<rid>`), re-broadcast (`da:rb:<rid>`), force-assign (`da:fa:<rid>:<userId>`); sibling-edit + task-create helpers. | Medium — additive on existing handler. |
| `src/flows/taskStateMachine.js` | Add **one** transition `assigner_proposed`. | Low — owner-approved, additive. |
| `src/repositories/approvalQueueRepository.js` | `updateActionJSON(rid, patchFn)` (shared with DBP-1 if not present). | Low. |
| `src/repositories/tasksRepository.js` | Use existing append; store RID linkage (existing field or notes). | Low. |
| `src/services/dispatchAssignmentService.js` | **NEW** — pure helpers: build candidate pool from warehouse (`usersRepository` + `deptGraph`), atomic accept resolution, card/text builders. Offline-testable. | Low — new isolated module. |
| `src/controllers/telegramController.js` | **Surgical hook** in `handleFileMessage` for `supply_receipt_upload`. Diff shown first (parked file). | Medium — minimal, gated. |
| `src/config/index.js` | DA flags (§9.4). | Low. |
| `scripts/smoke.js` | DA assertions (§10.3). | Low. |
| `specs/dispatch-assignment.md` | This file. | — |
| `ROADMAP.md` | New §4.12 entry; cross-link to DBP-1. | Low — docs. |

### 10.2 Commit plan

- **DA-1 — Receipt-aware approval:** receipt attach + payment-confirm on the existing supply approval card. Independent, shippable alone.
  ```
  feat(dispatch): DA-1 receipt-aware supply approval with payment confirm
  ```
- **DA-2 — Broadcast assignment + first-accept-wins:** candidate pool, broadcast, accept/decline, quiet sibling edits, no-accept fallback, force-assign, `assigner_proposed` transition.
  ```
  feat(dispatch): DA-2 broadcast dispatch assignment with first-accept-wins
  ```
- **DA-3 — Picker bridge:** route accepted task → DBP-1 Stage B (flagged on DBP-1).
  ```
  feat(dispatch): DA-3 bridge accepted dispatch task into bale picker
  ```

### 10.3 Smoke harness additions (offline)

| # | Assertion |
|---|---|
| D1 | DA-1: approval card renders the "attach receipt" variant when `_supply.receiptDriveFileId` absent, "View" variant when present. |
| D2 | DA-1: `supply_receipt_upload` session routes a file into `_supply` and flips the card variant. |
| D3 | DA-2: candidate pool = users tied to the request's warehouse (via usersRepository + deptGraph). |
| D4 | DA-2: first accept sets `_assign.acceptedBy`; second accept is rejected (atomic), loser gets "taken". |
| D5 | DA-2: on accept, exactly one task is created; non-accepters get zero tasks. |
| D6 | DA-2: sibling cards edit to the "Taken" text using stored `messageId`s. |
| D7 | DA-2: all-decline → `_assign.stage='no_accept'` and admin inbox card renders re-broadcast/force-assign. |
| D8 | DA-2: re-broadcast bumps `broadcastCount` and appends to `history[]`. |
| D9 | DA-2: force-assign creates a task with `stage='force_assigned'`. |
| D10 | `taskStateMachine` exposes `assigner_proposed` and resolves to accepted/assigned on accept. |
| D11 | Accepted task is workable before `dispatchDay` (no start-gate check). |
| D12 | Flags off → legacy approval path; no broadcast. |

### 10.4 Acceptance criteria

- [ ] `npm run smoke` green with D-checks.
- [ ] End-to-end: rep submits without receipt → admin attaches receipt, confirms payment, approves & assigns → two test dispatchers get the card → one accepts → task created for accepter, sibling card shows "Taken" → accepter opens task and (with DBP-1) enters the picker.
- [ ] All-decline path → returns to admin inbox → re-broadcast works → force-assign works.
- [ ] Accepted task is workable before dispatch day.
- [ ] Flags off → legacy behavior.

---

## §11 Locked decisions log

| # | Decision | Choice |
|---|---|---|
| 1 | Sales Head | = admin for now |
| 2 | Receipt | **Optional** for rep; admin may attach + verify at approval |
| 3 | Payment | Manual confirm from receipt (Zenith API later) |
| 4 | Assignment model | **Broadcast, first-accept-wins** candidate pool (hyper-delivery style) |
| 5 | Candidate pool | Dispatchers tied to the product's warehouse; snapshot at broadcast |
| 6 | Task creation | **Only on accept** (or force-assign) — never for losers |
| 7 | Sibling cleanup | **Edit card in place** to "Taken"; no DMs, no details |
| 8 | Decline | Removes that candidate; last decline → no-accept fallback |
| 9 | No-accept | Returns to **admin inbox**: re-broadcast / force-assign / cancel |
| 10 | Force-assign | Optional admin override → direct task |
| 11 | Dispatch day | **Deadline, not a start gate**; work may begin earlier |
| 12 | Engine change | Exactly **one** new transition `assigner_proposed` |
| 13 | State storage | `actionJSON._supply` + `actionJSON._assign` namespaces |
| 14 | Inventory | DA never mutates inventory; sell stays in DBP-1 |
| 15 | Risk policy | Unchanged; `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS` |
| 16 | Controller touch | Surgical `handleFileMessage` hook for receipt upload; diff first |
| 17 | Commits | DA-1, DA-2, DA-3 |
| 18 | DA-3 dependency | Needs DBP-1; flagged/fallback otherwise |

---

## §12 Out of scope (future DA-N)

- **DA-4:** timed auto-escalation when nobody accepts within N minutes.
- **DA-5:** Zenith Bank API payment auto-verification (replaces manual `💳 Payment received`).
- **DA-6:** distance/load-aware candidate ranking (closest/least-busy dispatcher first), the deeper hyper-delivery model.
- **DA-7:** dedicated Sales Head role split from admin.
- **DA-8:** partial/multi-dispatcher fulfillment for very large orders.

---

*Spec authored: Jun 2026. Decisions captured from the design conversation. Implementation pending owner go-ahead. Pairs with `dispatch-bale-picker.md` (DBP-1, execution body) and `sales-channel-segmentation.md` (upstream catalog view).*
