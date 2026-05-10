# Org hierarchy & climbing approvals — locked design (TG-7.5)

**Status:** Phase A (schema + pure graph helpers) **implemented** in repo — see `src/org/deptGraph.js`, `usersRepository` / `departmentsRepository` extensions, `schemaMapper` column bootstrap, `npm run check-org`. **Climb / notifications / UI not wired yet** (Phase B).

**Owner vision:** Tree rooted at Admin; scopes tied to departments; approvals climb parent-by-parent with notes preserved to Admin; always-admin actions unchanged; compact Sheets; Telegram-first for workers + isolated client leaves.

---

## 1. Goals & non-goals

### Goals

- Model the company as a **tree** (single parent per node): Admin → managers → workers; clients as **leaves** attached to an owner node.
- **Climbing approvals:** default path is parent → parent → … until an authorised node approves, or the chain ends at Admin for visibility.
- **Jump approvals:** existing **2-admin** and other hard gates in `risk/evaluate.js` stay as today — no climb for those actions.
- **Forward up** at any step with **required comment** (suggested + free text); full thread visible to Admin in reports.
- **Grievances:** climb the tree but **skip** the node who is the subject of the grievance.
- **Cross-branch requests:** must route **up to the lowest common ancestor**, then down — no peer shortcuts.
- **Notifications by priority:** Critical (push + sound + re-ping), High (push), Normal (silent push), Low (inbox only).
- **Snooze:** `Snooze 1h` on pushes; snooze only defers re-pings for Critical, does not dismiss.
- **Audit:** every step (approve / reject / forward / snooze expiry / auto-escalation) logged in **one** existing audit mechanism (see §6).
- **Mutations:** who may add/move/remove org nodes = **Admin only**, **2-admin gated** (same as other sensitive sheet writes).
- **Sheet discipline:** **two new columns** now (`Departments.parent_department`, `Users.manages`); **three optional columns** later on `Tasks` when Tasks v2 ships; **no new sheet** for org structure.

### Non-goals (this phase)

- DAG (multiple parents) — out of scope; tree only.
- Firestore / new DB — out of scope; design stays Sheets-migratable.
- Replacing existing supply-request 3-stage flow in one shot — **integrate** with climb model over time (see §8 migration).
- Building Tasks v2 UI in this document — only prerequisites are defined.

---

## 2. Data model (Sheets)

### 2.1 `Departments` — add one column

| Column | Name | Type | Description |
|--------|------|------|-------------|
| *(existing)* | … | … | Unchanged |
| **NEW** | `parent_department` | string, optional | Name of parent department row (same sheet). Empty = top-level under Admin root. |

**Rules**

- No cycles: enforce on write (admin mutation path).
- Child inherits no automatic activities unless business configures `allowed_activities` on that row.
- **Depth:** unbounded in model; UI may cap display depth (e.g. collapse after 4 levels) without changing data.

### 2.2 `Users` — add one column

| Column | Name | Type | Description |
|--------|------|------|-------------|
| *(existing)* | `departments` | CSV | Departments this user **belongs to** (already multi-dept). |
| **NEW** | `manages` | CSV | Department names this user **heads / owns scope for** (union of `allowed_activities` from those dept rows = their management quantum). |

**Rules**

- A user may appear in `manages` for multiple departments.
- **Scope resolution (Doubt 1 — locked):** capabilities for a manager = **union** of `allowed_activities` from every department listed in `manages`. No per-user activity override; exceptions = new department row.
- **Employee with empty `manages`:** no sub-tree; only own work + assigned climbs.

### 2.3 `Customers` (clients) — no structural change in this doc

- Clients identified by existing **Telegram ID** linkage (column as already used by bot).
- Client **never** participates in employee climb; visibility = **leaf + owner chain** only (see §4.3).

### 2.4 `Tasks` (deferred to Tasks v2)

When Tasks v2 is implemented, append only:

| Column | Purpose |
|--------|---------|
| `due_date` | optional ISO date |
| `priority` | `low` \| `normal` \| `high` \| `critical` (maps to §5) |
| `parent_task_id` | optional link for sub-tasks |

Comments / activity timestamps live in **audit log**, not duplicated on the row.

### 2.5 No new sheet for org graph

The tree is fully encoded in `parent_department` + `manages` + existing `departments`.

---

## 3. Principals & resolution

### 3.1 Principal types

| Type | Source row | In tree? |
|------|------------|----------|
| `employee` | `Users` | Yes |
| `client` | `Customers` | Leaf under assigned owner |
| `admin` | `config.access.adminIds` ∪ Users with admin role (existing rules) | Root-side |

