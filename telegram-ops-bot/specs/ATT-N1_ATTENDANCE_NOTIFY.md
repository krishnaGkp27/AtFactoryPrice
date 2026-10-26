# ATT-N1 — Every attendance mark is broadcast to the admins the moment it saves

**Status: SHIPPED 26-Oct-2026.**

## The owner's words (26-Oct-2026)

> "I want the Black Panther bot to send a notification of attendance marked
> by the employees as soon as they submit. It should be broadcast to all the
> admins."

> "For now, all the marks from the employees will go to all the admins in
> the admin pool, which I have created from the Railway ID. Later, I will
> make a separate holder for this required responsibility, where this
> notification will go to only that person."

## Before

A successful mark reached nobody but the employee. Admins heard about
attendance only when a mark FAILED or could not be verified (ATT-V2, a
throttled alert), in the 10:00 digest summary, and on the 📊 Attendance
Report tile.

## What it does

`src/services/attendanceNotify.js` — one DM per successful mark, sent right
after the employee's receipt (and after the admin's "Marked on Behalf" card):

```
🕘 Attendance · Abdul marked Present
📍 Kano office · 08:42 · 26-Oct-2026
📡 Position verified · 38 m from site · 📷 Photo
```

- Line 2 and 3 mirror the employee's own receipt (same row, same facts).
  Line 3 is omitted when verification is off; `📡 Position recorded` when a
  position was taken without a fence; `📷 Photo` when one was attached.
- Marked on behalf by an admin: `… marked Present · marked by Krishna`.
- **Not sent:** a repeat tap on the same day (nothing new was recorded); a
  mark that failed or could not be read back (ATT-V2 already alerts the
  admins; a second DM would duplicate it). The person who tapped is never
  told twice.
- Never throws: a failed notification cannot break a mark that saved.
  A Markdown failure retries as plain text; a dead chat is counted and
  skipped.

## Who receives it (the owner's two phases, one cell apart)

1. **Now — the admin pool.** Settings `ATTENDANCE_NOTIFY_IDS` blank (the
   default) → every id in the Railway `ADMIN_IDS` variable, through the
   Admin Activity Feed (`adminFeed.notify`, event `attendance.marked`,
   group 🕘 Attendance). The feed is the house chokepoint for "tell all
   admins", so each admin can switch this one off for their own phone:
   📊 Reporting → 🔔 Notifications → `🟢 ON  Employee marked attendance`.
   Default ON by the owner's word (every other T2-era event defaults OFF).
2. **Later — one holder.** Put that person's Telegram id in Settings
   `ATTENDANCE_NOTIFY_IDS` (a CSV; several ids allowed). From the next
   mark on, only those people are told and the admin pool is not. No
   deploy. Blank the cell to return to phase 1.

## Tests

- `test/unit/services/attendanceNotify.test.js` — the card (three lines,
  Lagos time, verification facts, on-behalf line, Markdown escape), the
  default audience through the real feed (both Railway admins, actor
  excluded), the Settings override (only those ids, feed bypassed, actor
  still excluded), nothing on a repeat / unconfirmed / empty mark, and the
  never-throws paths.
- `test/characterization/attendanceVerify.test.js` — the real controller:
  an employee's location+photo mark produces exactly one broadcast to the
  admin, in the receipt's words, and none to the employee.

## Later (owner's call)

- "Exceptions only" mode (late past the cutoff, unverified, on-behalf) if
  the morning gets noisy — a Settings switch, same card.
- The holder as a Users-sheet seat (a `department` value) instead of a
  Settings CSV, if the owner prefers names over ids there.
