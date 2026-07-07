# Spec: Warehouse → Warehouse Transfer (two-step acceptance) — v2, simplified

**Status:** 🚧 Approved to build (TRF-2). Supersedes v1 — owner chose the LEAN design.
**Replaces:** the instant `transfer_than` / `transfer_package` / `transfer_batch` actions (final stage).

## 1. Goal

Move bales between warehouses as a short, tracked, three-party operation:
**admin requests → source dispatcher accepts → destination receiver confirms.**
Crisp UX is a hard requirement — 5 taps to create, 1 tap for each counterparty.

## 2. Owner decisions (locked, v2)

| Decision | Choice |
|---|---|
| Storage | **NO dedicated Transfers sheet.** Request rides an `ApprovalQueue` row (actionJSON payload, like sales/supply); history = `AuditLog` events + one `Transactions` row on completion. |
| Selection | **Design + shade + qty only** — the bot auto-picks the actual bales (sheet order). Specific-bale-numbers mode: dropped. |
| People | Admin-only creation. Dispatcher/receiver **auto-picked when a warehouse has exactly one assigned active user**; otherwise a one-screen picker. |
| Cancel | **No admin cancel.** Dispatcher Decline / receiver Reject are the only aborts (bales auto-revert to source). |
| In-transit | Bales flip `available → in_transit` @ destination on send: **visible at the destination (tagged 🚚), NOT sellable/supplyable** until receipt is confirmed. Reuses the Inventory `Status` column — no new column. |
| Approval gate | None beyond the chain itself — the dispatcher+receiver steps ARE the control. `transfer_stock` stays OUT of the intentParser enum and OUT of risk policy lists (own `trf:` callbacks, like the srf multi-stage). |

## 3. Flow

```
requested ──dispatcher declines──► DECLINED  (bales → available @ source)
   │
   └─dispatcher accepts─► in_transit ──receiver rejects──► REJECTED (revert to source)
                              └───────receiver confirms──► RECEIVED (available @ dest)
```

Inventory effects (via existing `inventoryRepository.transitionBales`) — **TRF-3 timing**:
the admin's request is an ORDER (`lines:[{design,shade,qty}]`, multi-line, e.g. a whole supply
cart) and locks NOTHING; the DISPATCHER's accept is the logging moment — bales are live-selected
per line (partial dispatch allowed, shortfalls recorded per line) and flipped
`available→in_transit` @ destination. Confirm = `in_transit→available`. Pre-dispatch decline
closes the order without touching inventory; post-dispatch reject reverts the logged bales to
source. Cart handoff (`srf_cart:transfer`, admin-only) carries ALL cart lines straight to the
destination step — no re-selection.

## 4. Screens

**Admin wizard** (`trf:` namespace; Inventory → Move Stock → 🚚 Transfer Stock):
1. Source warehouse (chips) → 2. Design (tiles w/ counts) → 3. Shade (chips w/ counts) →
4. Qty (chips `1 2 5 … All`) → 5. Destination (chips, source excluded) →
6. Confirm card (shows auto-picked dispatcher + receiver) → **Send**.
Extra picker screens appear only when a warehouse has >1 assigned user.

**Dispatcher DM:** `🚚 TR-xxxx — 5 bales 9006 · Shade 3 → Kano office` `[✅ Accept & dispatch] [❌ Decline]`
**Receiver DM (after dispatch):** `📦 TR-xxxx incoming from Lagos` `[✅ Received] [⚠️ Reject]`
Admin (+requester) notified at every transition. One-tap decline/reject, no typed reason (AuditLog records who/when).

## 5. Data

`ApprovalQueue.actionJSON` = `{ action:'transfer_stock', from, to, design, shade, qty, bales:[packageNo…], dispatcher, receiver, stage }`
`stage` advances via `updateActionJSON` (`requested|in_transit`); terminal state via `updateStatus`
(`approved` = received, `rejected` = declined/rejected). AuditLog: `transfer.requested|dispatched|received|declined|rejected`.

## 6. Destination visibility

Check Stock at the destination appends a `🚚 Incoming (in transit): N bales — not yet sellable`
line for that warehouse's `in_transit` rows. Sell/supply pickers already filter `status==='available'`,
so unsellability is automatic.

## 7. Build stages

1. `transferService` v2 — adapt the (tested) state machine to queue-row storage; drop `transfersRepository` + the `Transfers` schemaMapper entry (owner deletes the empty tab manually).
2. `transferFlow.js` — wizard + dispatcher/receiver cards (`trf:` callbacks; flowKit).
3. Check Stock incoming line + minimal 🚚 Transfers list (open transfers) under Move Stock.
4. Retire instant transfer (`transfer_*` from enum/policy/menu) — separate sign-off, after owner tests end-to-end on Telegram.

Each stage: tests green (`npm test`, smoke, lint 0 errors) before push; one commit per stage.
