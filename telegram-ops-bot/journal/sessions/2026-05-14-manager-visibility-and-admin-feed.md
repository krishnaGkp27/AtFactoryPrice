# 2026-05-14 — Manager visibility + admin observability (T1 + T2 + T3)

Same day as the hygiene/UX session (which produced M1, M3, O1 and the
final UX audit). After the audit, the user described a coherent
three-piece requirement:

1. **Manager-doer feedback loop.** As a department manager, I want to
   assign tasks to Abdul and Yarima and have them see those tasks
   sorted by priority, with re-prioritization and drop-off available
   to me mid-flight.
2. **Admin observability.** All activities should be visible to admin,
   but only if he toggles it on from his own settings (i.e., opt-in,
   not opt-out spam).
3. **Sales lens for admin.** From admin's (my boss's) point of view, he
   needs to see the sales workflow — proposed orders, customer details,
   payment plan, current status.

The design conversation surfaced exactly what each piece should look
like and what state-machine + schema changes were necessary. The user
answered seven design questions (scope, drop_reason, doer notification
strategy, sort tie-break, feed defaults, sales-view actions) and then
asked for all three commits in sequence.

## What shipped

**T1 (`f947c60`) — Manager controls**
- `My Tasks` re-sorted: priority first, soonest deadline second, phase
  third. Renders with a per-tier header so long lists scan well.
- Per-row `🔝 Re-prioritize` + `🚫 Drop` buttons on Team Tasks (any open
  task, manager-or-admin gated).
- Two new state-machine transitions, both routed through the existing
  engine:
  - `update_priority`: self-transition (status unchanged). Legal in
    every non-terminal state. `patchExtras` writes the new `priority`
    column; meta_json captures `{priority, from_priority}` for audit.
  - `drop`: terminal → `dropped`. Legal from `assigned` through
    `active`. Explicitly illegal from `submitted` (assigner must
    approve/reject — never silently lose delivered work).
- Smart doer notification: silent DM if new priority is normal/low,
  audible DM if high/critical.
- 6 new smoke checks (S8.15a/b/c + S8.16a/b/c). All 82 still pass.

**T2 (`91b04bc`) — Admin opt-in Activity Feed**
- Single chokepoint in `src/services/adminFeed.js`. Every broadcast
  notification (was: `for (adminId of adminIds) bot.sendMessage(...)`)
  now flows through `adminFeed.notify(bot, eventType, text, opts, extra)`
  which consults each admin's stored prefs before delivering.
- `Users.notification_prefs` column added (JSON-encoded). Helpers:
  `updateNotificationPrefs(uid, prefs)` (replace) and
  `setNotificationPref(uid, eventType, enabled)` (merge-and-save).
- New `⚙️ Notifications` activity in the Admin hub. Each toggle flips
  immediately and re-renders in place. "Reset to defaults" clears
  the override.
- Catalog (9 events across 3 groups): tasks (5), orders (3), finance (1).
- Defaults preserve current behavior — all events that *already* DMed
  admins default ON. The lone new "noisy" event (priority change)
  defaults OFF.
- 6 new smoke checks (S9.1–S9.6) verify isEnabled() policy, override
  precedence, catalog coverage, and the legacy-events-default-ON
  promise.

**T3 (`2455331`) — Admin Sales Workflow view**
- New `📊 Sales Workflow` activity in the Admin hub. Read-only grouped
  view of orders (pending acceptance / accepted in flight / recently
  delivered) joined with customer phone, tier, credit limit, and current
  ledger balance from `LedgerBalanceCache`.
- Detail card per order shows full customer context plus 3 most recent
  other orders from the same customer (pattern-spotting in one view).
- Three sheets read in parallel (`Promise.all`) so one round-trip
  renders the whole page.
- Zero new schema. Reuses Orders + Customers + LedgerBalanceCache
  end-to-end.
- Admin override actions (force-accept, reassign, cancel-from-admin)
  deliberately deferred — they need an Order state machine first.

## Design decisions captured in commit messages

- `drop_reason: optional` — Confirm-drop is one tap; the reason field
  is opt-in. Captures intel when the manager has time; doesn't add
  friction when they don't.
- `doer_notify_priority: smart` — silent DM if new priority is
  normal/low; audible DM if high/critical. Matches the existing
  `priorityIsSilent()` policy used for task assignment.
- `sort_tiebreak: deadline` — within the same priority tier, the
  soonest deadline wins. Phase order is the tertiary fallback.
- `feed_default: preserve_now` — every event that admins already get a
  DM for defaults to ON. Admins opt OUT at their pace via the new
  Notifications screen. Avoids surprising anyone with "where did my
  notifications go?" after the upgrade.
- `sales_view_actions: readonly` — ship the lens first; admin overrides
  wait for the Order state machine.

## What this enables next

- **Re-prioritize-aware reports.** Now that priority changes flow
  through TaskEvents, future reports can surface "how often does the
  manager bump priority mid-flight?" and "which doers see frequent
  re-prio bumps?" — early proxy signals for capacity planning.
- **Admin feed becomes the extension point** for new principals
  (finance, dept heads, etc.). Adding "send sales summary to finance
  weekly" is just a new event type + a couple of toggle rows.
- **Sales workflow view** is the launchpad for Order state machine
  work. Once the read-only lens is in place, adding write actions
  (force-accept, reassign) is purely additive on the view side.

## Out of scope (deferred)

- Customer-side order proposals (Commit 8 in the main roadmap). When
  customers can self-serve through the bot, the Sales Workflow view
  already has the right shape to surface "proposed by customer" rows.
- Order state machine. Today `ordersRepository.updateStatus` mutates
  the status column directly. Migrating to a state-machine engine
  (mirroring `taskStateMachine`) is a separate commit that should
  precede any admin-override actions on the Sales view.
- Activity feed for non-admin principals. The `adminFeed.notify()`
  signature is principal-agnostic by design (it just iterates a list
  of recipient IDs); when finance and dept heads need their own feeds,
  we'll add a `recipientList` parameter rather than fork the service.
