# APC-1 — Approval concurrency: per-request wizards, in-place cards

**Status: DESIGN AGREED (owner, 08-Aug-2026) — build not started.**
Owner's report: processing one approval while another arrives is "a
complete mess" — starting the second kills or cross-wires the first.
Owner chose the **parallel model** ("go with the recommendation because it
gets aligned with the approval chips more than a manual typing") and
extended scope to **ALL approval wizards**: transfer, return, sale, all
finance approval/disbursal, payment requests, and the rest.

## Root causes (verified in code, 08-Aug survey)

1. **One wizard slot per admin.** The sale enrichment wizard lives in
   `pendingEnrichment`, a Map keyed by adminId only
   (`approvalEvents.js:31`, set unconditionally at `:424`). A second
   ✅ Approve mid-wizard silently discards the first wizard's progress.
2. **Chips don't carry the request.** `enr:*` payloads have no requestId
   (`enr:rate:v`, `enr:pay:b:0`, index-only customer chips), resolved
   solely by `pendingEnrichment.get(adminId)` (`:541`) — a chip tapped on
   request A's still-live card acts on request B's wizard, and a customer
   picked while looking at A persists onto **B's queue row**
   (`updateActionJSON` at `:398`).
3. **Typed replies route to "whatever is newest".**
   `handleEnrichmentMessage` keys purely off the sender (`:660`). Same
   for the reject-reason channel: `pendingReason` is one slot per user
   shared by supply Stage-1 reject and Stage-3 decline (`:38`, set at
   `:1149`/`:2143`) — tap ❌ on two cards before typing and the first
   request is stranded with its buttons already wiped.
4. **Transfer dispatcher wizard = same shape in sessionStore.** One
   session per user (`sessionStore.js:20,123`): a second ✅ Accept wipes
   transfer A's ticked bales; picker chips `trf:bl:*` carry indexes, not
   the requestId, so A's stale card ticks bales into B's session; the
   photo gate (`await_doc`) always feeds the **newest** session — the
   older transfer silently never dispatches/receives.
5. **Inbox index staleness.** `abx:ok/no:<idx>` index into a snapshot
   array that is rewritten on every list render
   (`approvalsInboxFlow.js:432,639`) — a leftover card can resolve its
   index against the NEW array and approve a different still-pending
   request.
6. **No TTL on the wizard Maps** — an abandoned wizard swallows any bare
   number the admin types later (numeric text matches the rate step), and
   a restart drops everything except the persisted customer pick.
7. Minor guards missing: `srf_assign:` has no stage/status guard (a stale
   picker can re-assign a resolved supply request); legacy
   `approve_task:` flips status with no state check.

Safe already (per-request id in the payload + live-row guards): plain
approve/reject cards, apz:done, TRF-18 admin review (requestId + package
token — the model to copy), receiver Reject, task sign-off (tsk:),
receipt rcapr:/rcrej:, orders oacc:/odel:, supply accept, new-customer
approval.

## Locked decisions (owner, 08-Aug-2026)

1. **Scope = every approval wizard**, not just sales.
2. **Parallel model** — multiple wizards may be open at once, each safe:
   - **Per-request state**: wizard memory keyed `adminId|requestId`
     (never adminId alone); reason prompts likewise.
   - **Chips carry the requestId** in every payload (64-byte budget:
     short ids like `R-9CEB` fit alongside step tokens).
   - **In-place editing**: the approval card IS the wizard — every step
     edits the same message's text + keyboard; no step-message flood.
     Every step shows the request header (id · goods · requester) so the
     admin always knows which request they are inside.
   - **Chips-first** (owner: aligns with chips more than manual typing);
     typing stays available at every step.
3. **Typed input rule**: a typed reply applies to the **last-touched**
   wizard; the active card says so on its step line. If more than one
   wizard is open and none was touched recently, the bot ASKS which
   request the text belongs to (chips) — it never guesses (§2).
4. **Media inputs (photo / PDF / Excel) — owner prefers documents as the
   primary input wherever a number is expected**, with the number always
   present behind it:
   - Any wizard step that expects a figure also accepts a photo/PDF/
     spreadsheet. The bot parses/OCRs it, shows the extracted figure(s)
     as **confirm chips** next to the document, and only a human-
     confirmed number is booked. The file itself is archived as evidence
     linked to the request (existing Drive + file_id patterns). OCR is
     never auto-booked (house rule; VRF-1/P5/SNAP-1 posture).
   - **Attach steps are per-request gates that can wait.** "Get ready
     with the PDF" stops being a problem: a card sits at its attach step
     indefinitely while the person prepares the file — other approvals
     proceed in parallel; nothing expires; the queue row stays pending.
   - A media reply follows the same routing rule as typed text: it goes
     to the last-touched card awaiting media; **two open attach gates →
     the bot asks which request the file is for** (chips), never guesses.
5. **Restart-proof resume**: each wizard answer persists to the queue
   row's actionJSON as it is given (the customer pick already does —
   extend to rate/payment/amount and the other wizards' steps). Any card
   offers ▶ Resume that rebuilds state from the row after a redeploy,
   an expiry, or a long gap.
6. **Nothing about starting/abandoning a wizard may mutate another
   request.** Cross-request writes like the `:398` customer persistence
   must be impossible by construction (state carries its own requestId;
   writes always target the state's request).

## Build phases (order confirmed with owner before each build)

- **A — sale enrichment wizard** (bit the owner daily): per-request
  store + requestId chips + in-place card + progressive persistence +
  TTL with harmless expiry (card gains ▶ Resume).
- **B — reason prompts**: per-request, shared-channel split, typed-reply
  disambiguation when two prompts are open.
- **C — transfer dispatcher wizard + photo gates**: per-request picker
  state, requestId in `trf:bl:*`, per-request attach gates with
  ask-when-ambiguous.
- **D — inbox `abx:ok/no` carry requestId (not index); `srf_assign:`
  stage guard; legacy `approve_task:` guard or retirement.
- **E — media-first steps**: the shared attach→parse→confirm component,
  then enable per step (amount-paid accepts receipt photo; rate accepts
  a drafted sheet; EXP-1 expense entry reuses the same component).

Full 08-Aug survey (16 decision surfaces, 4 state containers, 13 media
intake points, file:line evidence) lives in the session record; the root
causes above are its distilled, verified core.

## Open items

- Priority slot vs EXP-1 (owner to confirm; APC-1 affects today's daily
  workflow, EXP-1 is the declared next build — currently listed right
  after EXP-1).
- Per-surface step layouts are confirmed with the owner at each phase,
  same as every flow build.
