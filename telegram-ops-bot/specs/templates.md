# Spec: Task Templates

**Status:** 📋 Planned — design only, no code yet.
**Covers:** commits 5a, 5b, 6 (per ROADMAP §4.2).
**Parent:** `ROADMAP.md` §5.2.
**Touches:** task workflow only — internal employees, no customer-facing surface yet.
**Reuses:** task state machine (`src/flows/taskStateMachine.js`), TaskEvents audit, Incentives sheet.

---

## §1 Goals & non-goals

### Goals
- Cut routine task assignment from 6 taps to 2.
- Capture **institutional knowledge** about how often-repeated work is shaped (hours, deadline, incentive, who does it).
- Three independent paths to growing the library:
  1. **Admin curated** — owner creates official templates.
  2. **Manager proposed** — manager saves a one-off as a template; admin approves.
  3. **Bot self-learning** — after N identical assignments, bot offers to template it.
- Preserve all existing **engine invariants**: every status transition still routes through `taskStateMachine.transition()`, every event still writes to TaskEvents, money still lives only in Incentives sheet.
- **Per-template friction control**: each template picks whether the doer must one-tap Accept (default) or the task auto-starts (no Accept step).

### Non-goals (this spec)
- Templates for customer-facing flows (covered in `customer-orders.md`).
- LLM-driven template extraction (covered later in §5.5 AI front-door).
- Recurring-task scheduling (e.g. "every weekday at 9am"). Templates are one-shot triggers; recurrence is a future addition.
- Cross-organization template sharing.

---

## §2 Data model

### 2.1 New sheet: `TaskTemplates`

15 columns. Created automatically by `schemaMapper.js` on boot.

| Col | Field | Type | Notes |
|---|---|---|---|
| A | template_id | string | `TMPL-001` auto-incremented |
| B | name | string | Display name (e.g. "Daily Sales Report") |
| C | description | string | Free text shown to doer |
| D | track | enum | `salaried` \| `incentivized` |
| E | priority | enum | `critical` \| `high` \| `normal` \| `low` |
| F | default_incentive | number | ₦ amount (incentivized only; ignored otherwise) |
| G | default_hours | number | Hours expected for the work |
| H | default_deadline_offset_days | int | 0 = today, 1 = tomorrow, … |
| I | auto_negotiate | bool | Skip propose-timeline + accept-timeline steps |
| J | requires_doer_ack | bool | Only meaningful if `auto_negotiate=true` |
| K | allowed_departments | CSV | empty = any |
| L | allowed_assignees | CSV | user_ids; empty = any in allowed dept |
| M | source | enum | `admin` \| `manager` \| `auto` |
| N | status | enum | `active` \| `pending_approval` \| `retired` |
| O | created_by | user_id | Who first proposed it |
| P | created_at | ISO | First creation timestamp |
| Q | approved_by | user_id | (Optional) admin who approved a manager-proposed |
| R | approved_at | ISO | (Optional) |
| S | usage_count | int | Bumped on each consumption; reset to 0 when retired |
| T | last_used_at | ISO | Updated on each consumption |

**Rules:**
- Only `status=active` templates appear in pickers.
- `pending_approval` templates appear in the admin's "Approve Templates" view only.
- `retired` templates are hidden from all pickers but kept for audit (TaskEvents.meta references them).
- `usage_count` + `last_used_at` enable adaptive sorting (most-used + most-recent first).

### 2.2 No changes to existing sheets

- `Tasks` already has `priority`, `track`, `proposed_hours`, `proposed_deadline` columns (commit 1). Template-driven creation just pre-fills these.
- `TaskEvents.meta_json` gains an optional `template_id` field on the `assigned` event row. No schema change needed.
- `Incentives` is untouched — templates write to it the same way assigners do today.

### 2.3 Self-learning suppression state

Stored in `UserPreferences` sheet (also planned, see `adaptive-ui.md` if/when it exists). For now: a per-(manager, title) "don't suggest again" flag.

If `UserPreferences` ships in a different commit, this spec adds the column on demand.

---

## §3 Lifecycle

### 3.1 Template states

```
   ┌──────────────────┐
   │ pending_approval │◀──────── manager proposes / bot auto-drafts
   └────────┬─────────┘
            │ admin approves
            ▼
   ┌──────────────────┐
   │      active      │◀──────── admin creates directly
   └────────┬─────────┘
            │ admin retires (or manager retires their own)
            ▼
   ┌──────────────────┐
   │     retired      │
   └──────────────────┘

   (admin can move retired → active again with a "Restore" action)
```

