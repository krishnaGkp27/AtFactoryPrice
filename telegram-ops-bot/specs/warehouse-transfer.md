# Spec: Warehouse → Warehouse Transfer (two-step acceptance)

**Status:** 🚧 Approved to build (TRF-1). Owner decisions captured below.
**Replaces:** the instant `transfer_than` / `transfer_package` / `transfer_batch` actions (one-shot warehouse rewrite).

---

## 1. Goal

Move bales between warehouses (e.g. **Lagos → Kano**) as a tracked, multi-party
operation instead of an instant rewrite:

1. **Admin requests** the transfer (which bales: design + shade + quantity, or
   specific bale numbers; from warehouse → to warehouse) and **picks the source
   dispatcher and the destination receiver**.
2. **Source dispatcher** (e.g. Abdul @ Lagos) **Accepts & dispatches**.
3. **Destination receiver** (Kano) **Confirms receipt** after checking the goods
   against the supplied details — only then are the bales fully "live" at Kano.

The admin has full visibility of every transfer and its stage throughout.

## 2. Owner decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| Routing | Who accepts at source / confirms at destination | **Admin picks each person** when creating the transfer |
| Visibility / lock | In-transit bale behaviour at destination | **Visible at Kano the whole time (tagged), NOT sellable until receipt confirmed** |
| Existing transfer | Relationship to the instant transfer | **Replace it entirely** with the staged flow |
| Selection | How bales are chosen | **Both** — design + shade + quantity (auto-pick), *or* specific bale numbers |

## 3. State machine

A transfer is a row in a new **`Transfers`** sheet, moving through:

```
                ┌─ source declines ──────────────► CANCELLED  (bales → back to source, available)
requested ──────┤
   │            └─ source accepts ─► in_transit ──┬─ dest confirms ─► RECEIVED  (bales → available @ dest)
   │ (bales already tagged in_transit @ dest)     └─ dest rejects ──► DECLINED  (bales → back to source, available)
```

**Inventory effects (no column reorder — only new Status value + the existing
`warehouse` field is rewritten):**

| Transfer event | Bale `status` | Bale `warehouse` |
|----------------|---------------|------------------|
| **requested** (admin submits) | `available` → **`in_transit`** | source → **destination** |
| **source accepts** (dispatch) | `in_transit` (unchanged) | destination (unchanged) |
| **dest confirms** (receipt) | `in_transit` → **`available`** | destination (unchanged) |
| source declines / dest rejects | `in_transit` → **`available`** | destination → **source** (revert) |

The selected bale identifiers (packageNos / bale UIDs) are stored on the transfer
row, so we flip exactly those rows — **no new Inventory column needed.**

## 4. Visibility & sellability rules (the key behaviour)

- **Sellable / supply-able everywhere = `status === 'available'` only.** In-transit
  bales are excluded from Check Stock totals, the Supply flow, and Sell — so a bale
  that's mid-transfer can never be committed to a sale until the destination
  confirms it. (Existing code already filters on `available`, so this is automatic.)
- **Destination (Kano) display:** Check Stock / My Products for the destination
  warehouse **also lists in-transit bales**, under a clearly separated
  **"🚚 Incoming / in transit — N bales (Transfer TR-xxxx)"** section, so the Kano
  team can see and pre-market the design and cross-check details at any time. They
  are visible *the whole time*, from request until confirmed — never hidden.
- **Source (Lagos) display:** in-transit bales are gone (their warehouse is now the
  destination) — they've left.

## 5. Roles & routing

- **Initiator:** admin (creates the transfer; picks people).
- **Source dispatcher:** a user the admin selects (filtered to those assigned to the
  source warehouse via `Users.warehouses`, else any active employee/manager).
- **Destination receiver:** a user the admin selects (filtered to the destination
  warehouse). Receives the confirm card on (physical) arrival.
- Admin is notified at every stage transition.

## 6. Data model

### New sheet: `Transfers`
| Col | Field | Notes |
|-----|-------|-------|
| A | transfer_id | `TR-<short>` |
| B | from_warehouse | source |
| C | to_warehouse | destination |
| D | items_json | `[{design, shade, bales:[packageNo…], qty}]` |
| E | status | `requested\|in_transit\|received\|declined\|cancelled` |
| F | requested_by | admin user_id |
| G | requested_at | ISO |
| H | source_person | user_id who accepts/dispatches |
| I | dispatched_at | ISO (set on source accept) |
| J | dest_person | user_id who confirms |
| K | received_at | ISO (set on dest confirm) |
| L | note | decline/reject reason, discrepancies |
| M | created_by_name / audit | display helper |

History also lands in `AuditLog` (`transfer.requested|dispatched|received|declined`).

## 7. Callback namespace & flow

- Admin create wizard (`trf:*`): source wh → selection mode → design/shade/qty (or bale numbers) → destination wh → source person → dest person → confirm → submit.
- Source accept/decline: `xfer:acc:<id>` / `xfer:dec:<id>`.
- Dest confirm/reject: `xfer:rcv:<id>` / `xfer:rej:<id>`.
- Admin dashboard activity `transfers` → grouped **⏳ Awaiting dispatch / 🚚 In transit / ✅ Received / ❌ Declined**.

## 8. Module plan (tested, staged)

1. **`transfersRepository.js`** — Transfers sheet CRUD; **schemaMapper** bootstrap entry.
2. **inventoryRepository** — `setStatusForBales(ids, status, warehouse)` (the in_transit/confirm/revert transitions) keyed by packageNo/bale UID.
3. **`transferService.js`** — pure state machine + transitions (validate stage, apply inventory effects via injected repos); item selection (design+shade+qty → bale list).
4. **`transferFlow.js`** — admin create wizard + accept/confirm callbacks (anchored card, mdEscape, plain-text fallback — same conventions as userAddFlow/userManageFlow).
5. **Destination display** — include in_transit (tagged) in destination Check Stock / My Products.
6. **Admin dashboard** — `transfers` activity listing.
7. **Replace instant transfer** — remove `transfer_*` from intent enum, `WRITE_ACTIONS`, `executeApprovedAction`, and the Move-Stock activities; point Move Stock at the new staged flow.

Each stage ships with unit/characterization tests; suite + lint + smoke green before merge.

## 9. Scope flags (require sign-off — granted)
- New status value `in_transit` (no column reorder).
- New `Transfers` sheet (schema add).
- Edits to `risk/evaluate.js` (drop instant transfer actions) and approval/inventory routing.
