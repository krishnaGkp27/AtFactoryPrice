# ATT-R1 — Chase the missing: repeated cards, with a Mark-now button, until they mark

**Status: SHIPPED 28-Oct-2026.**

## The owner's words (28-Oct-2026)

> "I want to bring in a feature where the admin can give a constant alert or
> notification to the departments or employee group in a case where they
> don't mark the attendance. Sending card messages as it will affect their
> transportation and salary payment. You can also give them a button to mark
> it now so that they can do it on a single tap."

Rulings on the proposal: the card wording as shown · automatic mode OFF at
launch (a Settings switch) · every 30 or 60 minutes, until the 🕒 Cutoff ·
scope = departments AND a per-person pick.

## Before

One nudge at 09:00 (ATT-C3) with a 📍 Mark Attendance button, the 10:00
digest telling admins who is missing, then silence. The July "escalate after
N hours" knob was never wired.

## The admin door — 🗓 Attendance → 📊 Today

The Today view gains `📣 Chase the missing (N)` (hidden at zero) and, while a
chase runs, a line per chase and `📣 Chase status`.

**N is the attendance AUDIENCE's missing count** — every active department
member plus the manual Required-Users list, the same people the 09:00 nudge
reaches (ATT-C3 `getAudience`). 📊 Today's own "Not yet logged" list is the
manual Required list alone, so the two numbers can differ; the chase follows
the nudge, because the owner said "departments or employee group".

Screen 1 — who (`atd_adm:chase`):

```
📣 Chase — who?
⏳ 6 not marked · 28-Oct-2026 · deadline was 09:30

  ⏳ Abdul …

[👥 Everyone missing (6)]
[🏭 Dispatch (2)]   [🏭 Sales (3)]
[👤 Pick people]
[⬅ Today]
```

`👤 Pick people` → `☐ Abdul` chips that tick on tap → `✅ Continue (2)`.

Screen 2 — how often (`atd_adm:chase:c:<n>`):

```
📣 Chase Sales (3) — how often?
[🔔 Once, now]
[🔁 Every 30 min until 12:00]
[🔁 Every 60 min until 12:00]
[⬅ Back]
```

The stop time is `ATTENDANCE_CUTOFF_TIME` (the 🕒 Cutoff knob). The tap sends
the first cards at once and opens the status card (`atd_adm:chase:st`):

```
📣 Chase — 28-Oct-2026
✅ Sent to 3 — again every 30 min until 12:00.

📣 Chasing Sales (3) · 3 people · every 30 min until 12:00
  ✅ Musa · marked 09:41
  ⏳ Abdul · 2nd reminder 10:00
  ⏳ Fatima · 2nd reminder 10:00
  Next at 10:30
[⏹ Stop Sales (3)]
[🔁 Refresh] [⬅ Today]
```

`⏹ Stop` ends the chase; pending people keep their last card. The status
screen is refreshed on open (and the ATT-N1 broadcast already tells every
admin of each mark in real time).

## The employee's card

```
⏰ Attendance not marked · 2nd reminder
Abdul, your attendance for 28-Oct-2026 is not marked yet.
The deadline was 09:30.

Unmarked days count against your transport allowance and your salary payment.

[📍 Mark now]
```

- One live card per person: the previous one is deleted when the next is
  sent. The ordinal appears from the 2nd reminder on.
- The moment they mark (any door), the live card is rewritten to
  `✅ Marked at 09:41 · thank you, Abdul.` and they drop out of the chase.
  A mark that reached the sheet without the hook (restart, hand edit) is
  caught at the next tick — nobody marked is ever chased again.
- `📍 Mark now` (`atd:now`) takes the card down and opens the mark flow as a
  fresh card; **with a single configured location it skips the location
  step** (a one-option step is navigation, §2) — so with verification `none`
  one tap marks; with position / photo verification the tap lands on the
  share-position step, which is the owner's rule and is not bypassed. The
  menu tile and the 09:00 nudge keep their status-first screen (ATT-V1).
- The sentence is Settings `ATTENDANCE_CHASE_TEXT` (blank = the default
  above).

## Lifecycle and guards

- A chase ends at the cutoff, at ⏹ Stop, when the last person marks, or
  when a newer chase takes all its people (a person belongs to at most one
  live chase — the newest wins).
- Never chases anyone already marked; a DM failure is counted on the status
  card (`⚠️ DM failed`), never thrown.
- **Automatic mode** `ATTENDANCE_CHASE_AUTO` (default 0): at the deadline on
  working days, a chase for everyone missing, every `ATTENDANCE_CHASE_EVERY_MIN`
  (30) until the cutoff, once a day, no admin tap. Off at launch (owner).
- In-memory (storage rule 5b — a chase is a morning's viewer state, not a
  record): a redeploy ends a running manual chase (the admin re-taps); the
  automatic mode re-arms itself. AuditLog rows `attendance.chase_started`
  (scope, interval, until, targets, by) and `attendance.chase_ended`
  (reason, marked, pending).
- Rides the existing minute scheduler (`attendanceReminder.start` ticks
  `attendanceChase.tick` too). Admin-only (the `atd_adm:` gate). No sheet
  change, no new column, no controller change.

## Tests

- `test/unit/services/attendanceChase.test.js` — the card, missingNow (audience
  minus today's rows, with departments), start (skips the marked, button,
  audit), nothing-to-chase, re-sends on the interval with the previous card
  deleted and ordinals, the ✅ flip and the all-marked ending, the sheet-only
  mark, once, cutoff and ⏹ Stop, newest-wins, automatic mode (off by default,
  deadline, working day, once a day, Sunday), the Settings sentence, plain
  retry and a dead chat.
- `test/unit/flows/attendanceChaseFlow.test.js` — the Today chip and count,
  who → department → cadence → cards to that department only → status →
  Today's live line → ⏹ Stop; the per-person pick with ticks and Continue;
  the everyone-marked empty state.

## Later (owner's call)

- Chase the people who never marked by the cutoff a last time at the cutoff
  itself ("final notice"), and a line in the 22:00 report naming them.
- A department head as a second recipient of the status card.
- Persist a running chase in Railway Postgres so a redeploy resumes it.