### 3.2 Consumption flow

When a manager uses a template, the engine runs:

```
1. Validate: actor.manages overlaps template.allowed_departments (if set)
2. Validate: chosen assignee in template.allowed_assignees (if set)
3. Create task via taskStateMachine.create({
     title: template.name,
     description: template.description,
     track: template.track,
     priority: template.priority,
     assigned_to: <chosen assignee>,
     assigned_by: <actor>,
   })
4. Write TaskEvents `assigned` row with meta = { template_id }

5. If template.auto_negotiate = true:
   a. Pre-fill proposal: transition(propose_timeline) as system on behalf of doer
      with hours/deadline computed from template defaults
      → status = awaiting_timeline_ack
   b. If track = incentivized: write Incentives row with default_incentive
      (no incentive UI shown — auto-set)
   c. Auto-accept timeline: transition(accept_timeline) as system on behalf of assigner
      → status = awaiting_final_ack
   d. If requires_doer_ack = true:
      → DM doer with one-tap Accept card; doer taps → final_ack → active
   e. If requires_doer_ack = false:
      → transition(final_ack) as system on behalf of doer
      → status = active immediately
      → DM doer informationally (no buttons except Mark Done)

6. If template.auto_negotiate = false:
   → Status stays assigned
   → DM doer with the normal propose-timeline card
   → All defaults from template still apply if doer doesn't override

7. Bump usage_count, last_used_at on the template
```

**Critical invariants:**
- Auto-negotiated steps STILL go through `transition()`. They just have `actor_user_id` recorded as the assigner (or `system_template` — see §3.3).
- Every auto-step writes a TaskEvents row with `meta.template_id` so audit can reconstruct the deal.
- The engine itself is not changed. The template flow is a thin layer ABOVE the engine that fires multiple legal transitions in sequence.

### 3.3 Audit identification

Question for design: when the template auto-fires `propose_timeline` "on behalf of the doer", whose `actor_user_id` goes into TaskEvents?

**Option A** — Use the doer's user_id (they implicitly authorized this when accepting the template).
**Option B** — Use a synthetic `system_template:<template_id>` actor.
**Option C** — Use the assigner's user_id (they triggered the action).

**My preference: Option B**. Audit can trivially distinguish auto vs manual, and replaying the log shows exactly what was machine-driven. Open question §8.

---

## §4 UI flows

### 4.1 Assigner — Use a template (commit 5b)

Step 0 (NEW — prepended to assign-task picker):

```
📌 Assign Task — How?

[ ⚡ From template ]    [ ✏ Custom (one-off) ]

[ ⬅ Back to Tasks ]
```

#### "From template" path

```
Step 1/3 — Pick a template:

┌─────────────────────────────────────────┐
│ 📋 Daily Sales Report  ·  Salaried       │  → TMPL-001
│ 📋 Restock Lagos Display  ·  Salaried   │  → TMPL-002
│ 💰 Wire Panel Touch-up  ·  Incentivized │  → TMPL-003 · default ₦3,000
│ 💰 Sample Delivery  ·  Incentivized     │  → TMPL-004 · default ₦500
└─────────────────────────────────────────┘
[ Page 1/2 ] [ Next » ]
[ ⬅ Back ] [ ❌ Cancel ]
```

Templates sorted by `(usage_count DESC, last_used_at DESC)` for this manager. Top 8 per page.

```
Step 2/3 — Pick assignee:

(filtered by template.allowed_assignees / allowed_departments)
[ Same picker as today ]
```

```
Step 3/3 — Confirm:

📌 Template Task — Confirm

⚡ Template: Wire Panel Touch-up
💰 Incentivized · ₦3,000
👤 Assignee: Abdul Ahmed
⏱ Expected: 4h · 📅 Due: tomorrow (12-May-26)
🗒 Description: Touch-up small defects on returned panels.

_Auto-negotiate: ON · Doer ack required: YES_

[ ✅ Submit ]
[ 💰 Change incentive ]  ← only if track=incentivized, lets you override default
[ 🗒 Add note ]          ← appends a one-line note to description
[ ⬅ Back ] [ ❌ Cancel ]
```

#### Outcomes by template config

| auto_negotiate | requires_doer_ack | Doer experience |
|---|---|---|
| false | (n/a) | Normal propose-timeline card with template defaults pre-filled |
| true | true | One-tap Accept card with the full deal locked |
| true | false | Information-only card; task is `active` immediately; only `Mark done` button |

### 4.2 Admin — Manage Templates (commit 5a)

