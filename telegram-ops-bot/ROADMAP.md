# AtFactoryPrice — Telegram Ops Bot · Roadmap & Design

**Version:** 2.0 · **Last updated:** 11-May-2026
**Consolidates:** former `IMPROVEMENT_PLAN.md` (v1.0) + `ORG_HIERARCHY_DESIGN.md` (v1.0)
**Single source of truth for:** architecture, shipped work, forward roadmap, detailed designs, decisions, open questions.

> **Companion folder:** [`journal/`](journal/) — the *human story* behind these technical decisions. Philosophy, people, business decisions, and chronological session summaries. Where ROADMAP tells you *how*, the journal tells you *why*.

---

## §0 · About this document

### Purpose
One document, six concerns — kept strictly separated:

| Section | Concern | What lives here | What does NOT |
|---|---|---|---|
| §1 | Architecture & ground rules | Module glossary, sheets contract, invariants | Roadmap, designs |
| §2 | History | What's been shipped, with commit/PR refs | Speculation about future |
| §3 | Active subsystems | Reference docs for live features | Tactical to-dos |
| §4 | Roadmap | Phased plan with commit-level granularity | Implementation detail |
| §5 | Detailed designs | Per-feature data models, state machines, UI specs | Status tracking |
| §6 | Cross-cutting concerns | Patterns reused across features | Feature-specific design |
| §7 | Decision log | Chronological "we decided X because Y" | Open questions |
| §8 | Open questions | Per phase, what we still need to decide | Closed decisions |

When in doubt about *where* something belongs, ask: is this a status (§2), a reference (§3), a future plan (§4), a design (§5), a pattern (§6), a decision (§7), or a question (§8)?

### Audience
- Owner / business sponsor (priority calls, vision validation)
- Cursor IDE sessions (implementation reference, no need to re-explore the codebase)
- Future contributors (onboarding without re-asking decisions)

### Status legend
- ✅ **Done** — shipped, in production
- 🚧 **In Progress** — actively being built
- 📋 **Planned** — designed, queued for build
- 💭 **Discuss** — needs owner input before scoping
- ⏸ **Deferred** — acknowledged, not scheduled yet
- 🗄 **Archived** — superseded or no longer relevant

---

## §1 · Architecture & ground rules

### 1.1 Module glossary

| Path | Role |
|------|------|
| `server.js` | Express webhook entry + scheduler boot |
| `src/config/index.js` | Env-var parsing (telegram, openai, sheets, access, drive, currency, financeIds) |
| `src/middlewares/auth.js` | Env-var allow-list (admin/employee/finance) |
| `src/middlewares/roleCheck.js` | Sheet-backed role lookup, env-var fallback |
| `src/repositories/sheetsClient.js` | **Only** file that talks to googleapis |
| `src/repositories/*Repository.js` | One module per sheet — parse rows, expose CRUD |
| `src/repositories/driveClient.js` | Google Drive uploads |
| `src/services/inventoryService.js` | Sale / return / transfer / price-update business logic |
| `src/services/queryEngine.js` | Tier-1 predefined reports + Tier-2 OpenAI analyst |
| `src/services/accountingService.js`, `stockLedgerService.js`, `auditService.js` | Ledgers + audit append |
| `src/services/crmService.js`, `balanceService.js` | Customer ops |
| `src/services/schemaMapper.js` | Sheet bootstrap (auto-creates missing sheets/columns at boot) |
| `src/services/activityRegistry.js` | Activity types / labels |
| `src/services/designAssetsService.js` | Design photo overlay + Drive storage |
| `src/controllers/telegramController.js` | Router for messages & callbacks |
| `src/controllers/catalogFlowController.js` | Physical-catalog flows |
| `src/events/erpEventBus.js`, `approvalEvents.js` | Approval workflows + multi-stage supply request |
| `src/risk/evaluate.js` | Action policy: who-needs-what-approval |
| `src/ai/intentParser.js` | OpenAI intent extraction (system prompt is the source of truth for action enum) |
| `src/ai/colorDetector.js` | Shade detection from images |
| `src/ai/analytics.js` | Aggregations for reports |
| `src/flows/taskFlow.js` | **Task UI** — assign picker, propose/accept/incentive cards, views |
| `src/flows/taskStateMachine.js` | **Task engine** — pure transition logic, no Telegram side-effects |
| `src/org/deptGraph.js` | Department tree helpers (parent, descendants, assignable users) |
| `src/utils/sessionStore.js` | In-memory per-user flow state, 30-min orphan hint |
| `src/utils/idGenerator.js`, `dates.js`, `formatDate.js`, `logger.js` | Utilities |

### 1.2 Sheets contract & discipline

**Hard rules:**
- Sheet schema is sacred — do not rename columns or sheets.
- Adding columns / sheets is OK only via `schemaMapper.js` so existing deployments auto-migrate on boot.
- Every repository module is the sole owner of its sheet — no direct `sheetsClient` calls from controllers.

**Sheets and their owners:**

| Sheet | Owner module | Purpose |
|---|---|---|
| Users, Departments | `usersRepository`, `departmentsRepository` | Org membership + management tree |
| Customers | `customersRepository` | Customer records, balances, credit |
| Inventory, Transactions, Returns | `inventoryRepository` etc. | Stock + sales |
| Tasks, **Incentives**, **TaskEvents** | `tasksRepository`, `incentivesRepository`, `taskEventsRepository` | Task workflow (see §3.1, §3.2) |
| ApprovalQueue | `approvalQueueRepository` | Multi-stage approvals |
| Settings, BotAuditLog, WebhookErrors | various | Bot internals |
| **TaskTemplates** (planned) | `taskTemplatesRepository` | Reusable task definitions (§5.2) |
| **UserPreferences** (planned) | `userPrefsRepository` | Adaptive UI state (§5.3) |

### 1.3 Approval semantics (sacred)

- Employee → admin gates and admin → 2nd-admin gates defined in `src/risk/evaluate.js` are NOT changed by feature work.
- Adding new actions requires adding them to `ACTION_POLICY` in `risk/evaluate.js`. The smoke harness fails if any action in the intent-parser enum lacks a policy entry.
- Climbing approvals (described in §3.3) extend, never replace, the existing 2-admin gates.

### 1.4 Privacy & money separation

- **Tasks sheet** has NO money columns. Admin / scrum-master views read only from here.
- **Incentives sheet** holds amounts; gated by `config.access.financeIds`.
- **TaskEvents.meta_json** may contain amounts; only finance-tier reports read this field.
- Customer-side credit/balance details are gated by the customer role itself + finance role.

