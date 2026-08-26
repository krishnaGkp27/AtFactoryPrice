# TSK-V3 — Team Tasks: the admin chip list

Owner-approved layout, 26-Aug-2026 (PDF round: `Team_Tasks_Admin_Final.pdf`).
Replaces the old Team Tasks / Pending Sign-off text walls (a ~16-task team
rendered a 32-button pillar and silently died past Telegram's 4096-char cap).

## Locked decisions (owner)

1. **One tappable chip per task**; tapping opens that task's card, edited in
   place. Admin view only — the doer side (My Tasks) is untouched.
2. **Priority-first order**: 🔴 Critical → 🟠 High → 🟡 Normal → ⚪ Low.
   Inside a colour: tasks needing the ASSIGNER first (👉), then the
   longest-assigned. (Owner's ruling, overriding whose-move-first.)
3. **Hard cap 8 chips per page** — the message can never overflow.
   `⬅ Prev · Page x/y · Next ➡` pager; Prev/Next are no-ops (not hidden) at
   the edges so the row never jumps. Pager only appears with >1 page.
4. **Status fact FIRST on the chip** (phones cut button text at ~28 chars):
   `🔴 👉 accept 2d? · Office work`. Person names live on the Show filter
   row, never on chips.
5. Chip icon language: 👉 needs you · ⚠️ worker silent past the limit
   (`TASK_STALL_DAYS` Settings key, default 7, strictly greater-than) ·
   📨 waiting, inside the limit · ⌛ deal made, his final OK ·
   🔵 running (ends ~time for salaried, by date for incentivized).
6. Duplicate titles get the assigned date: `Catelog upload (11-May)`.
7. Card: status line (admin phrasing — "waiting on Abdul", never "waiting
   for you" meaning him), full description, only the buttons legal in the
   state. A proposal whose date passed says
   _"Accepting restarts his Nd from today."_
8. 🚫 Drop always confirms in place (Yes, drop / Keep — W-3/D-4); hidden on
   `submitted` (delivered work is approved or rejected, never dropped).
9. 🔔 Remind on stalls: ONE polite DM per task per Lagos day (in-memory
   dedupe — operational state, not a business record, §10).
10. ✅/❌ sign-off from the card re-renders the list with the task gone.
11. 🗂 Completed: same filter, verbatim titles, est→actual + date per line.
12. ⏳ Pending Sign-off = the same list pre-filtered to sign-offs.
13. Money-blind throughout (₦ appears only as a track marker, never an
    amount) — §16 / STK-PRIV unchanged.

## Mechanics

- List context `mode:filter:page` (mode o=open / d=completed / s=sign-off;
  filter `a` or a telegram id) rides in `callback_data`, never in a session:
  restarts and week-old messages cannot strand the pager, and two admins
  page independently. New `tsk:` sub-namespaces: `tp:` (list) `tt:` (card)
  `tpp:`/`tps:` (in-place priority) `tdd:` (drop w/ context) `sg:`
  (sign-off w/ context) `rmd:` (remind) — all dispatched BEFORE the
  assign-flow catch-all.
- Task pool = everyone the actor manages UNION everything they personally
  assigned (`getByAssignedBy`); a manager opening a task they didn't assign
  gets a 👁 view-only card.
- Legacy routes (`tsk:prio_pick/prio_set/drop_ask/sign:*`) stay live for
  cards already in chat histories.

## Tests

- `test/unit/flows/taskTeamList.test.js` — ctx parsing, chip facts, stall
  boundary, ordering, dup titles, page cap.
- `test/characterization/taskTeamRender.test.js` — real `handleCallback`,
  fake bot: capped page + pager, card behind a chip, sign-off returning to
  the list, remind dedupe, view-only, sign-off mode, completed view.