New activity under Admin hub: **🗂 Manage Templates**

```
🗂 Manage Templates

[ ➕ Create new template ]

Active templates (8):
  📋 Daily Sales Report             24 uses  · [Edit] [Retire]
  📋 Restock Lagos Display          15 uses  · [Edit] [Retire]
  💰 Wire Panel Touch-up             8 uses  · [Edit] [Retire]
  …

Pending approval (2):
  📋 Send EOD Inventory Summary   proposed by Manager X · [Approve] [Edit] [Reject]
  💰 Custom Color Quote           bot-suggested for John · [Approve] [Edit] [Reject]

Retired (3):
  [ Show retired ]
```

#### Create new template flow

A 6-step picker mirroring the task picker but writing to TaskTemplates:

1. Name
2. Description
3. Track
4. Priority
5. Default hours + default deadline offset
6. Auto-negotiate / requires-doer-ack settings
7. Allowed departments / assignees
8. Default incentive (if incentivized)
9. Confirm → row appended with status=active, source=admin

#### Edit / Retire

In-place edits. Retire = set status=retired (soft delete). Restore is admin-only.

### 4.3 Manager — Propose a template (commit 6)

On the **task assign-flow Confirm card** (one-off path, not template path), add a button:

```
[ ✅ Submit ]
[ ⭐ Submit + save as template ]   ← NEW
[ ⬅ Back ] [ ❌ Cancel ]
```

Tapping "Submit + save as template":
1. Creates the task normally.
2. Creates a TaskTemplates row with source=manager, status=pending_approval, fields copied from the task.
3. DMs admin: "✋ Manager X proposed a new template — 'Wire panel touch-up'. [Approve] [Edit] [Reject]"

Once approved, the template appears in this manager's "From template" picker the next time they assign.

### 4.4 Bot self-learning suggestion (commit 6)

#### Trigger

When a manager **submits the Assign Task confirm card** (any path), AFTER the task is created, the bot runs:

```
1. Find tasks created by this manager in last 30 days
2. Group by title (case-insensitive, trimmed)
3. If any group has ≥5 entries AND no existing template with same name AND
   this (manager, title) is not in "don't ask again" suppression list:
4. Compute medians: track, priority, hours, deadline_offset, incentive
5. DM the manager the suggestion card (see below)
```

#### Suggestion card

```
🤖 I noticed a pattern

You've assigned "Send daily sales report" 7 times this month.

Median:
   ⏱  ~30 min
   📅  Due same day
   💰  ₦100 (incentivized)
   👤  Usually Abdul (5×), once Bisi, once Chinwe

Want me to save this as a template? You'll be able to one-tap it next time,
and it'll appear in your "From template" picker.

[ ✨ Yes, draft it ]
[ Not now ]
[ Don't ask again for this task ]
```

Tapping **Yes**:
- Creates TaskTemplates row with source=auto, status=pending_approval, computed defaults
- Admin gets the normal approval DM
- Manager gets confirmation: "Drafted. Admin will approve before it's available."

Tapping **Not now**: nothing stored; will be suggested again next time the threshold is hit.

Tapping **Don't ask again**: writes a row to suppression state for this (manager, title) pair.

---

## §5 Engine integration

### 5.1 No state machine changes required

All template-driven actions fire EXISTING transitions. The state machine's transition table is unchanged.

### 5.2 New module: `src/services/templateRunner.js`

Wraps the multi-transition orchestration for `auto_negotiate=true` templates:

```js
async function runAutoNegotiated(template, task, assigner) {
  // 1. Pre-fill timeline
  await taskStateMachine.transition(task.task_id, 'propose_timeline',
    SYSTEM_ACTOR_FOR_TEMPLATE(template.template_id, task.assigned_to),
    {
      hours: template.default_hours,
      deadline: addDays(template.default_deadline_offset_days),
      auto: true,
      template_id: template.template_id,
    }
  );

  // 2. Write incentive if applicable
  if (template.track === 'incentivized' && template.default_incentive > 0) {
    await incentivesRepository.setAmount({
      task_id: task.task_id,
      amount: template.default_incentive,
      currency: 'NGN',
      set_by: assigner,
      notes: `auto from template ${template.template_id}`,
    });
    await taskStateMachine.transition(task.task_id, 'set_incentive', assigner, {
      amount: template.default_incentive,
      currency: 'NGN',
      auto: true,
      template_id: template.template_id,
    });
  }

  // 3. Auto-accept timeline (as the assigner)
  await taskStateMachine.transition(task.task_id, 'accept_timeline', assigner, {
    auto: true,
    template_id: template.template_id,
  });

  // 4. If no doer ack required, auto-final-ack
  if (!template.requires_doer_ack) {
    await taskStateMachine.transition(task.task_id, 'final_ack',
      SYSTEM_ACTOR_FOR_TEMPLATE(template.template_id, task.assigned_to),
      { auto: true, template_id: template.template_id }
    );
  }

  // 5. Bump template usage stats
  await taskTemplatesRepository.bumpUsage(template.template_id);
}
```