### 1.5 Coding conventions

- One concern per file. Keep files <600 LOC where possible. `taskFlow.js` is approaching the limit and should split when it crosses 2000 LOC (target: `taskFlow/assign.js`, `taskFlow/negotiate.js`, `taskFlow/views.js`).
- Pure engines (state machines, graph helpers) are Telegram-free and unit-testable offline.
- Every state change in the task domain goes through the state machine — never call `tasksRepository.updateFields` directly for status changes.
- Append-only audit (`TaskEvents`) is the source of truth for performance analysis.

---

## §2 · What's shipped

### 2.1 Phase 1 — Critical / High refactors (legacy TG-1 .. TG-7)

| ID | Topic | Status |
|---|---|---|
| TG-1 | Fix `sessionStore` require path crash in approvalEvents | ⏸ Deferred |
| TG-2 | Validate Telegram webhook secret | ⏸ Deferred |
| TG-3 | Lock down `/api/settings` CORS + add audit | ⏸ Deferred |
| TG-4 | Delete/fix broken `utils/idempotency.js` | ⏸ Deferred |
| TG-5 | Webhook handler hardening (requestId + DLQ) | ⏸ Deferred |
| TG-6 | Reject silent-default `productType` in inventory | ⏸ Deferred |
| **TG-7** | **Document & tighten risk policy + smoke linter** | ✅ **Done** (S4 in `scripts/smoke.js`) |

### 2.2 Phase 2 — Architecture cleanup (legacy TG-8 .. TG-15)

| ID | Topic | Status |
|---|---|---|
| TG-8 | Split `telegramController.js` by domain | ⏸ Deferred |
| TG-9 | Split `approvalEvents.js` | ⏸ Deferred |
| TG-10 | Centralize repeated helpers (`fmtMoney`, `genId`, `editOrSend`) | ⏸ Deferred |
| TG-11 | Standardize repository caching (`_cachedReader.js`) | ⏸ Deferred |
| TG-12 | Replace `console.log` with `pino` | ⏸ Deferred |
| TG-13 | Replace 4 reminder loops with generic scheduler | ⏸ Deferred |
| TG-14 | sessionStore as sole source of truth for in-flow state | ⏸ Deferred |
| TG-15 | Repository-base module (optional polish) | ⏸ Deferred |

### 2.3 Phase 3 — Performance (legacy TG-16 .. TG-21)

| ID | Topic | Status |
|---|---|---|
| TG-16 | Cache OpenAI intent parses (LRU) | ⏸ Deferred |
| TG-17 | Approval queue secondary index | ⏸ Deferred |
| TG-18 | Reuse Drive upload pipeline (no temp files) | ⏸ Deferred |
| **TG-19** | **`npm run smoke` end-to-end script** | ✅ **Done** (76 checks passing) |
| TG-20 | Document `sharp` cold start | ⏸ Deferred |
| TG-21 | Remove `bot` polling option | ⏸ Deferred |

### 2.4 TG-7.5 · Org hierarchy & climbing approvals

| Phase | Topic | Status |
|---|---|---|
| Phase A | Schema (`parent_department`, `manages`) + graph helpers + `npm run check-org` | ✅ Done |
| Phase B | Climb engine for tasks (forward-up, grievance, cross-branch) | ⏸ Deferred — superseded by task negotiation system below for the task slice |
| Phase C | Migrate supply-request to climb model | ⏸ Deferred — wait for finance node in tree |

### 2.5 TG-7.5 Commits 1–3.5 · Negotiated task workflow

| Commit | Hash | Title | Status |
|---|---|---|---|
| 1/4 | `45dc293` | Schema overhaul — Tasks (20 cols), Incentives, TaskEvents | ✅ Done |
| 2/4 | `6bc2628` | Task state machine engine + 12 smoke checks | ✅ Done |
| 2/4 | `c0c1bad` | Employee onboarding script (`scripts/onboard-employee.js`) | ✅ Done |
| 3/4 | `0751c83` | UI rewrite — propose-timeline, incentive, final-ack | ✅ Done |
| 3.5/4 | `0cb8c5d` | Custom hours, calendar picker, incentive before accept, payout queue | ✅ Done |

Detailed designs in §3.1 (engine) and §3.2 (incentives).

### 2.5b Manager visibility + admin observability (2026-05-14)

| Commit | Hash | Title | Status |
|---|---|---|---|
| T1 | `f947c60` | Manager controls — priority-sorted doer view + Re-prioritize + Drop-off | ✅ Done |
| T2 | `91b04bc` | Admin opt-in Activity Feed — per-user notification preferences | ✅ Done |
| T3 | `2455331` | Admin Sales Workflow view — read-only order/customer/ledger lens | ✅ Done |

**What this set delivers:**
- **T1**: `My Tasks` re-sorted by priority → soonest deadline → phase. New `🔝 Re-prioritize` and `🚫 Drop` buttons on every Team Tasks row (manager-only). State-machine additions: `update_priority` (self-transition, any open state) and `drop` (terminal → `dropped`, illegal from `submitted`). Smart doer DMs (silent for normal/low priority, audible for high/critical).
- **T2**: Centralizes broadcast notifications behind `src/services/adminFeed.js`. New `Users.notification_prefs` column (JSON) stores per-admin opt-in/out per event type. Admin hub gets a `⚙️ Notifications` screen for toggling. Defaults preserve today's all-on behavior — admins opt OUT at their pace. Catalog: `task.assigned/completed/dropped/declined/priority`, `order.created/accepted/delivered`, `payout.paid`.
- **T3**: New `📊 Sales Workflow` activity in Admin hub. Read-only grouped view of orders (pending / accepted / recently delivered), joined with customer phone, tier, credit limit, and current ledger balance. Tap-through detail card shows the customer's 3 most recent other orders for pattern-spotting. No new schema — Orders + Customers + LedgerBalanceCache already exist.

Admin override actions (force-accept, reassign, cancel) deliberately deferred — they need an Order state machine first.

### 2.5c Inbound supply loop · P1-P4 (2026-05-14)

| Commit | Hash | Title | Status |
|---|---|---|---|
| P1 | `e954dba` | Inventory composite-key foundation (bale_uid + addedAt + grn_id) | ✅ Done |
| P2 | `b192808` | Goods Receipt Note (GRN) flow — inbound bale intake | ✅ Done |
| P3 | `94ba68e` | Quick Add Customer — admin one-line fast path | ✅ Done |
| P4 | `4ebde00` | Procurement Plan — low-stock alerts + PO drafting + GRN linkage | ✅ Done |

