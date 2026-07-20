# Web dashboard login (magic link) — first-round test steps (ANA-1a)

Hand this to any tester. Needs: an ADMIN account, a MANAGER account
(Users sheet row with role `manager`, at least one department, and at
least one warehouse — e.g. a Kano manager), and an EMPLOYEE account.
Prerequisite: `BASE_URL` must be set on the server (if it isn't, the
bot tile says so — report that and stop).

## A. Admin login — the happy path

1. As ADMIN, send "hi" → Reporting hub → tap "📊 Dashboard (web)".
2. Expect a DM: "Your dashboard login" with an Open Dashboard button and
   the warning that the link works ONCE and expires in 5 minutes.
3. Tap it. Expect the browser to open the Ops Dashboard ALREADY signed
   in — **FAIL if the "Connect to the bot" key-paste screen appears.**
4. All four tabs populate: Overview tiles, Approvals, Attendance,
   Stock audits.

## B. The link is single-use and short-lived

1. Tap the SAME link button again (or reopen the URL from history).
   Expect the "Link expired — login links work once" page.
2. Mint a fresh link, wait 6+ minutes WITHOUT opening it, then open it.
   Expect the same expired page.
3. Forward an (unused) link message to another chat and open it from
   there quickly — it will work (it's a bearer link): confirm the DM's
   "don't forward it" warning is present. This is why links die in 5
   minutes and only work once.

## C. Manager login — scoping (the owner's rule)

1. As the MANAGER (e.g. Sales dept, Kano warehouse), tap the tile and
   log in.
2. Attendance tab: ONLY people from the manager's own department(s)
   appear — **FAIL if staff from other departments are listed.**
3. Stock audits tab: ONLY the manager's own warehouses' audits appear
   (the Kano manager sees Kano rows, never IDUMOTA).
4. Approvals tab: stays empty for managers (oversight is admin-only —
   the API refuses; there must be no approval data visible).
5. Overview: the attendance tile counts only their department's people.

## D. Employee is refused

1. As EMPLOYEE, tap "📊 Dashboard (web)" (or forge the act callback).
2. Expect: "The web dashboard is for admins and managers." No link.

## E. Session behavior

1. A login lasts ~12 hours: close and reopen the browser within that
   window — still signed in, no new link needed.
2. Visit `<BASE_URL>/auth/logout` — you are signed out; reopening /ops
   shows the key-paste screen (no session). Tap the bot tile to get back
   in.
3. Known behavior, not a bug: after the server redeploys, web sessions
   reset — tapping the bot tile again is the fix (sessions move to the
   database once PG-1 is configured).

## F. Fallback path still works

1. In a private/incognito window (no session), open /ops. The key-paste
   screen appears; pasting the BOT_API_KEY still works (this path stays
   for server-to-server and emergency use).

## What to report

Results per section A–F with screenshots — especially ANY case where a
manager sees another department's people or another region's warehouses
(section C is the security heart of this feature), or where a used or
stale link still logs someone in (section B).