### 5.3 Actor identification

Per open question §8.1, this spec assumes `SYSTEM_ACTOR_FOR_TEMPLATE(tid, on_behalf_of)` returns a synthetic string like `system_template:TMPL-001:on_behalf_of:7430648262`. This is recorded in TaskEvents.actor_user_id and is easily distinguishable from a real user_id (digits-only) by downstream tooling.

The state machine's actor-role validation needs a small carve-out: when the actor starts with `system_template:`, the engine should NOT check the doer/assigner role — the template runner has done its own authorization upstream (by validating the template's allowed_departments / allowed_assignees).

This means a 5-line change to `assertActorRole()` in `taskStateMachine.js`.

### 5.4 Audit log shape changes

No schema change. New `meta_json` patterns to expect:
- `assigned` event: `{ track, priority, template_id }` (template_id added)
- `doer_proposed_timeline` event: `{ hours, deadline, auto: true, template_id }` when from template
- `assigner_accepted_timeline` event: `{ auto: true, template_id }`
- `assigner_set_incentive` event: `{ amount, currency, auto: true, template_id }`
- `doer_final_ack` event: `{ auto: true, template_id }` when from template

Tooling that already reads `meta_json` (only the planned Incentives Report so far) should be aware of these.

---

## §6 Self-learning subsystem detail (commit 6)

### 6.1 Algorithm

Pseudocode for the suggestion-trigger pass (runs on every task submission):

```python
def maybe_suggest_template(manager_id, just_assigned_task):
    last_30d_tasks = tasks.filter(
        assigned_by=manager_id,
        created_at__gte=now - 30days,
    )
    title = normalize(just_assigned_task.title)
    similar = [t for t in last_30d_tasks
               if normalize(t.title) == title]
    if len(similar) < 5:
        return
    if exists_template_with_name(title):
        return
    if (manager_id, title) in suppression_list:
        return
    medians = compute_medians(similar)
    send_suggestion_dm(manager_id, title, medians, similar_count=len(similar))
```

### 6.2 What "identical" means

- Case-insensitive
- Trimmed whitespace
- Punctuation stripped
- 80% Levenshtein similarity considered "same" (catches "Daily sales report" vs "daily-sales-report")

The 80% threshold is conservative. Open question §8.2.

### 6.3 Median computation

For numeric fields (hours, incentive, deadline_offset_days):
- Compute over the matching task set
- Round to natural units (hours: 0.5; incentive: 100; offset: integer)

For enum fields (track, priority):
- Mode (most common)
- Tie-breaker: most recent

For assignee:
- Most common; ties broken by most recent

### 6.4 Suppression storage

Either:
- A `SuggestionSuppression` sheet (small: manager_id, title_normalized, suppressed_at)
- A `UserPreferences.suggestion_suppressions` JSON column (depends on what `UserPreferences` looks like)

Decided at commit 6 start, depending on whether `UserPreferences` exists yet (commit 7 dependency).

### 6.5 Cool-down

After ANY suggestion DM (regardless of response), wait 7 days before considering the same (manager, title) again.

---

## §7 Acceptance criteria

A working commit 5a + 5b + 6 means:

1. ✅ `schemaMapper.js` creates `TaskTemplates` sheet on next boot with all 20 columns.
2. ✅ Admin can create / edit / retire templates via "Manage Templates".
3. ✅ "Assign Task" shows a "From template" step 0 with active templates listed.
4. ✅ Picking a template auto-fills all task fields; submission goes through the state machine.
5. ✅ `auto_negotiate=true` + `requires_doer_ack=true`: doer gets a one-tap Accept card.
6. ✅ `auto_negotiate=true` + `requires_doer_ack=false`: task is `active` immediately, doer just sees a notification.
7. ✅ Incentivized templates with `default_incentive>0` write to Incentives sheet and pass the amount to the doer's deal/completion DM.
8. ✅ TaskEvents rows for template-driven tasks contain `template_id` in `meta_json`.
9. ✅ "Submit + save as template" creates a `pending_approval` row and DMs admin.
10. ✅ Bot suggestion DM fires after 5 identical title in 30 days, suppressible.
11. ✅ Approve / Reject buttons work on the admin's approval queue for both manager-proposed and auto-suggested templates.
12. ✅ Smoke harness gains S9.x checks for template-driven happy path + auto-negotiate variants. Must reach ≥80 passing checks total.

