# Spec: DBP-1.5 — Than/Bale Allocation Engine + Warehouse-Driven Selling Unit

**Status:** 📋 Planned — design signed off in the design conversation, no code yet.
**Covers:** commit DBP-1.5 (single commit). Layers on top of DBP-1 (`dispatch-bale-picker.md`).
**Priority:** rides immediately with / after DBP-1 in the forward roadmap.
**Parent:** `ROADMAP.md` §4.10 (DBP family).
**Touches:** supply-request sales step, dispatch picklist (DBP-1), trace.
**Reuses:** `inventoryRepository` (per-than rows), `inventoryService.getPackageSummary`, `bundleSaleFlow` (Kano than mechanic), DBP-1 `_dispatch.*` picklist, `ProductTypes` labels, `approvalQueueRepository`, `sessionStore`.
**New module:** `src/services/baleAllocationService.js` — pure, offline-testable.
**New dependency:** none.

---

## §0 Two distinct concepts (do not conflate)

This spec now covers **two separate things** that share the design→shade→bale visual language but are otherwise independent:

| | **Concept A — Admin Warehouse Audit Picker** | **Concept B — Allocation engine + dispatch** |
|---|---|---|
| **Build priority** | 🥇 **FIRST** (owner's explicit request) | after A |
| **Who** | **Admin only** (warehouse self-audit) | dispatcher/operator, post supply-confirmation |
| **Trigger** | Admin browses stock at will — **not tied to any request** | Only after a `supply_request` is approved |
| **Engine?** | **No.** Pure browse/inspect; no modulo, no LIFO, no allocation | Yes — modulo + LIFO + carry-first (§5) |
| **Writes?** | None (read/inspect; optional audit marks) | `markThanSold` per than at admin release |
| **Section** | **§9A** (UI) | §5, §6, §9 |

Concept A is the tappable bale/than drill-down the owner uses to **audit the warehouse himself**. Everything about the allocation engine, supply confirmation, and dispatch (Concept B) is a *different feature* that happens later in the pipeline. Keeping them separate avoids re-introducing the feature-spilling the owner warned about.

---

## §1 Goals & non-goals

### Goals
- **Salesperson stays high-level.** They request in the warehouse's selling unit (bale or than) + quantity. They see availability counts, never bale numbers.
- **An internal allocation engine decides "which to carry first."** Deterministic modulo + LIFO rule that guarantees *at most one open bale per design+colour*.
- **Dispatcher gets a pre-filled picklist + per-bale detail cards** (the image-2 view, made actionable) and confirms or swaps.
- **Fully-qualified per-than trace, released to admin** for the final approval.
- **Foundation for future packing styles and a yards level**, made data-driven now.

### Non-goals (this spec)
- **No inventory write before the final admin release.** Decided: `no_lock`. No `reserved`/`dispatched` status, no schema/status change.
- **No partial shipments.** Decided: all-or-nothing; shortage races go through DBP-1 cancel-with-reason.
- **No cross-warehouse fulfilment.** Deferred to DBP-2.
- **No yards-level cutting yet.** Designed-for via the pack profile; not implemented.
- **No change to risk/approval semantics.** `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS`.

---

## §2 Vocabulary & unit model (locked)

```
Bale  = sack (packaging)               sold whole at Lagos
  └─ Than = subunit we sell            "bundle" / "roll" are native synonyms; sold at Kano
        └─ Yards (FUTURE)              cut from a than; finer granularity, foundation only
```

- "Bundle" and "Roll" are **not** separate levels — they are local words for **than**.
- The real selling-unit choice is **Bale vs Than**.

---

## §3 Warehouse-driven selling unit (locked)

The selling unit is decided **by the warehouse**, enforced automatically:

| Warehouse | Selling unit | Sales step asks |
|---|---|---|
| Lagos (and bale-style warehouses) | **Bale** | "How many bales?" |
| Kano office (and than-style warehouses) | **Than** | "How many thans?" |

- Mapping lives in **config/data** (a `warehouse → unit` map, sourced from `Settings` or the pack profile — §4), not hardcoded, so new warehouses are a data row.
- The salesperson cannot override (decided: `warehouse`). Override is a future option, not built.
- MG-1 already pins marketers to their group's warehouse(s); this layers on top — the unit follows whichever warehouse the request is for.

---

## §4 Pack profile (data-driven foundation)

Pack size **P** (thans per bale) and split rules are read from a **pack profile**, an extension of the existing `ProductTypes` abstraction (`container_label`, `subunit_label`, `measure_unit`, `pluralize`). This keeps future packing styles and the yards level as **config, not code**.

Pack profile fields (proposed, append-only — schema decision deferred until implementation):

| Field | Meaning | Today's value (fabric) |
|---|---|---|
| `pack_size` | thans per full bale (P) | derived per bale from than-row count; profile default e.g. 5 |
| `subunit_yards` | nominal yards per than | ~30 |
| `splittable` | may a bale be opened into thans? | yes |
| `yards_cuttable` | may a than be cut into yards? | FUTURE: false now |
| `unit_label` / `subunit_label` | display words | bale / than |

**P resolution rule:** for the modulo engine, P is taken from the pack profile when present; otherwise derived from the actual than count of the bales of that design+colour (bales of the same design+colour are assumed uniform). This makes the engine correct today even before profiles are seeded.

---

## §5 Allocation engine — `baleAllocationService` (the core)

### 5.1 Inputs
`allocate({ design, colour, warehouse, requestedThans N, packSize P, inventoryRows })` → an **allocation plan** (pure function; no I/O, no writes).

### 5.2 Bale state, derived from per-than rows (no schema change)
For each `bale_uid` / `packageNo` of the design+colour in the warehouse:
- **homogeneity:** `single` if every than row shares one design+shade, else `poly`. (Answer: *both* kinds exist.)
- **intact** if all thans `available`; **open** if some already gone.
- **age / order:** by `addedAt` (used for LIFO front ordering).
- **loose thans:** the `available` thans of the target colour in that bale.

### 5.3 The rule (modulo + LIFO + one-open invariant)
```
wholeBales = floor(N / P)
remainder  = N mod P

1. Serve `remainder` thans FIRST from the already-OPEN bale of design+colour
   (drains broken stock; if its loose thans run out, continue from the next source).
   • Poly-colour bales contribute ONLY loose thans here — never a "whole bale".
2. Serve `wholeBales` from SINGLE-colour INTACT bales, taken FRONT-first (LIFO = last-in).
3. If a remainder is still needed and NO open bale exists → open a fresh SINGLE-colour
   bale from the FRONT; take the remainder; the rest becomes the new (single) open bale.
```
**Invariant:** at most **one open bale per design+colour** at any time.

### 5.4 Composition handling (`both`)
- **Single-colour bales:** eligible for whole-bale allocation (step 2) and as a loose-than source.
- **Poly-colour bales:** never allocated whole for one colour; their available thans of the target colour are a loose-than source for the remainder (step 1) only.
- At a **Bale-selling warehouse (Lagos)** requests are whole bales (N is a bale count → expressed as `N×P` thans, remainder 0); poly bales there, if any, are than-only and excluded from whole-bale picks.
- At a **Than-selling warehouse (Kano)** the full modulo path applies.

### 5.5 Worked examples (P = 5)
- **N = 7 thans**, stock = open bale `6205` (2 loose) + closed `6210/6215/6220` (front→back):
  `whole=1, rem=2` → 2 from `6205` (now empty, none open) + 1 closed from front `6220`. **0 open after.**
- **N = 2 thans**, open bale has 3 loose → take 2 from open bale; 1 still loose; **still 1 open.**
- **N = 3 bales** at Lagos → 3 closed single-colour bales front-first; any open bale untouched.
- **N = 12 thans**, no open bale → `whole=2, rem=2` → 2 closed bales front-first + open a fresh front bale, take 2, rest (3) becomes the new open bale.

### 5.6 Output (allocation plan, consumed by DBP-1 picklist)
```jsonc
{
  "lines": [{
    "design": "9006", "colour": "6", "warehouse": "Kano office",
    "requestedThans": 7, "packSize": 5,
    "wholeBales": [{ "packageNo": "6220", "thans": [1,2,3,4,5], "source": "closed-front" }],
    "looseThans": [{ "packageNo": "6205", "thans": [4,5], "source": "open-bale" }],
    "opensNewBale": false,
    "deviationFromFifo": true        // LIFO chosen over oldest-first (see §12)
  }],
  "ok": true, "shortfall": 0
}
```

---

## §6 End-to-end flow (layered on DBP-1)

```
SALESPERSON  design → shade → [unit fixed by warehouse] → quantity
             availability counts only, NO bale numbers → supply_request (intimation, dual-admin)
ADMIN        approves the request (existing gate, unchanged)
ENGINE       baleAllocationService.allocate(...) → pre-fills DBP-1 _dispatch.picks at THAN level
DISPATCHER   DBP-1 picklist arrives PRE-SELECTED; per-bale image-2 detail cards;
             confirm as-is, or swap a bale/than (deviation + reason logged) → photo proof
ADMIN        releases → markThanSold per than + Transactions row per than (RequestID)
TRACE        each than: requestId · allocatedAt · dispatchedBy · releasedBy
```

Deltas vs DBP-1: (a) sales step gains the warehouse-driven unit + quantity; (b) dispatcher picklist is **pre-filled by the engine** instead of blank; (c) picks are **than-level** (`packageNo → [thanNo]`) not whole-bale-only; (d) release commits via `markThanSold` per than.

---

## §7 Data model & trace

- **No new status, no lock** (decided `no_lock`): inventory mutates only on the final admin release, exactly as DBP-1.
- **`_dispatch.picks` becomes than-level:** `{ "<lineIdx>": { "<packageNo>": [thanNo, …] } }` (DBP-1 had `<lineIdx> → [packageNo]`). Backward-compatible: an array value = whole-bale (Lagos) shorthand.
- **`Transactions.RequestID`** (DBP-1's only schema change) is reused; for than-level sales one row per than carries the `RequestID` → full bale+than trace, no new sheet.
- **Allocation provenance** (`source: open-bale | closed-front | opened-fresh`, `deviationFromFifo`, swap reason) stored in `_dispatch` for the admin's release view.

---

## §8 All cases

| Group | Case | Behaviour |
|---|---|---|
| Unit | Bale order (Lagos) | whole single-colour bales, front-first |
| Unit | Than order (Kano) | full modulo path |
| Unit | Mixed cart | each design/shade line allocated independently |
| Unit | Yards (future) | designed-for via pack profile; not built |
| Alloc | N mod P = 0 | whole bales only |
| Alloc | N < P | remainder only, from open bale (or open fresh front) |
| Alloc | whole + remainder | bales front-first + remainder from open bale |
| Alloc | remainder drains open bale exactly | open bale closes; none open after |
| Alloc | remainder > open bale loose | take open's loose, then open fresh front for rest |
| Alloc | no open bale | open fresh single-colour bale from front |
| Alloc | poly-colour bale | than-only source for remainder; never whole |
| Stock | exact | full plan |
| Stock | insufficient | blocked at sales step (availability shown) |
| Stock | race after approval | engine re-allocates next eligible; dispatcher notified |
| Stock | shortfall at dispatch | all-or-nothing → DBP-1 cancel-with-reason |
| Dispatch | picks match | confirm as-is |
| Dispatch | bale missing/damaged | swap → next eligible; deviation + reason logged |
| Dispatch | FIFO override | allowed; logged |
| Trace | release | markThanSold per than + Transactions row per than (RequestID) |
| Trace | cancel/reject | nothing to release (no_lock); picks discarded per DBP-1 |
| Trace | opening a bale | intact→open; leftover thans become loose stock |
| Trace | admin release view | full per-than allocation + provenance shown before release |

---

## §9 Dispatcher UI deltas (Concept B — on DBP-1 §4)

- Picklist arrives with engine picks **pre-checked** (`✅`) instead of blank `⬜`.
- A **per-bale detail card** mirrors the image-2 `getPackageSummary` view (bale no, bin, indent, design/shade, price if permitted, than list 🟢/🔴, available/sold) so the dispatcher knows *which bale to physically find and which thans to pull*.
- **Swap:** unchecking an engine pick offers the next eligible bale/than from the same plan; a reason prompt logs the deviation.
- Multi-warehouse grouping + PDF proof + cancel/resume: unchanged from DBP-1.

---

## §9A Admin Warehouse Audit Picker (Concept A — FIRST priority)

**Audience:** admin only (`auth.isAdmin`). **Not** tied to any supply request; **no** allocation engine; **no** inventory writes (browse/inspect, with optional audit marks — §9A.6). Reuses the existing design→shade picker look (the owner's screenshots) and the `getPackageSummary` card (image 2), made tappable.

### 9A.1 Entry
Admin-only menu tile (e.g. `🔍 Warehouse Audit`) → warehouse picker (single chip auto-selected if only one) → design picker → **shade picker (identical to the existing supply look)**.

### 9A.2 Shade → bale list
Tapping a shade opens the bale list, **front/LIFO first**, open bale flagged. **If the shade has exactly one bale, skip this list and open §9A.3 directly** (decided).
```
🧵 9006 · 🟣 Purple (colour 6) — Kano office
Available: 7 thans · 210 yds across 3 bales

[ 📦 Bale 6215 · 5/5 · 150y · 🟢 front ▶ ]
[ 📦 Bale 6210 · 5/5 · 150y · 🟢 ▶ ]
[ 📦 Bale 6205 · 2/5 · 60y · 🟠 open ▶ ]

[ ⬅ Back to shades ]   [ ❌ Close ]
```

### 9A.3 Bale detail — tappable thans (interactive image-2)
```
📦 Bale 6205 — 9006 · 🟣 Purple (6)
Indent: CV SIRO · Kano office · 🟠 open
Price: ₦3,416/yard

Tap thans to inspect/mark:
[ ✅ #1 30y ] [ ✅ #2 30y ] [ 🔴 #3 ]
[ 🔴 #4 ]    [ 🔴 #5 ]

🟢 Available: 2 thans · 60y   🔴 Sold: 3 thans · 90y
[ ⬅ Back to bales ]   [ ❌ Close ]
```
- `✅` available · `🔴` sold (untappable). Single-bale shades open here directly.

### 9A.4 Button & callback rules
| Element | Label | Callback |
|---|---|---|
| Bale row | `📦 Bale N · a/t · Yy · status ▶/▼` | `wai:bale:<wh>:<design>:<shade>:<pkg>` |
| Than chip | `✅/🔴 #K Yy` | `wai:than:<pkg>:<K>` |
| Back / Close | `⬅ Back` / `❌ Close` | `wai:back` / `wai:close` |

### 9A.5 Edge states
- **Poly-colour bale:** only the target colour's thans render; no whole-bale concept here (audit is per-than).
- **All thans sold:** bale row greys out, untappable.
- **No stock for a shade:** shade hidden at the picker (same as today).

### 9A.6 Audit semantics (locked)
Tapping a than **toggles a physical-presence mark** (`✔ present` / `✖ missing`), held in session only. A **reconciliation summary** (system count vs admin-verified present/missing) is shown on demand / at close. **No inventory writes** in this concept.

---

## §10 Risk / approval (unchanged)
- `supply_request` stays in `ALWAYS_APPROVAL_ACTIONS` (`src/risk/evaluate.js`). No change.
- The single admin release at the end is the policy gate (DBP-1 Stage E).
- No new action enum value.

---

## §11 Implementation plan

### 11.0 Build order
1. **Concept A — Admin Warehouse Audit Picker (§9A): FIRST.** Self-contained, admin-only, read/inspect, no engine, no writes. Lowest risk, highest owner value now.
2. **Concept B — Allocation engine + dispatch (§5/§6/§9):** after A, layered on DBP-1.

#### Concept A files (first commit)
| File | Change | Risk |
|---|---|---|
| `src/flows/warehouseAuditFlow.js` | **NEW** — admin-only flow: warehouse → design → shade → bale list (skip if 1) → tappable than card. `wai:*` callbacks. Reuses `inventoryService.getPackageSummary` + existing picker rendering. | Low — new isolated flow. |
| `src/repositories/inventoryRepository.js` | Read-only helper: group available thans by `bale_uid` with state (intact/open/front order). | Low — additive. |
| activity registry / menu | Add admin-only `🔍 Warehouse Audit` entry point. | Low — additive. |
| `src/config/index.js` | `WAREHOUSE_AUDIT_ENABLED` flag. | Low. |
| `scripts/smoke.js` | Audit-flow offline assertions (render states, single-bale skip, sold-than untappable). | Low — additive. |

### 11.1 Concept B files
| File | Change | Risk |
|---|---|---|
| `src/services/baleAllocationService.js` | **NEW** — pure `allocate()` + bale-state derivation (homogeneity/intact/open/loose) + modulo/LIFO. Offline-testable. | Low — isolated, no I/O. |
| `src/repositories/inventoryRepository.js` | Add read-only helper to group available than rows by `bale_uid` with homogeneity + age (compose from existing `getAll`/`groupByBaleAndShade`). | Low — additive. |
| sales step (supply-request flow) | Insert warehouse-driven unit + quantity capture; show availability counts; **no bale numbers**. | Medium — flow edit; behind flag. |
| DBP-1 dispatch picklist | Pre-fill `_dispatch.picks` at than-level from the plan; render detail cards; swap logging. | Medium — extends DBP-1 (which is itself unbuilt). |
| `ProductTypes` / pack-profile config | Add pack-profile fields + `warehouse→unit` map (append-only; schema decision at impl time, owner approval). | Low — append-only. |
| `src/config/index.js` | `THAN_ALLOCATION_ENGINE_ENABLED` flag (default per launch). | Low. |
| `scripts/smoke.js` | New offline assertions (§11.2). | Low — additive. |
| `specs/dbp-1.5-than-bale-allocation.md` | This file. | — |
| `ROADMAP.md` | Add DBP-1.5 entry under §4.10. | Low — docs. |

> Per `CLAUDE.md`: any `ProductTypes`/config schema change, any new column, and any edit to `telegramController.js`, `evaluate.js`, or `approvalEvents.js` requires explicit owner approval at implementation time. This spec assumes the engine + sales-step edits happen in flow modules; controller touches stay surgical and pre-approved.

### 11.2 Smoke checks (offline, ~12)
| # | Assertion |
|---|---|
| A1 | `floor(N/P)` / `N mod P` split correct for N across 0..3P |
| A2 | remainder served from open bale before any closed bale |
| A3 | whole bales taken front-first (LIFO by `addedAt`) |
| A4 | no open bale → opens a fresh single-colour bale from front; rest becomes new open bale |
| A5 | invariant: plan never leaves >1 open bale per design+colour |
| A6 | poly-colour bale never appears in `wholeBales`; only as loose-than source |
| A7 | single-colour intact bale eligible for whole-bale pick |
| A8 | Lagos warehouse → unit=bale; Kano → unit=than (warehouse map) |
| A9 | shortfall (N > available) → `ok:false`, `shortfall>0`, no partial plan |
| A10 | P resolved from pack profile when present, else derived from than count |
| A11 | plan output shape matches DBP-1 than-level `_dispatch.picks` |
| A12 | `deviationFromFifo` flagged true under LIFO ordering |

### 11.3 Commit plan
```
feat(dispatch): DBP-1.5 than/bale allocation engine + warehouse-driven selling unit

Implements specs/dbp-1.5-than-bale-allocation.md (layers on DBP-1).
- New baleAllocationService: modulo + LIFO, one-open-bale invariant, single/poly aware.
- Warehouse-driven unit (Lagos=bale, Kano=than); pack profile makes P + future styles data-driven.
- Pre-fills DBP-1 picklist at than-level; per-bale detail cards; swap logging.
- No inventory write before release; all-or-nothing; risk policy unchanged.
- N new offline smoke checks; harness green.
```
Branch: `feat/than-bale-allocation`.

---

## §12 Locked decisions log
| # | Decision | Choice |
|---|---|---|
| 0 | Two concepts | Admin Audit Picker (Concept A, FIRST) is separate from the allocation engine/dispatch (Concept B) |
| 0a | Audit picker audience | **Admin only**, for self warehouse audit; not tied to any request; no engine; no writes |
| 0b | Single-bale shade | Skip the bale list, open the tappable than card directly |
| 1 | Vocabulary | Bale = sack; Than = subunit (bundle/roll = than); yards = future |
| 2 | Selling unit | Warehouse-driven (Lagos=bale, Kano=than), enforced |
| 3 | Allocation mode | Engine pre-selects; dispatcher confirms/swaps |
| 4 | Carry-first order | LIFO (front/last-in) for whole bales |
| 5 | Remainder source | Already-open bale first (modulo); minimise opens |
| 6 | No open bale | Open a fresh bale from the FRONT |
| 7 | One-open invariant | ≤1 open bale per design+colour |
| 8 | Reservation | `no_lock` — no inventory write before admin release |
| 9 | Shortage | All-or-nothing (DBP-1 cancel-with-reason) |
| 10 | Bale composition | Both single- and poly-colour exist; poly = than-only |
| 11 | Pack size P | Data-driven pack profile; fallback derive from than count |
| 12 | Foundation | Pack profile carries future packing styles + yards level |
| 13 | Trace | Per-than, via DBP-1 `Transactions.RequestID`; no new sheet |
| 14 | Risk policy | Unchanged; `supply_request` stays in ALWAYS_APPROVAL_ACTIONS |

---

## §13 Out of scope (future DBP-N)
- **Yards level:** cutting a than into yards; pack-profile `yards_cuttable` flips on.
- **Cross-warehouse fulfilment** (DBP-2): pull shortfall from another warehouse.
- **Poly-colour whole-bale sale** as a unit (not a current commercial need).
- **Per-request unit override** (warehouse default + manual switch).
- **Smarter carry-first** (LIFO + age guard) if dead stock at the back becomes an issue.

---

## §14 Open question carried forward
- **LIFO vs dead stock:** front-first (LIFO) was chosen for physical ease, but it conflicts with `bundleSaleFlow`/DBP-1 "clear oldest first." Flagged decision #4; revisit with an optional age-guard (§13) if old bales stagnate at the back.

*Spec authored Jun 2026. Decisions captured from the design conversation. Implementation pending owner go-ahead.*
