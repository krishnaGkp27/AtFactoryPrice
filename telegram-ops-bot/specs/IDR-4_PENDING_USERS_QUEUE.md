# IDR-4 — 👋 Pending Users: the queue behind the stranger cards

Owner-approved layout, 27-Aug-2026 (PDF round: `Pending_Users_Layout.pdf`).

## The gap it closes

IDR-2/3 push ONE living DM card per stranger to admins, but nothing ever
listed the backlog — a scrolled-away card meant chat archaeology. And
placing a NEW person was three errands: register them in the right flow,
wait for approval, find the old card, link the account.

## Locked decisions (owner)

1. **👋 Pending Users tile** in the HR hub beside ➕ Add Employee.
   Admin-only (gated in `start()`, RPT-2 precedent).
2. **Queue = chips**, newest first, 8/page with the standard
   ⬅ Prev · Page x/y · Next ➡ pager. Chip grammar: fact first —
   🆕 inside 48 h, 📨 waiting, ⚠️ past 7 days — then name, then a snippet
   of their last message (from the IDR-3 living card; in-memory, so after
   a restart chips simply carry no snippet).
3. **Tap a chip → the triage card** anchored in place: identity, arrival
   time, the message log, and the doors. The five existing doors reuse
   the `pu:` handlers VERBATIM; 🚫 Ignore returns to the queue with the
   person gone; ⬅ Back returns to the queue page it came from.
4. **Two ➕ shortcuts** (the new part):
   - **➕ New customer** → CON-1's ONE Add-Contact door, kind pre-answered
     as Customer, name pre-filled from the Telegram profile, flow resumes
     at the phone step. Rides the existing add-contact approval.
   - **➕ New marketer** → the existing Register Marketer flow, the name
     fed exactly as if typed (✏️ Edit Name still available at review).
     Rides the existing dual-admin approval.
   Both carry `pendingTelegramId` in the queued actionJSON; the approval
   summary gains one line: "account will be linked on approval".
5. **Link-on-approval**: the `register_marketer` and `add_contact`
   executors bind the Telegram account (identityService.link) after their
   own write succeeds — approve = record active AND account linked, so
   the person's next tap lands on 📦 My Products / their linked surface.
   Best-effort: a register hiccup never un-approves; the result message
   says "⚠️ Telegram link failed — link them from 👋 Pending Users".
   If the approving admin re-routes an add-contact to the phonebook via
   the CNET-2 chips, the account is bound as a *contact* instead.
6. **🗂 Handled** — read-only audit: who arrived → what they became
   (📣/🤝/🕸/👔 + link name, or 🚫 ignored) + when. Derived entirely from
   the register's existing columns; no schema change anywhere.

## Mechanics

- New namespace `puq:` (queue) — `q:<page>` list · `h:<page>` handled ·
  `u:<page>:<tgid>` card · `ign:` · `nc:` · `nm:`; page context rides the
  callback_data. No collision with `pu:` (prefix match requires the colon).
- Flow module `src/flows/pendingUsersFlow.js`; the controller injects the
  CON-1 / Register-Marketer starters as deps so no registration logic is
  duplicated. `pendingUserService.liveMessages()` exposes the IDR-3 card
  log read-only.
- usageTracker: `puq:` → `pending_users`.

## Tests

- `test/characterization/pendingUsersQueueRender.test.js` — queue chips +
  aging + snippet, admin lock, card doors, ignore, handled, both ➕
  prefills, pager.
- `test/unit/services/pendingLinkOnApproval.test.js` — real executor by
  request id: marketer/customer link-on-approval, failure never
  un-approves, no phantom links without a pending account.