### 3.2 `resolvePrincipal(telegramUserId)`

Returns `{ type, userOrCustomer, departments[], manages[], isAdmin }`.

---

## 4. Authorisation helpers (signatures — implementation detail)

All new flows call these; existing flows gain them gradually.

### 4.1 Department graph (in-memory per request)

```text
buildDeptGraph(): Map<deptName, { parent, allowedActivities[] }>
```

Loaded from `Departments` + cache (future TG-11).

### 4.2 Tree of accountability (not org chart HR)

**`getManagementChain(userId)`** → ordered list of `userId` from **immediate parent** up to Admin.

**Parent resolution rule (v1 — simple, deterministic):**

1. Collect all departments in `user.departments`.
2. For each dept, walk `parent_department` until empty.
3. Collect every `Users` row where `manages` intersects any dept on those paths.
4. Pick the **nearest** manager(s): users who `manages` a department that is an ancestor of (or equal to) the user’s deepest assigned department.
5. If multiple candidates at same depth, **all** receive the same climb step (OR-approve: first approval of the set advances the climb — configurable; default **first approval wins** to avoid deadlock; document in runbook).

*Note:* If product later needs strict single-parent, add optional `Users.reports_to_user_id` column (one column). **Not in v1** to honour sheet minimalism.

### 4.3 `canSee(actor, targetUserId | clientId, resource)`

- Employee: see self + descendants in management tree + resources assigned.
- Manager: see subtree.
- Admin: see all (subject to existing admin list).
- Client: see only resources tagged to that client; **no** upward climb into employee data except fields explicitly allowed for “client portal” actions.

### 4.4 `canAssignTo(actor, targetUserId)`

True if `targetUser`’s department set is contained in the subtree of any department in `actor.manages` (walk `parent_department` upward from target depts).

### 4.5 `lowestCommonAncestorDept(deptA, deptB)`

Walk parents until intersection; used for cross-branch **request** routing.

---

## 5. Priority & notifications (Doubt 2 — locked)

### 5.1 Levels

| Level | Code | Push | Sound | Re-ping | Inbox |
|-------|------|------|-------|---------|-------|
| Critical | `critical` | Yes | Yes | Every 30 min until acted | Yes |
| High | `high` | Yes | Yes | No | Yes |
| Normal | `normal` | Yes | No (silent) | No | Yes |
| Low | `low` | No | — | — | Yes |

### 5.2 Defaults by action category (editable in `risk/evaluate.js` or small config table)

| Category | Default |
|----------|---------|
| Supply request (blocking dispatch) | `critical` |
| Sale / return / transfer / price (financial) | `high` (push); actual approval still **jump / 2-admin** per existing rules |
| Task assignment | from assigner (`normal` default) |
| Grievance | `critical` |
| FYI / reports | `low` |

### 5.3 Forward-up may bump priority

When forwarding, node may set priority to **at most** one level higher than current (cannot downgrade Critical).

### 5.4 Snooze

- Inline button `🔕 Snooze 1h` on Critical (and optionally High) cards.
- Snooze: suppress re-pings until expiry; request remains in inbox; **no** state change on the approval climb.

### 5.5 Telegram API mapping

- Sound: `disable_notification: false` on Critical/High; `true` on Normal; Low = no `sendMessage` for approval (write inbox only — inbox is a **menu hub** backed by ApprovalQueue filtered by `current_approver_id`).

---

## 6. Audit & “notes float to Admin”

### 6.1 Single append-only stream

Reuse **`auditService` / existing audit append** (or the `BotAuditLog` sheet introduced with API hardening — whichever is live at implementation time). Each log entry:

```json
{
  "ts": "ISO8601",
  "event": "climb_approve|climb_reject|climb_forward|climb_snooze|climb_escalate|jump_admin_approve|...",
  "requestId": "<ApprovalQueue id or climb correlation id>",
  "action": "<intent action key>",
  "fromUserId": "...",
  "toUserId": "...",
  "priority": "critical|high|normal|low",
  "comment": "string|null",
  "payloadSummary": "short human string"
}
```

### 6.2 Admin report

Query: `requestId = X` ORDER BY `ts`. Renders full thread for Admin dashboard / NL “show approval trail TASK-…”.

---

## 7. Climb state machine

### 7.1 States (stored in `ApprovalQueue.actionJSON` or dedicated fields — minimal)

