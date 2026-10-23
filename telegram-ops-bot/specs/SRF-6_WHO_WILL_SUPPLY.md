# SRF-6 — "Who will supply it?" (the requester names the supplier; admins see it)

**Status:** SHIPPED 23-Oct-2026 (owner: "Go as per your recommendation"). Live check in §5.
**Owner's words (21-Oct-2026, on R-0735):** *"there is a supply request raised by Ajeet Kumar,
but to whom it is assigned is not visible from this place. Can you make an arrangement where he
needs to select the exact person to whom he has to assign the task, and this is also visible
only to the admin groups?"*

## 1. The chain today (unchanged in shape)

1. Requester raises the request (store → … → who sold it → **who will supply it** → payment → date → document → confirm).
2. `dispatch_review` — Dispatch members get the compact card (Show details · Confirm · Reject). Skipped when there are none.
3. `admin_review` — admins get the card (inbox + DM + hourly reminder) with ✅ Approve / ❌ Reject.
4. `dispatch_acceptance` — the assigned person gets ✅ Accept / ❌ Decline in their own chat; Accept = row approved, stage `completed`; Decline = `admin_repick`.

A supply request moves no stock at any stage (intimation only). Before SRF-6 the assignee was
chosen by the ADMIN after Approve ("Assign to a warehouse boy"), so the admin card could not
show one, and it printed no stage either (STS-1 gap G5).

## 2. Rulings (R1–R4, 23-Oct-2026)

| # | Ruling |
|---|---|
| R1 | The step is mandatory whenever at least one eligible person exists; `🛂 Let admin choose` appears ONLY when the list is empty. |
| R2 | The Dispatch-review card (non-admins) is unchanged and does NOT show the chosen name. |
| R3 | Eligibility = the admin picker's rule: active, in Dispatch / Warehouse / Logistics, attached to the store (Users column I). `📋 See all` widens to every dispatch person. |
| R4 | The admin card gains a waiting line in the transfer cards' grammar — closes G5 for supply requests. |

## 3. Screens

**Requester, after "Who sold it?"**
```
🚚 Who will supply it? · 🏭 IDUMOTA
Pick the person who will prepare and hand over the goods.
[🧑 Musa] [🧑 Abdul]
[📋 See all (4)]
[⬅️ Back to salesperson]
```
Empty store list → `_No dispatch person is attached to IDUMOTA — an admin will choose._` + `🛂 Let admin choose`.
The confirmation cards and the submitted receipt carry `🚚 Musa` (or `🚚 Admin to choose`).

**Admin card** (inbox · DM · hourly reminder — `approvalCards.buildSupplyRequestCard`)
```
Supply Request · 🏭 IDUMOTA
👤 Ketu madam
🧑 Office
🚚 To be supplied by Musa · requester's choice
💳 Zenith
📅 11-Sep-2026

🧣 44200 · Cashmere
 • BLACK · 11B
Σ 11B

🛂 Waiting on an admin to approve · confirmed by Abdul 2d ago
[✅ Approve] [❌ Reject]
[✎ Assign someone else]
```
Waiting line by stage: `⏳ Waiting on Dispatch to confirm` · `🛂 Waiting on an admin to approve · confirmed by X Nd ago` / `· Dispatch stage skipped` · `🚚 Waiting on Musa to accept · assigned Nd ago` · `↩️ Declined by Musa — an admin must assign someone else` · `✅ Accepted by Musa` · `❌ Rejected by X`. The 🚚 line reads `Assigned to X` once assigned, `changed by an admin` after ✎, `Supplier: an admin will choose` when the requester had nobody to pick.

**✅ Approve** with a named supplier: no picker; Musa gets the Accept card (`🔔 Named by the requester and approved by admin…`), the admin reads `✅ … assigned to Musa, as the requester asked`, the requester is told as before. A named person who is no longer active → `⚠️ … no longer an active user — pick someone else` + the picker. Rows without a choice (legacy, "let admin choose") → the picker as before.

**✎ Assign someone else** (admin, inbox, before approval): `🚚 Who should supply R-0735 instead of Musa? · 🏭 IDUMOTA` with the store's eligible people (fallback: every dispatch person, then every active user) and `↩️ Keep Musa`. A pick records `requestedAssignee` with `byAdmin`, audit `supply_supplier_changed`, and the next ✅ Approve assigns that person.

## 4. Build

| Piece | Where |
|---|---|
| Rule + lines | `src/services/supplyAssign.js` — `eligibleFor`, `dispatchStaff`, `chipLabel`, `supplierLine`, `waitingLine` |
| Flow step | `telegramController` — `showSupplySupplierPicker`, `srf_su:<id>|__more__|__admin__`, `srf_back:supplier`, the 🚚 line on both confirm cards and the receipt, `requestedAssignee` on the row, the admin raise-summary line |
| Approve | `approvalEvents` — Approve honours `requestedAssignee` via `assignSupply` (the old `handleSupplyAssign` body, shared); `showWarehouseBoyPicker` now uses `eligibleFor`; `handleSupplyReassign` (`srf_rea:` / `srf_reas:`) |
| Card | `approvalCards.buildSupplyRequestCard` — supplier line + waiting line |
| Inbox | `approvalsInboxFlow` — `✎ Assign someone else` on a pending supply request before acceptance |
| Row | `actionJSON.requestedAssignee = { user_id, name, ts, byAdmin? } \| null` — no sheet change |

Tests: `test/unit/services/supplyAssign.test.js`; `test/characterization/supplyAssignee.test.js`
(step → pick → payment · empty store · submit carries the choice, receipt shows it, Dispatch card
does not · admin card lines · Approve assigns without a picker · ✎ override · legacy picker);
`supplyFlow.salespersonChips` / `supplyFlow.paymentVocabulary` re-pinned for the new step.

## 5. Owner live check

1. Users sheet: every dispatch person has a department (Dispatch / Warehouse / Logistics) and the stores they serve in column I — the chips come from there.
2. Raise a supply request at IDUMOTA: after "Who sold it?" the card lists the IDUMOTA dispatch people only; pick one; the confirmation shows `🚚 <name>`.
3. 🛂 Approvals → the request: the 🚚 line and the waiting line are there; tap ✎ Assign someone else → pick → the line reads `changed by an admin`.
4. ✅ Approve: no picker; the chosen person gets the Accept card at once; your reply names them.
5. A request raised from a store with nobody attached shows `🛂 Let admin choose` and still reaches the old picker at approval.

## 6. Still open

The three 11-Sep answers on supply-approver routing (who may tap Approve · keep the Dispatch
stage · Settings cell vs Railway variable). SRF-6 keeps the Dispatch stage as it is.