**Why this set:** the system could already *sell* and *transfer* goods,
but had no clean path to *receive* them from a supplier — "add stock"
was a CSV import. P1-P4 closes the inbound loop so every bale entering
a warehouse goes through a single, audited flow.

**What this set delivers:**
- **P1**: `Inventory` gains three columns — `bale_uid` (server-generated
  internal id `BAL-YYYYMMDD-{pkg}-{rand4}`), `addedAt` (ISO timestamp at
  row creation), `grn_id` (FK to `GoodsReceipts`). The printed-on-bale
  `PackageNo` stays as the human identifier and is now allowed to repeat
  across intake dates. `findByPackage(p, { latestOnly })` returns
  newest-first; `findByBaleUid()` resolves the unambiguous internal id.
  Legacy rows get synthetic `BAL-LEGACY-<rowIndex>` lazily on read;
  `backfillLegacyBales()` persists them in one batch when the operator
  is ready.
- **P2**: New `📥 Receive Goods` activity in the Stock hub. Compact 6-step
  flow (warehouse → supplier → design → shade → bales → confirm) with a
  bale-list parser accepting CSV (`5801,5802`), range (`5801-5810`), or
  mixed inputs. Each submit creates a `GoodsReceipts` header, appends
  bales via P1's `appendBale()`, and drops `Stock_Ledger` 'received'
  rows. Admins execute directly; employees route through admin approval.
  Inline ➕ New warehouse triggers a `add_warehouse` action which is in
  `ALWAYS_APPROVAL_ACTIONS` — meaning even an admin requester must get a
  *different* admin to approve (dual-admin gate via the existing
  `requireApproval` exclude-requester pattern). `rename_warehouse` uses
  the same gate.
- **P3**: Admins now see a `⚡ Quick Add` button on the Add Customer
  entry. One-line input (`Name, +234..., Lagos`) writes directly via
  `crmService.addCustomer` with sensible defaults (category=Standard,
  credit=₦0, terms=COD). Non-admin path unchanged. Parser is in a
  reusable util so future flows (and the smoke harness) can share it.
- **P4**: New `📋 Procurement Plan` view in the Admin hub. Surfaces
  low-stock alerts (distinct design/shade with available bales below
  `LOW_STOCK_THRESHOLD` setting — tunable via `/setlowstock N`) and
  open POs. `➕ New Procurement Order` walks through a multi-line PO
  draft (supplier → loop[design → shade → qty] → expected date →
  confirm). Open POs gain a `📥 Receive (PO-x)` button that launches the
  P2 GRN flow with the PO pinned in session; the service handler then
  applies received qty against PO lines and auto-advances the PO status
  (`draft → sent → partially_received → received`). Status transitions
  emit through `adminFeed` (`po.created` / `po.received` default ON,
  `po.partial` default OFF).

**New admin-feed events** (services/adminFeed.js inventory group):
`goods.received`, `warehouse.added`, `warehouse.renamed`, `po.created`,
`po.received`, `po.partial`.

**Smoke coverage:** S10 (P1, 6 checks), S11 (P2, 10 checks), S12 (P3,
8 checks), S13 (P4, 7 checks). Total +31 checks; harness at 119 green.

**Deferred to P5 (OCR add-on):** supplier-invoice photo → auto-fill of
design/shade/bale-list during step 5 of the GRN flow; business-card
photo → auto-fill of Quick Add. Provider-agnostic abstraction stubbed
out so OCR provider choice (Google Vision / Tesseract / OpenAI Vision)
is a one-file change when the operator decides.

### 2.5d Bulk Receive Goods · P2.5 (2026-05-14)

| Commit | Hash | Title | Status |
|---|---|---|---|
| C1 | `cacf8cd` | CSV/XLSX parsers + bulk row validator (pure utils) | ✅ Done |
| C2 | `8547dc4` | `GoodsReceipts.source` + `file_hash` columns for idempotency | ✅ Done |
| C3 | `ec54406` | Bulk Receive flow + dual-admin risk + service handler | ✅ Done |
| C4 | (this set) | Controller wire-up + Abdul-friendly CSV template doc | ✅ Done |

**Why this set:** the interactive 6-step GRN flow (P2) is great for two
or three bales, but when Abdul has a stack of 50 packaging slips after
a delivery, tapping through 6 steps × 50 bales is unworkable. Bulk
Receive lets him assemble the data offline in Excel/Sheets, upload one
file, and have admin sign-off applied to the whole batch in one stroke.

**Locked design (user decisions, 2026-05-14):**
- **Append-only.** Every file row becomes a *new* Inventory bale with
  fresh `bale_uid` + `addedAt`. Existing rows are never mutated,
  reordered, or deleted. Repeated `PackageNo` is allowed (composite-key
  model from P1).
- **CSV + XLSX** in v1. CSV is the canonical format; XLSX is wrapped via
  SheetJS (`xlsx` npm package).
- **Reject the whole file** on any error (missing required column, bad
  warehouse, non-numeric yards). Abdul fixes everything in one pass.
  Single-warehouse + single-supplier per upload — multi-warehouse files
  surface a "split into one file per warehouse" message.
- **PO linkage is optional.** Entry step lets the operator pin an open
  PO; the service handler then routes received qty into
  `procurementOrdersRepo.applyReceived` and `recomputeStatus` advances
  the PO automatically.
- **Local archive** at `data/uploads/{fileHash}.{csv,xlsx}`. Cheap, fast,
  easy to inspect. Moves to Drive in a future release if cloud-audit
  becomes a requirement.
- **Dual-admin gate.** `bulk_receive_goods` is in
  `ALWAYS_APPROVAL_ACTIONS`, so even an admin requester needs a *second*
  admin's approval. Existing `requireApproval` excludes the requester
  from the approver pool.
- **Idempotency.** SHA-256 first-16-hex of the file's raw bytes lives in
  `GoodsReceipts.file_hash`. The flow rejects duplicates pre-archive and
  the service handler re-checks at persist time (race-condition guard
  if two admins approve simultaneously). Same file = same hash =
  rejected with `"Already imported as GRN-…"`.