| State | Meaning |
|-------|---------|
| `climb_pending` | Waiting on current approver(s) at `current_level` |
| `climb_forwarded` | Forwarded up; `current_level` incremented |
| `climb_approved` | Chain complete; hand off to executor / existing post-approval flow |
| `climb_rejected` | Terminal |
| `jump_pending` | Existing 2-admin / always-admin path (unchanged) |

### 7.2 Fields in `actionJSON` (proposal — merge with existing `stage` usage carefully)

```json
{
  "climb": {
    "mode": "climb|jump",
    "priority": "critical|high|normal|low",
    "currentApproverIds": ["..."],
    "trail": [{ "userId": "...", "action": "forward|approve|reject", "comment": "...", "at": "ISO" }],
    "subjectUserId": "...",
    "grievanceAgainstUserId": null
  }
}
```

**Grievance:** set `grievanceAgainstUserId`; when computing `currentApproverIds`, filter out that user and their self-approval.

### 7.3 Auto-escalation (optional v1.1)

If Critical item untouched after **24h**, auto `Forward up` with system comment `auto-escalated after 24h`. Configurable per action later.

---

## 8. Integration with existing flows

### 8.1 Today

- Supply: Dispatch → 2-admin → dispatch person (implemented).
- Many writes: 2-admin via `ApprovalQueue`.

### 8.2 Target (phased)

| Phase | Behaviour |
|-------|-----------|
| **A** | Ship graph columns + helpers + audit schema; **no** behaviour change on existing approvals. |
| **B** | New **generic climb** for **new** action types only (e.g. internal cross-dept request, Tasks v2 sign-off). |
| **C** | Optionally migrate supply to climb **after** finance node exists in tree; until then supply stays 3-stage + jump where needed. |

Each phase behind a feature flag until you validate one business cycle.

---

## 9. Forward up (Doubt 3 — locked)

- Buttons: `✅ Approve` `❌ Reject` `⬆️ Forward up`.
- Forward: modal / force-reply for **comment** (min length e.g. 10 chars); optional **suggested replies** from template list per action type.
- Forward: recompute `currentApproverIds` = parent per §4.2; append to `trail`; notify new approvers per §5.

---

## 10. Security & invariants

- Client callbacks: validate `telegram_id` matches customer row; strip any climb fields from client-visible payloads.
- No bypass: even “urgent” cannot skip to Admin unless `risk` marks action as `jump`.
- Rate-limit climb notifications per recipient (e.g. max 20 Critical/hour) to avoid abuse — config constant.

---

## 11. Acceptance criteria (implementation sign-off)

1. **Sheets:** With only `parent_department` + `manages` populated on a small fixture sheet, `buildDeptGraph` returns correct parent links; cycle detection rejects a cycle.
2. **canAssignTo:** Manager of `Sales` can assign to user in `Sales-Lagos` child; cannot assign to user only in unrelated branch.
3. **Climb happy path:** Employee submits climb-mode action → parent receives Critical card with sound → Approve → state `climb_approved` → executor runs.
4. **Forward up:** Mid-node forwards with comment → parent receives new card; `trail` has two entries; audit has two rows.
5. **Grievance:** Grievance against manager M → climb skips M when M would be approver.
6. **Cross-branch:** Request from dept A to B creates **no** direct message to B; first notification goes to LCA manager per §4.5.
7. **Jump path unchanged:** Sale still requires 2 distinct admins; climb fields absent or ignored for that `actionJSON`.
8. **Low priority:** No Telegram push; entry appears in approver’s `📥 My approvals` hub only.
9. **Snooze:** Critical re-pings suppressed for 1h after snooze; request still completable.
10. **Admin report:** Single command or menu shows full thread for a `requestId`.

---

## 12. Roadmap slot

| ID | Dependency |
|----|------------|
| **TG-7** | `ACTION_POLICY` + intent enum sync |
| **TG-7.5** | This document — columns + helpers + climb engine + audit + notification priority |
| **TG-8** | Domain split; `domains/org/` or `domains/approvals/` owns climb |
| Tasks v2 | After TG-7.5 + TG-8 slice for tasks |

---

## 13. Open items for implementation kickoff (not blocking design)

- Exact **OR-approve** rule when two managers are same depth (default: first wins — confirm at kickoff).
- Whether **24h auto-escalate** ships in v1 or v1.1.
- Whether `ApprovalQueue` gets a dedicated `current_approver_ids` column vs JSON-only (JSON-only preferred for zero new columns).

---

*Document version: 1.0 — locked after user sign-off “go”.*
