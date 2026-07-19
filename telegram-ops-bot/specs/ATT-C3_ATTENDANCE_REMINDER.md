# ATT-C3 — Attendance reminder + department audience (owner 19-Jul-2026)

Owner mandate: **everyone with an assigned department reports attendance by
09:30**; put it in the reminder. Full as-built map of the existing system was
produced first (4-agent audit, 19-Jul) — summary below so tweaks have context.

## The system as it existed (ATT-C1/C2, before this change)

- **Employee flow** (`atd:`, tile 📍 Mark Attendance, hr hub): buttons-only —
  location picker → one tap → marked `present`. No GPS/photo/text. Idempotent
  per (date, user); no self-edit; admin override only.
- **Sheet** `Attendance` A-I: date, telegram_id, employee_name, status,
  location, logged_at, logged_via (self/admin), marked_by, reason. V1 writes
  only `present`; `not_logged`/`absent`/`on_leave` are reserved, never written.
- **Admin hub** (`atd_adm:`, 🗓 Attendance): required-users picker, locations
  editor, reminder/report/cutoff times, working days, timezone, Today's Full
  View (live present/missing), Mark-on-Behalf (audited). No row edit/delete,
  no absent/leave marking, no approval-pipeline involvement.
- **Reports** (`atd_rpt:`, admin-only): 7d / ISO-week / month tabs — today
  snapshot, per-day coverage bars, per-employee % (working-day denominators).
  No per-department breakdown; CSV exporter exists but is unwired.
- **Audience** was ONLY the manual `ATTENDANCE_REQUIRED_USERS` CSV.
- **CRITICAL GAP (now closed):** no scheduler existed. REMINDER_TIME,
  ESCALATE_AFTER_HOURS, REPORT_TIME, CUTOFF_TIME were editable but nothing
  fired on them. No time rule is enforced at mark time (03:00 Sunday marks
  fine); there is no "late" concept.

## What ATT-C3 adds (shipped)

1. **Audience = departments** (`ATTENDANCE_AUDIENCE`, default `departments`):
   every ACTIVE user with ≥1 department, excluding admins; the manual CSV
   still ADDS people (union). `list` restores CSV-only. `isRequired` (flow
   gate + tile injection) follows the same audience.
2. **09:00 nudge** (`src/services/attendanceReminder.js`, morningDigest
   scheduler pattern): working days only, once/day, catch-up on redeploy.
   DM to each audience member who hasn't marked: "mark before *09:30*"
   + tappable 📍 Mark Attendance. Master switch
   `ATTENDANCE_REMINDER_ENABLED` (default 1). Time = existing
   `ATTENDANCE_REMINDER_TIME` (admin hub editable).
3. **Deadline knob** `ATTENDANCE_DEADLINE_TIME` (default `09:30`) — shown in
   the nudge and the digest header. (Informational; not enforced at mark
   time — see decisions.)
4. **Digest category 🕘 Attendance** (`DIGEST_ATTENDANCE`, default ON): the
   10:00 admin digest (after the deadline) shows `marked X/Y · N missing`
   with a drill-down listing ⏳ missing and ✅ reported (location · time).

## Owner decision menu (not built — say the word)

- **Enforce the deadline?** e.g. marks after 09:30 stamped "late" (needs a
  late flag concept; reports would show it), or block marking after
  CUTOFF_TIME.
- **Escalation**: `ATTENDANCE_ESCALATE_AFTER_HOURS` (3h) is still dormant —
  DM admins at 12:30 naming who never reported?
- **Nightly report** at REPORT_TIME (22:00) + **cutoff auto-stamp**
  `not_logged` rows at CUTOFF_TIME (planned "C3" remainder). NOTE: reports
  currently count ANY row as present without checking status — must fix
  that first if auto-stamping ever lands.
- **Field roles** (marketer/salesman): the menu tile is hidden for them, but
  if they have a department they now receive the nudge and CAN mark via its
  button. Include or exclude them?
- **Absent / on-leave marking** for admins; **row corrections**; **CSV
  export button** (exporter exists, unwired); **per-department report tabs**.