---

## §8 Open questions

### §8.1 Synthetic actor for auto-fired transitions
- Q: Use `system_template:TMPL-XXX:on_behalf_of:UID` strings, or invent a new actor type in the state machine (`'system' | 'template'`)?
- Recommendation: synthetic strings. Less engine change.

### §8.2 Similarity threshold
- Q: Is 80% Levenshtein the right threshold for "same task"?
- Risk: too loose → bot suggests templates for distinct tasks. Too tight → bot misses obvious patterns.
- Recommendation: ship at 80%, watch the false-positive rate, tune to 85% if needed.

### §8.3 Template editing
- Q: Should `usage_count` reset to 0 when an admin edits a template?
- Recommendation: NO. Edits are minor by design (fix a typo, adjust default). Major changes should retire + create new.

### §8.4 Department scoping
- Q: Should templates be implicitly scoped to a department (manager only sees their dept's templates)?
- Recommendation: Yes, by default — use `allowed_departments`. Empty = visible to all.

### §8.5 Per-doer rate limits
- Q: Should a template have a "max N per doer per day" guard?
- Use case: prevent a manager from assigning "Daily sales report" twice on the same day.
- Recommendation: optional column `max_per_doer_per_day`, default empty = no limit. Defer to commit 6+.

### §8.6 Doer can request a template too?
- Q: Should doers see "Suggest a template" if they keep getting the same task?
- Recommendation: defer. The 5-times threshold from the MANAGER side already catches it indirectly.

### §8.7 What if `allowed_assignees` is empty AND `allowed_departments` is empty?
- Answer: template is open to anyone the manager could normally assign to (using existing `listAssignableUsers()`). This is the default.

### §8.8 Retired templates referenced by completed tasks
- Q: When viewing a completed task whose template is retired, do we show the template name?
- Answer: Yes — read from TaskEvents.meta_json.template_id, look up the (retired) row, show the name with a "(retired)" suffix.

---

## §9 Risk & rollback

### Risk 1 — Auto-negotiate fires too many DMs at once
**Scenario:** manager assigns 10 templated tasks in 5 minutes; each fires 3-4 DMs through the state machine; doer gets 30 messages.

**Mitigation:** the template runner should send ONE consolidated DM per task to the doer ("📨 New auto-started task: …"), not one per transition. Internal state changes don't need a DM each.

### Risk 2 — Wrong template defaults baked into many tasks
**Scenario:** admin sets `default_incentive=₦50,000` by accident; manager uses it 20 times before noticing.

**Mitigation:**
- Confirm card shows the full deal including amount.
- Admin retiring a template doesn't undo tasks already created from it — those need manual handling.
- Future: a daily "templates summary" digest to admin showing today's auto-spending.

### Risk 3 — Bot suggestion DMs feel spammy
**Scenario:** manager assigns variations of "report" 20+ times; bot DMs every time.

**Mitigation:**
- 7-day cool-down per (manager, title) regardless of response.
- "Don't ask again" hard-stops it for that pair.
- Daily cap of 1 suggestion DM per manager.

### Rollback
- Each commit is independent. Commit 5a (admin manage) can ship without 5b (consumption). Commit 6 (proposed + self-learn) is additive.
- Feature flag `ENABLE_TASK_TEMPLATES=false` short-circuits the "From template" picker step and the template runner.
- Existing one-off task creation is unaffected; templates are opt-in additions.

---

## §10 Commit decomposition

| Commit | Title | Scope | Verifies via |
|---|---|---|---|
| 5a | TaskTemplates schema + admin manager UI | TaskTemplates sheet creation, "Manage Templates" hub item, CRUD flows, admin approval queue for `pending_approval` | Manual smoke + S9.1 (sheet schema) |
| 5b | Template consumption + auto-negotiate | "From template" picker, templateRunner.js, doer DM cards (one-tap and auto variants) | Smoke S9.2-9.7 (engine sequences) |
| 6 | Manager-proposed + self-learning | "Submit + save as template" button, suggestion algorithm + DM, suppression state | Smoke S9.8-9.11 |

Each is independently shippable.

---

*Last updated: 11-May-2026. Edits to this spec should preserve the §1-§9 separation.*
