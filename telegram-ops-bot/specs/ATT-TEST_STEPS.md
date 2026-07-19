# Attendance — first-round test steps (ATT-C3 + ATT-C4)

Hand this to any tester. Everything is done inside Telegram; no computer
needed. The tester needs: (a) an admin account for the setup part, (b) one
employee account that has a department assigned (any Sales/Dispatch member).

## A. One-time setup (admin, 5 minutes)

1. Open the bot → 🗓 Attendance (in the Human Resources hub).
2. Tap "🛡 Verification" → choose `location+photo`.
3. Tap "🗺 GPS Anchors" → tap a location you are physically AT (e.g.
   "Kano Office") → tap the "Share this place's position" button that
   appears near the keyboard. Expect: "✅ GPS anchor saved (radius 200 m)".
4. (Optional) Repeat step 3 for every real location. A location without an
   anchor still works but skips the distance check.

## B. Employee marking — the happy path

1. As the EMPLOYEE, tap 📍 Mark Attendance (or open it from the 09:00
   reminder message).
2. Pick the location you are at.
3. Tap "Share my position" when asked. Expect: "Position received ✅".
4. Send a photo taken RIGHT NOW (yourself at the shop / the shop front).
5. Expect the confirmation card: "Attendance Recorded — Marked Present",
   with "Position verified: … m from site" and "Photo attached".
6. VERIFY in the sheet: the Attendance tab's newest row shows your date,
   name, location, time, a geo value, a distance in metres, and a photo id.

## C. Cheating attempts — all of these MUST fail

1. **Wrong place:** stand far from the chosen location (or pick a location
   in another city) and share your position. Expect: "You appear to be
   X km away…" and NO row is written.
2. **Reused photo:** after one successful mark, have a SECOND employee try
   to mark using the SAME photo (forwarded to them). Expect: "That exact
   photo was already used for attendance today."
3. **Double marking:** mark successfully, then open 📍 Mark Attendance
   again. Expect: read-only "Already marked Present" card — no second row.
4. **Outsider:** a user with NO department and not on the required list
   opens the flow. Expect: "Attendance logging is not enabled…".

## D. The morning cycle (test across one real morning)

1. Before 09:00, make sure at least one department employee has NOT marked.
2. At 09:00 the unmarked employee should receive: "⏰ Good morning …
   mark your attendance before 09:30" with a Mark Attendance button.
   Employees who already marked get nothing.
3. Sunday: nobody gets the reminder (working days are Mon–Sat).
4. At 10:00 the admins' morning digest should show a "🕘 Attendance"
   line ("marked X/Y · N missing"); tapping it lists who is missing and
   who reported (with location + time).

## E. Admin conveniences

1. 🗓 Attendance → "📊 Today's Full View": present + missing lists match
   reality.
2. "✍️ Mark on Behalf": pick an unmarked employee + location. Expect the
   row to show "(via admin)" in reports and the employee's card to say
   "Marked by admin".
3. Reports hub → 📊 Attendance Report: 7-day / week / month tabs show the
   test days' coverage.

## Notes for the tester

- Verification mode can be flipped back to `none` any time (🛡 Verification)
  — marking becomes one tap again; nothing else changes.
- Known honest limits (by design, report anything WORSE): a fake-GPS app
  can defeat the location check; a fresh-looking gallery photo from an
  earlier day can pass the photo check. Same-day photo reuse must always
  be caught.

Report results per section (A–E) with screenshots of anything unexpected.