**What this set delivers:**
- New `📤 Bulk Receive (CSV/XLSX)` activity in the Stock hub. Visible to
  anyone with `receive_goods` permission; routes through dual-admin
  approval regardless.
- `/bulkformat` slash command returns a copy-pasteable CSV template.
- Flow: 1) PO link (optional) → 2) file upload → 3) preview card with
  totals + hash → 4) Submit → 5) approval queue → 6) one GRN written
  with `source='bulk_csv'|'bulk_xlsx'` + `file_hash`, then N Inventory
  rows appended.
- New `GoodsReceipts` columns: `source` (column M), `file_hash` (column
  N). Lazy migration extends existing deployments; legacy 12-col rows
  parse cleanly with `source='manual'`.
- Validator caps file at 500 rows / 5 MB / 32-char PackageNo. Tunable
  via `Settings.BULK_IMPORT_MAX_ROWS` (future — defaults are fine for
  Abdul's expected volumes).

**Smoke coverage (S14):**
- **S14a — parsers/validator** (16 checks): CSV happy path, quoted
  cells, BOM, CRLF, escaped quotes, validator header/row/maxRows
  checks, repeated-PackageNo allowance, fileHash stability, XLSX
  round-trip.
- **S14b — idempotency** (5 checks): 14-col GoodsReceipts parse with
  source + file_hash, legacy 12-col defaults to source='manual',
  getByFileHash hit/miss, append column count.
- **S14c — flow + service** (9 checks): risk policy returns
  approval_required for admins and employees, activity registered in
  stock hub, parseBuffer routes correctly by extension, error formatter
  truncates after 15 rows, **append-only contract** (asserts 0 mutating
  writes to Inventory after a bulk receive), idempotency race-condition
  guard at persist time.

Total +30 checks; harness at 149 green.

**Smoke contract that locks the spec:** S14c.8 instruments
`sheetsClient.updateRange` and `sheetsClient.batchUpdateRanges` and
asserts neither is called on `Inventory` after a bulk receive — only
`appendRows`. That's the machine-enforced version of "address / path /
detail of existing rows shall not be disturbed."

### 2.6 Phase 4 · Scalability (legacy TG-22 .. TG-26)

All 💭 Discuss — never start without an explicit owner decision (see §4.6).

---

## §3 · Active subsystems (reference)

### 3.1 Task state machine

**Engine:** `src/flows/taskStateMachine.js` — pure, offline-testable.
**UI:** `src/flows/taskFlow.js` — every status change routes through the engine.

```
┌────────┐  propose_timeline    ┌────────────────────────┐
│assigned│ ────────────────────▶│ awaiting_timeline_ack  │◀──┐
└───┬────┘                       └──┬──────────┬──────────┘   │
    │ decline                        │ accept   │ set_incentive│
    │                                │ _timeline│ (self-loop)  │
    ▼                                ▼          │              │
┌────────┐                  ┌────────────────┐  └──────────────┘
│declined│                  │awaiting_final  │
└────────┘                  │_ack            │
                            └──┬──────────┬──┘
                  final_ack │   │ renegotiate
                            ▼   │
                       ┌─────────┐
                       │ active  │◀────────reject──────────┐
                       └────┬────┘                          │
                            │ mark_done                     │
                            ▼                               │
                       ┌─────────┐  approve   ┌───────────┐ │
                       │submitted├───────────▶│ completed │ │
                       └──┬──────┘            └───────────┘ │
                          └────────reject─────────────────┐ │
                                                          ▼ ▼
       (cancel allowed from every non-terminal)      (terminals)
```

**Invariants:**
- Every transition writes one row to TaskEvents (audit log).
- Negotiation rounds (counter + renegotiate) hard-capped at 3.
- Money never written to Tasks sheet — only to Incentives sheet.
- Self-transitions (`set_incentive`) are legal and don't change status.

### 3.2 Incentive system

**Storage:** `Incentives` sheet (separate from Tasks). 10 columns including `paid_status` lifecycle: `pending → awaiting_payout → paid` (or `cancelled`).

**Lifecycle:**
1. Assigner taps `Set incentive` during `awaiting_timeline_ack` → Incentives row created, `paid_status=pending`.
2. Assigner accepts timeline → status moves on; Incentives row untouched.
3. Doer final-acks → `doer_confirmed_at` stamped on Incentives row.
4. Assigner approves completion → `paid_status` flips to `awaiting_payout`.
5. Finance marks paid (manual today; UI in commit 4) → `paid_status=paid`, `paid_at`, `paid_amount`.

**Visibility:**
- Task assigner sees their own incentive set; can change while in `awaiting_timeline_ack`.
- Doer sees only their own incentive (on deal card + completion DM).
- Admin / scrum-master views NEVER show money.
- Finance role (`config.access.financeIds`) sees the Incentives sheet via the planned Incentives Report.

### 3.3 Organizational hierarchy & climbing approvals

**Model:** Tree rooted at Admin. Single parent per node. Customers are leaves attached to an owner.

**Encoded in:**
- `Departments.parent_department` (CSV-free; empty = top-level)
- `Users.manages` (CSV of departments this user heads)
- `Users.departments` (CSV of departments this user belongs to)

**Helpers** (`src/org/deptGraph.js`):
- `validateForest(depts)` → returns `{ graph, errors }` (rejects cycles)
- `listAssignableUsers(actor, allUsers, graph)` → who can `actor` assign tasks to
- `canSee(actor, target, resource)` → visibility check
- `lowestCommonAncestorDept(a, b)` → cross-branch routing

**Climbing approvals** (planned, not used by tasks today):
- Forward-up with required comment
- Grievance skips the subject node
- Cross-branch routes to LCA then down
- 24h auto-escalate for Critical (optional v1.1)

**Notification priorities:**

| Level | Push | Sound | Re-ping | Inbox |
|---|---|---|---|---|
| Critical | ✓ | ✓ | every 30 min | ✓ |
| High | ✓ | ✓ | — | ✓ |
| Normal | ✓ | silent | — | ✓ |
| Low | — | — | — | ✓ |

### 3.4 Audit log

`TaskEvents` sheet, append-only. Every task lifecycle event = one row.

Event types currently emitted:
- `assigned`, `doer_proposed_timeline`, `assigner_countered_timeline`, `doer_renegotiated`
- `assigner_set_incentive`, `assigner_accepted_timeline`, `doer_final_ack`
- `doer_marked_done`, `assigner_approved`, `assigner_rejected`
- `doer_declined`, `assigner_cancelled`
- `doer_marked_started_legacy` (back-compat fast-forward for pre-commit-3 tasks)

`meta_json` column stores event-specific payloads (e.g. `{hours, deadline}` for proposals; `{amount, currency}` for set_incentive). Admin Tasks views never read `meta_json`. Finance reports do.

### 3.5 Onboarding

Script: `scripts/onboard-employee.js` (npm alias `onboard`).

Idempotent operations:
- Create or update a Users row
- Ensure a Department exists (with merged `allowed_activities` if updating)
- Optionally set the user's role / access / branch
- `--force` to update existing rows

Used so far for: Abdul Ahmed (`7430648262`) → Sales department → `upload_design_photo`, `browse_catalog`, `search_design_photo`.

---

## §4 · Roadmap (forward-looking)

### 4.1 Commit 4 — Reports 📋 Planned (next)

**Deliverable:**
- **Performance Report** (admin / scrum-master): time-to-propose, time-to-accept, on-time rate per doer/dept. NO money.
- **Incentives Report** (finance only): grouped by `paid_status`; one-tap `✅ Mark paid` for `awaiting_payout` rows.
- **Audit Trail** (admin): per-task timeline view of TaskEvents.

Detailed design: §5.1

### 4.2 Commits 5a, 5b, 6 — Task Templates 📋 Planned

**5a** — `TaskTemplates` sheet + admin "Manage Templates" hub item.
**5b** — "From template" path in Assign Task (skip steps; one-tap deal locking).
**6** — Manager-proposed templates + bot self-learning suggestions (5+ identical in 30 days).

Detailed design: §5.2

### 4.3 Commit 7 — Adaptive UI 📋 Planned

`UserPreferences` sheet drives picker reordering, sensible defaults, "Repeat last" shortcuts.

Detailed design: §5.3

### 4.4 Commits 8–9 — Customer-side deals 💭 Discuss

Customer onboarding on Telegram; order placement with credit-limit auto-approval; ledger view. Reuses templated task infrastructure for fulfillment.

Detailed design: §5.4

### 4.5 Commit 10+ — Conversational AI front-door ⏸ Deferred

LLM-driven slot filling on top of the existing tap UI. Model tier decided at implementation time, not now.

Detailed design: §5.5

### 4.6 Commits 11–14 — Referral graph + Loyalty platform 💭 Discuss

Two-sided affiliate-and-customer-loyalty platform integrating the bot with `atfactoryprice.com`. Scenario C confirmed (workers refer workers, customers refer customers, separate rules per chain).

**Sub-commits:**
- **11** — Referral graph + identity reconciliation across bot and website
- **12** — `LoyaltyLedger` sheet + configurable earning rules
- **13** — Website ↔ bot identity and balance bridge
- **14** — Redemption flow (optional, creates fulfillment tasks via existing template runner)

**Pre-requisites that must happen BEFORE commit 11 starts:**
- Legal / accounting conversation about local rules for referral commissions (Nigeria — the line between legitimate referral and pyramid scheme depends on real product flow, which the business has, but the commission formula must be designed to stay clearly compliant)
- Identity-reconciliation review of `atfactoryprice.com`'s existing user model (email/phone/username) so the bridge in commit 13 is correct from day one
- Loyalty-point governance decisions: expiry policy, transferability, withdrawal-on-departure, accounting liability treatment

Detailed design: §5.6 (placeholder for now; full spec to be written when commits 8-9 are stable)

### 4.7 Admin direct task assignment ✏ ✅ Done

~~Small UI addition to bypass the org-tree filter when admin assigns.~~ During implementation it was discovered admin already bypasses the filter via `isAdmin: true` in `listAssignableUsers`. The release-night work was a **scope badge** instead: assignee picker now shows *"🛡 Admin mode — showing all N active employees"* for admins, *"👥 Manager mode — showing N from your reporting subtree"* otherwise. Shipped in commit `dbea342` alongside Mark Paid UI.

### 4.8 Commits PA-1 through PA-5 — Payment Automation 📋 Planned

**Full spec:** [`specs/payment-automation.md`](specs/payment-automation.md)

**Summary:** Five-commit track that closes the order-to-cash loop. Auto-DM customer after delivery with tier-aware payment details; OCR uploaded receipts to pre-fill admin review (Google Vision default, Tesseract fallback); integrate with Nigerian bank API (Mono default, Okra/Paystack/Flutterwave alternatives) to auto-match incoming transfers; surface the existing customer ledger as a friendly **Wallet** UI with top-up and apply-to-order; deliver premium-tier payment-request experiences for Gold and Platinum customers including a one-tap "Talk to John directly" button.

**Architectural shape:** new `paymentStateMachine.js` (9 states, mirrors task/order state-machine pattern). Reuses `erpEventBus` to listen for `order.delivered` events from Customer Orders. Wallet is a **friendly read** of the existing `LedgerTransactions` sheet — no duplicate ledger, no double-bookkeeping.

**Commit decomposition:**
- **PA-1** — PaymentRequests schema + auto-DM trigger (depends on Customer Orders being deliverable)
- **PA-2** — OCR layer (Google Vision + Tesseract fallback + Nigerian-pattern parser)
- **PA-3** — Bank API integration + matcher (depends on Nigerian fintech provider research)
- **PA-4** — Wallet UI + WalletTransactions schema (customer-facing balance + top-up + apply-to-order)
- **PA-5** — Premium tier templates + nightly tier engine

**Pre-requisites before PA-3 starts:** 2-3 hours of Nigerian fintech provider research (Mono vs Okra vs Paystack vs Flutterwave for bank coverage, pricing, SLA). Owner decision required.

**Key design decisions captured:**
- OCR is admin assistance, NOT proof of payment. Admin always taps approve. `AUTO_APPROVE_HIGH_CONFIDENCE` defaults to `false`.
- Bank statement remains the source of truth; weekly reconciliation report catches drift.
- Wallet reuses `LedgerTransactions` (extended), not a new sheet — one source of truth.
- Tier downgrades happen silently; only upgrades celebrated via DM.
- Each subsystem has its own feature flag for independent rollback.

### 4.9 Deferred items (legacy Phase 4)

| ID | Topic | When to revisit |
|---|---|---|
| TG-22 | `Store` interface + Redis backend | When we go multi-instance |
| TG-23 | Sheets → Firestore migration | When Sheets API quota hurts |
| TG-24 | Webhook queue (Cloud Tasks / BullMQ) | When error rate matters |
| TG-25 | Containerize + CI | Anytime; mechanical |
| TG-26 | ESLint + Prettier | Anytime; format on touch |

---

## §5 · Detailed designs

### 5.1 Reports (commit 4)

**Three surfaces:**

#### Performance Report (admin / scrum-master)
- **Audience:** managers + admin. NO money.
- **Inputs:** TaskEvents joined with Tasks. Compute on read (no precomputed aggregates yet).
- **Metrics per doer:**
  - Median time-to-propose (assigned → propose_timeline)
  - Median time-to-final-ack (accept_timeline → final_ack)
  - On-time completion rate (completed_at ≤ proposed_deadline)
  - Negotiation rounds avg
  - Rework rate (rejected % of submitted)
- **Filters:** date range, department, doer.
- **Surface:** Tasks hub → "📊 Performance".

#### Incentives Report (finance only)
- **Audience:** `config.access.financeIds`.
- **Inputs:** Incentives sheet.
- **Sections:** `awaiting_payout` (with Mark Paid button), `pending`, `paid` (recent), `cancelled`. Subtotals per section + grand totals.
- **Mark Paid flow:** tap → optional `paid_amount` override + notes → Incentives row updated → DM to doer optionally.
- **Surface:** new top-level activity "💰 Payouts" (visible only to finance).

#### Audit Trail (admin)
- Per-task: list every TaskEvents row chronologically. Used for disputes.
- Surface: "View audit" link inside Pending Sign-off cards.

**New files:**
- `src/flows/reportsFlow.js` (UI)
- `src/services/reportsService.js` (data aggregation)
- new admin/finance hub items

### 5.2 Task Templates (commits 5a, 5b, 6)

**Full spec:** [`specs/templates.md`](specs/templates.md)

**Summary:** new `TaskTemplates` sheet (20 cols), three growth paths (admin curated, manager proposed, bot self-learning at 5+ identical/30d), per-template `auto_negotiate` + `requires_doer_ack` knobs to control doer friction. Reuses existing task state machine — no engine changes beyond a 5-line carve-out for synthetic `system_template:*` actors.

**Commit decomposition:**
- **5a** — TaskTemplates schema + admin Manage Templates UI
- **5b** — "From template" picker + templateRunner.js (consumption side)
- **6** — Manager-proposed templates + bot self-suggestions + suppression state

Open questions (8) tracked in spec §8.

### 5.3 Adaptive UI (commit 7)

#### UserPreferences (or `Users.prefs_json` column — TBD at implementation)

```json
{
  "last_assignee_id": "7430648262",
  "last_hours": 4,
  "last_priority": "high",
  "last_track": "incentivized",
  "favorite_template_ids": ["TMPL-002", "TMPL-005"],
  "hours_pick_freq": {"4": 12, "2": 5, "8": 3},
  "priority_pick_freq": {"high": 10, "normal": 8},
  "track_pick_freq": {"salaried": 15, "incentivized": 7},
  "last_updated": "2026-05-11T12:00:00Z"
}
```

#### Where it surfaces

| Picker | Adaptive behavior |
|---|---|
| Hours | Top row = 4 most-used by frequency, descending |
| Priority | Most-used pre-selected with ✓ |
| Track | Most-used pre-selected |
| Assignee | "⭐ Last: Abdul" pinned first; then alphabetical |
| Templates | Favorited templates first |
| My Tasks home | "🔁 Repeat last: 'Wire panel' to Abdul (4h, ₦3k)" if assigner pattern detected within 7d |

**Gating:** no adaptation until ≥3 samples per dimension. Static defaults below that.
**Reset:** admin command `/reset_my_prefs` clears the row.

### 5.4 Customer-side deals (commits 8–9)

**Full spec:** [`specs/customer-orders.md`](specs/customer-orders.md)

**Summary:** customer becomes a third principal type (alongside admin and employee). Telegram-only for now; WhatsApp migration sketched in spec §11. Own state machine (`OrderStateMachine`) since order lifecycle differs from task negotiation. Auto-approval rules pipeline checks customer status, item validity, total caps, credit limit, deposit, and configurable business gates. Auto-approved orders **reuse the task state machine** for the fulfillment side via a templated "Dispatch order #X" task — this is the core architectural reuse from commits 5-6.

**Commit decomposition:**
- **8** — Onboarding + ledger + auto-approval rules engine + admin pending-orders queue
- **9** — Order placement UI (catalog browse + cart + submit) + fulfillment bridge

Spec is **TBR-heavy** (10 open questions, several depending on existing Customers/Sales/Catalog schema). Must read existing repo before commit 8 starts.

### 5.5 Conversational AI front-door (commit 10+)

**Status:** ⏸ Deferred. Design only.

#### Three phases inside this commit
1. **Slot filler** — extract `{assignee, title, priority, track, incentive, hours, deadline}` from free-form text. Confidence per field. Below-threshold field → drops to tap UI for that field only.
2. **Dialog manager** — bot asks clarifying questions and updates slots iteratively.
3. **Cross-actor coordination** — bot relays between assigner and doer with light paraphrasing.

#### Cost containment
- Cheap model (Haiku / GPT-4o-mini) for slot filling
- Mid model only for ambiguity resolution
- LRU cache for repeated phrases
- Hard per-user-per-day budget; falls back to tap UI when exhausted
- Structured outputs (JSON schema) to prevent hallucinations

#### Safety
- Every AI-driven task creation still routes through the state machine → unchanged validation, audit, approval semantics.
- "AI assisted" badge on tasks created via conversation, so audit can distinguish.

### 5.6 Referral graph + Loyalty platform (commits 11–14)

**Status:** 💭 Discuss. High-level shape only; full spec to be written under `specs/referral-loyalty.md` when commits 8-9 (Customer Orders) are stable.

#### Concept (Scenario C confirmed)
**Two separate referral chains** with separate earning rules:

| Chain | Who joins it | Who pays into it | What flows up |
|---|---|---|---|
| Worker chain | Workers / distributors recruited by other workers | Worker output (sales brought in, tasks completed, etc.) | Commission points to direct parent + diminishing share to grandparent and above |
| Customer chain | Customers recruited by other customers | Customer purchases | Loyalty points to direct referrer + smaller share to upline (if any) |

Both chains feed the same **LoyaltyLedger** but with different earning rules. Points are economically equivalent to money (redeemable on `atfactoryprice.com` for goods, software, hardware, discounts).

#### Architectural reuse
- **State machine pattern**: `LoyaltyEventEngine` reuses the same transition + audit shape as TaskStateMachine and OrderStateMachine.
- **Tree pattern**: `deptGraph.js` patterns generalize to referral-tree ancestor walks for multi-level distribution.
- **Privacy pattern**: distributors see their own balance and their downline's earnings, not anyone else's. Same gating model as `financeIds`.
- **Redemption-as-task pattern**: a customer redeeming N points for a computer creates a fulfillment task via the existing template runner (commits 5-6 reuse). Beautiful symmetry.

#### `atfactoryprice.com` integration (both surfaces)
- Storefront: customers browse, buy, see their loyalty balance
- Registration funnel: new distributors and customers sign up there with a referral code, get auto-linked to the parent in the bot's tree
- Identity reconciliation: shared user model across bot (Telegram ID) and website (email/phone) — one user, multiple channels, one balance

#### Non-negotiable design constraints
- Real product flow (fabric sales to real customers) must remain the primary value driver. Referral commissions are secondary. This keeps the structure clearly on the legitimate side of MLM regulations.
- Every loyalty point grant and redemption writes an append-only LoyaltyLedger row with actor, source event, amount, and resulting balance.
- Points are NOT money in any legal/accounting sense, but ARE liability on the books once granted. Accounting integration is required.

#### Open questions before any code
See §8.6.

---

## §6 · Cross-cutting concerns

### 6.1 Schema migrations
`schemaMapper.js` auto-creates missing sheets/columns at bot startup. Process:
1. Add the new sheet definition to `REQUIRED_SHEETS` (or new column to existing entry).
2. Deploy. Next boot adds the sheet/column with empty/default values.
3. No manual sheet ops; idempotent across redeploys.

### 6.2 Testing strategy
- **Offline smoke** (`npm run smoke`): pure-logic checks; no sheets/Telegram/OpenAI. Current: 76 checks across 8 sections (S1-S8). Add Sn-N checks for every new repository/engine module.
- **Manual smoke**: `TESTING.md` — checklist per business flow. Run before any UI-touching deploy.
- **Production observation**: `BotAuditLog` + `WebhookErrors` sheets (when implemented per TG-3 / TG-5).

### 6.3 Session management
`sessionStore` is the only source of truth for in-flow state. Session types in active use:
- `task_assign_flow` — assigner's 6-step picker
- `task_propose_flow` — doer's hours/deadline picker (incl. calendar)
- `task_counter_flow` — assigner's counter note input
- `task_incentive_flow` — assigner's amount input
- (planned) `task_template_flow`, `customer_order_flow`

Rule: every new multi-step flow gets its own session type. Never reuse types across domains.

### 6.4 Performance budget
- Sheets API: stay under 100 calls/minute. Caching (TG-11) when load demands it.
- OpenAI: only NL paths hit OpenAI. Cache (TG-16) when costs demand.
- Telegram edits in-place (anchor pattern) — avoid sending new messages where edit is possible.

### 6.5 Privacy & access control

| Data | Owner gates | Visibility |
|---|---|---|
| Tasks | All employees (own + manageable subtree) | Money never shown |
| Incentives | `financeIds` only | Doer sees their own row's amount |
| TaskEvents.meta_json | `financeIds` (when amount inside) | Audit tab strips money for admin |
| Customers (credit/balance) | `financeIds` + the customer themselves | Sales team sees only contact info |
| Templates | All managers (consume); admin (create/approve) | n/a |
| User prefs | Each user (own only); admin (reset) | n/a |

---

## §7 · Decision log

Reverse chronological — newest first.

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-12 (late) | Add commits PA-1..PA-5: Payment Automation track (auto-DM, OCR, bank API, wallet, premium tier templates) | Owner observed admin workload around payment receipt verification is high; OCR + bank API + tier-aware DM can take 80-95% of that off admin. Wallet is friendly skin over existing ledger. |
| 2026-05-12 (late) | OCR is admin assistance, never autonomous approval | Receipts are forgeable; bank statement is truth. `AUTO_APPROVE_HIGH_CONFIDENCE` defaults to false. Admin always taps. The tap takes 1 second — that 1 second is the fraud-resistance. |
| 2026-05-12 (late) | Both OCR and Bank API designed from day one | Owner explicit choice; provider-agnostic abstractions allow either to be enhanced/swapped without rewriting the matcher or the admin UI. |
| 2026-05-12 (late) | Wallet reuses LedgerTransactions, not a new sheet | One source of truth. "Wallet" is a customer-friendly read of the existing ledger; the new columns just add wallet-specific source_type and direction. |
| 2026-05-12 | Add commits 11–14 to the roadmap: Referral graph + Loyalty platform with `atfactoryprice.com` integration | Owner's business model requires a two-sided affiliate-and-customer-loyalty system. Architectural patterns from tasks/orders generalize cleanly. |
| 2026-05-12 | Scenario C confirmed: worker chain AND customer chain, separate rules, shared LoyaltyLedger | Most ambitious but most powerful. Workers earn from worker-output; customers earn from customer-purchases. |
| 2026-05-12 | `atfactoryprice.com` serves both as storefront and registration funnel | Single coherent surface across bot and web; loyalty balance and identity must be unified across channels. |
| 2026-05-12 | Admin direct task assignment shortcut folded into commit 4 (Reports) | Quick win (~1-2h); admin needs this to test the reporting surface freely without dancing through org-tree filters. |
| 2026-05-11 | Templates support per-template `auto_negotiate` + `requires_doer_ack` (rather than global) | Different routine tasks have different friction tolerances |
| 2026-05-11 | Bot self-learning trigger: 5+ identical in 30 days | Conservative; avoid suggesting templates from incidental repeats |
| 2026-05-11 | No monetary caps yet on auto-approvals; rely on admin FYI | Faster delivery; tighten if abuse emerges |
| 2026-05-11 | Customer surface stays Telegram for now; WhatsApp deferred | Don't multiply surfaces before proving the model |
| 2026-05-11 | Pick AI model at implementation time, not in design | Pricing/quality changes monthly |
| 2026-05-11 | Both bot-curated AND manager-proposed templates; bot self-suggests after threshold | Wide net for capturing routine work |
| 2026-05-10 | Reorder negotiated flow: incentive BEFORE accept_timeline | Assigner can think holistically about timeline + bonus together |
| 2026-05-10 | Accept button gated on incentivized track until incentive set | Prevents accidental "₦0 by default" outcomes |
| 2026-05-10 | Salaried track stays incentive-free (no optional bonus) | Keeps flows clean; avoid edge cases |
| 2026-05-10 | Calendar deadline picker: Mon-first 7-col grid, cap +6 months forward | Standard Telegram bot pattern; matches local UX |
| 2026-05-10 | Custom hours: numeric reply, decimals OK, max 720h | Cover edge cases without UI bloat |
| 2026-05-10 | Templates: pre-deploy legacy tasks preserved (no migration) | Cleanest cutover, no data risk |
| 2026-05-09 | Negotiation cap = 3 rounds (counter + renegotiate combined) | Prevents thrashing; forces decision |
| 2026-05-09 | Incentives sheet separate from Tasks sheet | Privacy: scrum-master admin must never see compensation |
| 2026-05-09 | TaskEvents append-only audit | Performance analysis + Gantt later |
| 2026-05-09 | Doer's final-ack required on salaried track too | Symmetric with incentivized; no silent fast-forward |
| 2026-05-09 | Finance role split from admin role (`financeIds`) | Privacy of compensation data |
| 2026-05-08 | Org hierarchy: tree (single parent), encoded in `parent_department` + `manages` | Minimal sheet footprint; deterministic resolution |
| 2026-05-08 | Climbing approvals: forward-up with required comment, grievance skips subject | Reflects real-world delegation |
| 2026-05-08 | Notification priorities: 4 levels with distinct push/sound/re-ping | Critical work cannot be missed; low-priority doesn't burn attention |

---

## §8 · Open questions

Per phase. Each must be answered before that phase starts.

### Commit 4 — Reports
- Q: Should the Performance Report include a Gantt chart view? (Telegram inline keyboards can't render bars natively — would need an HTML link to a hosted page.)
- Q: For Incentives Report — group by doer or by date? Or pick on render?
- Q: Should "Mark paid" send a DM to the doer ("✅ Your ₦5,000 was paid")?

### Commits 5a/5b — Templates core
- Q: Template editing — full UI in bot, or admin edits the sheet directly first version?
- Q: Should templates be department-scoped or globally available?
- Q: Per-doer rate limits inside templates (e.g. max 3 daily-sales-report tasks per doer per day)?

### Commit 6 — Manager-proposed + self-learning
- Q: Self-suggestion: should admin auto-approve manager-proposed templates after N successful uses? Or always manual approve first time?
- Q: "Don't ask again" — per template-title pair, or per manager globally?

### Commit 7 — Adaptive UI
- Q: Prefs storage: separate `UserPreferences` sheet or `Users.prefs_json` column?
- Q: Reset command — admin-only, or each user can reset their own?

### Commits 8–9 — Customer orders
- Q: Do customers go into the `Users` sheet with `role=customer`, or a separate `Customers` sheet? (Need to check what exists.)
- Q: Auto-approval credit check — does `credit_limit_remaining` mean (limit − outstanding_balance) or (limit − sum_of_pending_orders)?
- Q: Required deposit logic — fixed % per category? Per customer term?
- Q: How does the customer pay? Bank transfer with manual confirm, or integrate with a payment gateway later?

### Commit 10+ — Conversational AI
- Q: Whose conversations get AI parsing — only managers, or doers too?
- Q: When the AI is uncertain, drop to tap UI silently or explicitly ("I'm not sure about the deadline — please pick:")?
- Q: Budget cap — per user per day, or total bot per day?

### §8.6 · Commits 11–14 — Referral graph + Loyalty platform
- Q: **Legal compliance** — what is the local Nigerian regulation on multi-level commission structures? (Requires lawyer/accountant conversation BEFORE any code.)
- Q: **Identity reconciliation** — what does the existing `atfactoryprice.com` user table look like? Email, phone, username? How do we link to Telegram IDs?
- Q: **Commission formula** — how many levels deep do points flow? What % at each level? Fixed schedule (e.g. 10/5/2 for L1/L2/L3) or configurable per-product/per-event?
- Q: **Worker chain trigger events** — does Abdul earn when his sub-worker completes a task, brings an order, brings a customer, brings another worker? All of the above? Different point values per event?
- Q: **Customer chain trigger events** — does the referring customer earn on every purchase, only the first purchase, or a percentage of lifetime spend?
- Q: **Point expiry** — do points expire? After how long? Or never?
- Q: **Point transferability** — can a distributor transfer points to another distributor or customer? Or strictly non-transferable?
- Q: **Withdrawal-on-departure** — if a worker/distributor leaves, what happens to their accumulated points? Forfeit? Cash out? Time-windowed cash out?
- Q: **Accounting treatment** — points granted are a liability on the books; how do we recognize them? (Requires accountant conversation.)
- Q: **Redemption catalog** — what can points be redeemed for? Computer, software, hardware, discount on next purchase, cash equivalent? Configurable list?
- Q: **Cross-chain interactions** — can a worker also be a customer (earning in both chains)? Most likely yes; how does the bot prevent double-dipping (earning twice on the same transaction)?
- Q: **Referral code format** — auto-generated (`AFP-ABDUL-001`) or user-chosen with admin approval?

---

## §9 · Validation gates & deployment

For every commit:
1. `npm run smoke` passes (≥ current count, no regressions).
2. Manual smoke per `TESTING.md` section that touches the changed surface.
3. Deploy to Railway → wait ~2 min for cold start → /health 200 check.
4. End-to-end test with at least one real Telegram account (Abdul for doer, John for assigner).
5. Watch `WebhookErrors` for 24h after any high-risk change.

For phase boundaries (Commit 4 done, Commit 7 done, etc.):
- Backup the relevant sheets before the first user assignment runs in production.
- Document the rollback procedure in the commit message.

---

## §10 · Appendix — legacy detail (TG-1 .. TG-26)

The full per-task detail (file paths, acceptance criteria, risk/rollback) for TG-1 through TG-26 lived in the former `IMPROVEMENT_PLAN.md`. Tasks that are ⏸ Deferred above retain that detail — when someone picks one up, they should re-derive the spec from the live codebase (paths/line numbers will have drifted) rather than relying on the stale write-up.

If a deferred task becomes top of mind, expand it in §5 with a fresh design before starting work.

---

*This document is the merge of `IMPROVEMENT_PLAN.md` v1.0 and `ORG_HIERARCHY_DESIGN.md` v1.0. Both source files are removed. Edits to this document should keep the §1-§9 separation crisp.*
