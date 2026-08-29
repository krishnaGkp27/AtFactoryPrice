# TRM-1 — automatic task reminders, armed by two admins

Owner mandate, 27-Aug-2026 (verbatim): *"start sending the reminder on the
telegram bot for the person who is assigned the task, but the last door of
reminder will only go through it once it gets approved through two admin
gateways. Also the admin will be reminded that this task has been reminded
to this person, so that both the admin and the person doing the task
understand each other synchronously. If in case we need to stop the
reminder, we will have a chance to do it."*

## The four guarantees

| | |
|---|---|
| **ARM** | Two DISTINCT admins sign `task_reminder_enable`. The 🔁 Auto-remind chip only *queues* it — nothing is armed until the second signature. |
| **NUDGE** | The doer gets ONE DM carrying the same action chip their own card shows (⏱ Accept — give time / ✅ Mark done …), so the reminder is a shortcut, not a scolding. |
| **MIRROR** | The assigner gets one line naming who was reminded, how long they had been quiet, and how to stop it — the "synchronously" the owner asked for. |
| **STOP** | ⏹ Stop reminders: one tap, no approval, doer told the pressure is off. |

## Decisions

1. **Arming is the gated act, not each reminder.** Requiring two admins per
   individual nudge would make admins the bottleneck the feature exists to
   remove. `task_reminder_enable` is in `ALWAYS_APPROVAL_ACTIONS` **and**
   `DUAL_ADMIN_ACTIONS` (§14: never a comment claiming dual while the matrix
   returns one — the PAY-1 lesson).
2. **Stopping is single-admin on purpose.** Quieting a nudge is always safe;
   a reminder nobody can stop is why people mute bots. Assigner or any admin,
   instant, audited (`auto_remind_stopped`).
3. **Only the doer's move is nudged.** `assigned` / `awaiting_final_ack` are
   nudged on cadence. `active` is nudged only once the time THEY committed to
   has passed (salaried: `started_at + proposed_hours`; incentivized: the
   deadline, end of its day). Every other status is silent — a task that
   moved on stops nagging by itself, without clearing the flag.
4. **Once per Lagos day, whatever the cadence.** The same floor the manual
   🔔 Remind keeps, so the two doors cannot gang up on one person. The day is
   derived from the sweep's own `now`, so the guard and the cadence share one
   clock (and are testable).
5. **Settings, not code:** `TASK_REMINDER_ENABLED` (1; 0 silences every task
   nudge in one cell) and `TASK_REMINDER_HOURS` (24). No deploy to retune.
6. **Storage:** one new END column on Tasks — `auto_remind` (V), `'1'` =
   armed. The "who was reminded when" ledger is a `reminder_sent` row in the
   existing **TaskEvents** audit trail — not a new state sheet, and exactly
   the record the owner asked to be able to see. Both doors (sweep and
   manual 🔔) read and write it, so the day guard survives redeploys and
   cannot be double-spent; a 60s cache keeps the manual tap fast.

## Mechanics

- `src/services/taskReminderService.js` — `sweep(bot, {now})`, never throws,
  capped at `MAX_DMS_PER_SWEEP` (20). Scheduled in `server.js` 90s after boot
  then hourly, the approvalReminder (APR-1) shape.
- The DM renders through `taskFlow._internals` (`PRIORITY_META`, `descLine`,
  `buttonsForMyTask`) so the automatic nudge and the manual 🔔 can never drift.
- Callbacks: `tsk:rmon:<ctx>:<id>` (arm — queues), `tsk:rmoff:<ctx>:<id>`
  (stop). The card shows exactly one of the two, plus a line saying reminders
  are ON when they are.
- Executor branch `task_reminder_enable` in `inventoryService`: idempotent
  (a double-approve reports "already armed"), refuses a closed task, audits
  `auto_remind_armed`.

## What adversarial review changed before ship

A five-lens review + refutation pass ran against the first working version.
Fourteen findings survived; all are fixed and pinned by tests:

- **The day guard was process-local.** This repo deploys by pushing to main,
  several times a day, and the boot sweep re-nudged everything → *"once per
  day"* had quietly meant *"once per deploy"*. Now durable (TaskEvents).
- **Two ledgers.** The manual 🔔 kept its own, so both doors could fire the
  same day. One shared record now.
- **The kill switch failed OPEN** — `FALSE`/`no`/`off` in the sheet left
  reminders running. Now fail-closed, matching every sibling service.
- **A transient 429 burned the whole day.** Now only a permanent refusal
  (blocked/deactivated) stops the retry.
- **The per-sweep cap counted successes, not attempts**, so a batch of
  blocked chats could push past Telegram's rate ceiling.
- **Twenty armed tasks meant twenty DMs to one admin.** Mirrors are now ONE
  digest per assigner per sweep — the flood that gets a bot muted.
- **The second admin signed blind:** the arming card named neither task nor
  doer, and the request landed in ❓ Other. Now `Task:`/`Doer:` on the card
  and filed under ⚙️ Config & messaging with the dual badge.
- **A leftover pending arming silently re-armed after ⏹ Stop.** A second tap
  no longer queues a second request, and Stop withdraws any pending one.
- **A task armed just before the doer marked it done became unstoppable** —
  the chip was hidden on assigner-move statuses. Stop now always shows while
  reminders are on.
- **A deactivated doer was nudged forever.** Skipped, with one line in the
  assigner's digest telling them to reassign.
- **A blank `proposed_hours` read as `0`**, making an active task permanently
  overdue (`Number('')` is finite). Zero is now "no commitment recorded".
- **Accepting a stale proposal nudged from minute one** — the card promises
  *"Accepting restarts his Nd from today"* but the stale deadline still
  governed. The restart is now what counts.
- **The incentivized deadline expired on the server's clock**, an hour into
  the wrong Lagos day.
- **`TASK_REMINDER_HOURS` above 24 collapsed to daily after any restart**,
  and the in-memory map grew forever. Both fixed.

## Tests

- `test/unit/services/taskReminderSweep.test.js` (19) — unarmed never nudged;
  doer+assigner pair; once per day + cadence; silence off the doer's move;
  the on-schedule-active case; master switch; blocked DM still mirrors;
  a Sheets failure cannot kill the scheduler.
- `test/characterization/taskAutoRemind.test.js` (5) — the matrix really
  demands two taps; chip queues and arms nothing; approval arms and the sweep
  then speaks (+ double-approve idempotency); stop is one tap and tells the
  doer; a non-assigner manager can do neither.
- Smoke `S54.12` pins the gate membership, the `auto_remind` door in the
  sweep, one clock, the executor, and that the sweep is actually scheduled.

## Owner steps after deploy

1. Open a task in 👥 Team Tasks → **🔁 Auto-remind** → have the second admin
   approve in 🛂 Approvals → 🧪 Samples & marketing.
2. Watch for the doer's nudge (next sweep, ≤1h) and your mirror line.
3. **⏹ Stop reminders** on the same card to end them.
4. Tune `TASK_REMINDER_HOURS` / set `TASK_REMINDER_ENABLED=0` in Settings if
   the cadence needs changing — no deploy.
