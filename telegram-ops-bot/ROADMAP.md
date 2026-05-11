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

### 4.6 Deferred items (legacy Phase 4)

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
