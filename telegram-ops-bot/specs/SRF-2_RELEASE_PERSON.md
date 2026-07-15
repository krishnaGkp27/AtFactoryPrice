# SRF-2 — Warehouse release person in the supply-request chain (DRAFT for owner sign-off)

Status: **draft — decisions below need the owner's lock before implementation.**
Requested 14-Jul-2026 (owner, via screenshot of request `28619d4a…`).

## What the owner asked

> "Yarima is dispatch person (who will carry goods and go). Abdul is the person
> who will release the goods from warehouse. I want to select the warehouse
> person also to release the goods."

## How the chain works TODAY (for reference)

1. Requester builds the supply cart, picks **customer**, a person under the
   label **🧑 salesperson (order collected by)** ← this is where Yarima was
   picked, **payment**, **date**, taps Confirm.
2. Stage 1 — the compact card goes to **every active user of the Dispatch
   department** (currently: Neha, Muhammad, Tessa Parker), NOT to the person
   picked in the cart. Any one of them Confirms/Rejects.
3. Stage 2 — admins get the approval card; on approve, an admin **assigns a
   dispatch person** (warehouse-boy picker) who then receives the
   "📦 New Supply Assignment" card.
4. Goods movement is recorded; no release-custody step exists.

So today "who carries" is decided at Stage 2 by the admin, and **nobody is
asked to release the goods from the warehouse**.

## Proposed change

### A. Name the roles honestly in the cart
- Relabel the existing picker to **🚚 Dispatch person (carries goods)** —
  same data, same `srf_sp` callbacks, label only.
- Add one new picker step after it: **🏭 Release by (warehouse)** — chips of
  active users whose `warehouses` column includes the cart's warehouse
  (e.g. Abdul for Lagos). Fallback when none match: all active users of the
  cart's warehouse's department, then free-text search. Stored on the request
  as `releasePerson: { user_id, name }`.

### B. New Stage 3 — release confirmation (after admin approval)
- After the 2nd-admin approval executes, the bot sends the selected release
  person a targeted card: cart summary + carrier + customer, buttons
  **✅ Goods released** / **⚠️ Problem**.
- On **Goods released**: AuditLog entry (`supply_released`, requestId,
  releaser, ts), requester + admins + carrier get a short "goods released to
  <carrier>" note, request reaches its final state.
- On **Problem**: free-text reason → admins notified (same pattern as the
  dispatch-decline reason flow).
- Inventory accounting stays exactly where it is today (admin-approval time);
  Stage 3 records physical custody, it does not move stock again.
- New callback namespace: `srl:` (release) — free per the prefix registry.

## Decisions the owner must lock

| # | Question | Recommendation |
|---|----------|----------------|
| 1 | Keep Stage 1 (Dispatch-department confirm) as-is, or send it only to the selected release person? | **Keep Stage 1 as-is** — dept still plans/validates; release is a separate physical act. Fewer surprises. |
| 2 | Should the requester be allowed to skip the release picker (legacy behaviour)? | **No skip** once the warehouse has at least one user; skip allowed (with admin note) when no warehouse user exists. |
| 3 | Relabel 🧑 salesperson → 🚚 Dispatch person? | **Yes** — matches how the business actually uses the field (Yarima). |
| 4 | Does the release card block anything if ignored? | **No hard block**; it stays pending and APR-1 reminders re-surface it. |
| 5 | Should the admin Stage-2 assignment picker default to the cart's 🚚 dispatch person? | **Yes** — one tap instead of a search, still overridable. |

## Touched files (implementation, after sign-off)

- `src/controllers/telegramController.js` — release-person picker step in the
  srf wizard (surgical: one step + one dispatch block).
- `src/events/approvalEvents.js` — Stage-3 card + `srl:` handler (protected
  file — this spec is the explicit instruction trail).
- `src/services/inventoryService.js` — emit the Stage-3 card post-approval.
- Tests: characterization through the real controller (fake sheets/bot),
  covering picker, card routing, released/problem paths.
- No schema changes: `releasePerson` rides inside `actionJSON` in the
  ApprovalQueue sheet; AuditLog rows use the existing shape.

## Explicitly out of scope

- Auto-expiry of the 41-row pending-approval backlog (separate owner
  decision, raised 14-Jul-2026).
- Any change to WRITE_ACTIONS / ALWAYS_APPROVAL_ACTIONS.
