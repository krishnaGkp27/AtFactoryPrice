# APR-2 — Per-department reminder controls (SHIPPED 20-Jul-2026)

Status: **shipped** — owner green-lit "next feature release" 20-Jul; all five
recommended decisions locked as recommended (fold every reminder job under one
screen; managers may request / admins approve; default OFF; 2/6/12/24h chips;
14-day backlog guard). Deferred: per-department DISPATCH-stage re-nudges for
supply requests (needs its own card design — next APR increment).

As-built keys: REMINDER_HOURS_ADMIN (admin nudges: approval sweep cadence +
on/off for sample/follow-up/cold jobs; falls back to APPROVAL_REMINDER_HOURS),
REMINDER_HOURS.<Dept> (member nudges e.g. order reminders), REMINDER_MAX_AGE_DAYS
(default 14). Flow src/flows/reminderConfigFlow.js (rmn:), tile ⏰ Reminder
Controls (daily hub), action set_reminder_config in WRITE+ALWAYS_APPROVAL,
executor in inventoryService (falls through the SEC-P2 footer), policy layer
src/services/reminderPolicy.js gating all four hourly jobs + the sweep.
Requested 14-Jul-2026. Context: APR-1's first sweeps resurfaced a 41-row
pending backlog and flooded admin chats; owner paused the feature
(`APPROVAL_REMINDER_HOURS=0` set in prod Settings, 14-Jul).

## Owner's ask (verbatim intent)

1. Stop/pause reminders — **done** (Settings row set to 0, live).
2. An admin can switch reminders ON/OFF from inside the bot, gated by
   2-admin approval (same governance as TV-2 display units).
3. The reminder feature runs **per department, separately**.

## Proposed design

### A. Per-department routing (what "separately" means here)

Each pending item reminds the people whose action is awaited, not everyone:

| Queue state | Who is reminded |
|---|---|
| Supply request at `dispatch_review` | **Dispatch** department members |
| Anything at admin/2nd-admin stage | **Admin** (approval cards, as today) |
| Task timeline awaiting doer/manager | the assignee / manager (**their** dept switch applies) |
| (future stages, e.g. SRF-2 release) | the selected release person's dept |

### B. Settings keys (sheet-editable, no deploy)

- `REMINDER_HOURS_ADMIN` — cadence for admin approval cards (0 = off)
- `REMINDER_HOURS_DISPATCH` — cadence for dispatch-stage nudges (0 = off)
- `REMINDER_HOURS_SALES`, `REMINDER_HOURS_MARKETING` — reserved, default 0
- Existing `APPROVAL_REMINDER_HOURS` becomes the fallback/default when a
  per-dept key is absent (kept for backward compatibility).

### C. In-bot control surface (new flow module `reminderConfigFlow.js`)

- Tile **⏰ Reminders** in the admin hub (admins + managers see it).
- Screen shows one row per department: `Dispatch — ON (6h)` / `OFF`,
  tap to toggle, plus cadence chips (2h / 6h / 12h / 24h).
- Submitting a change queues action **`set_reminder_config`** in the
  ApprovalQueue → 2-admin approval (admin requester counts as first,
  one OTHER admin approves — exact TV-2 `set_unit_display` semantics).
- On approval the executor writes the Settings row and confirms to both
  admins + requester. AuditLog entry `reminder_config_changed`.
- New action code added to `ALWAYS_APPROVAL_ACTIONS` — **this spec is the
  owner's explicit sign-off trail for touching risk/evaluate.js.**

### D. Backlog guard (why the flood happened)

Independent of cadence: reminders only cover items created in the last
`REMINDER_MAX_AGE_DAYS` (default 14). The 41-row historic backlog stays
silent; a separate owner decision (auto-expiry) handles cleaning it.

## Decisions to lock

1. **Scope**: approval/dispatch reminders only, or also fold the existing
   order/sample/follow-up/cold-customer reminder schedulers under the same
   per-department switches? (Recommend: fold them in — one ⏰ screen rules
   all nudges; each maps to the dept that receives it.)
2. **Who can request a toggle**: admins only, or managers too (TV-2 lets
   managers request)? (Recommend: managers may request, admins approve.)
3. **Default state after shipping**: everything OFF until you switch each
   department on from the bot? (Recommend: yes — silent by default.)
4. **Cadence chips**: 2h / 6h / 12h / 24h enough? (Recommend: yes.)
5. **Backlog guard**: 14-day max age OK? (Recommend: yes.)

## Touched files (after sign-off)

- `src/flows/reminderConfigFlow.js` (new) + registry tile + controller
  dispatch block (surgical) + `rmd:` callback namespace.
- `src/risk/evaluate.js` — add `set_reminder_config` to
  ALWAYS_APPROVAL_ACTIONS (owner-authorized by this spec).
- `src/services/inventoryService.js` — executor branch writing Settings.
- `src/services/approvalReminder.js` — per-dept routing + max-age guard.
- `settingsRepository.DEFAULTS` — new keys, all 0.
- Tests: flow characterization + sweep routing units.
