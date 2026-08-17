# RMV-1 — removing a person, behind two admins

**Status: Phase A SHIPPED 16-Aug-2026 (`ee6828a`); Phase B CORE SHIPPED
16-Aug-2026 (`5dfca04`) — actions, policy (all three lists), executor
(both registers move together), card, employee guards, tests. PAUSED
17-Aug-2026 by owner ("push it to the to-dos, less priority") with ONE
piece open: the tile.** Locked from the owner's decisions on the removal
impact analysis, 16-Aug-2026: "I can see these problems can be curbed
with the recommendation which you put in the file. Please go ahead with
the recommendation."

## Open when resumed (in order)

1. **The customer-removal tile** — `remove_customer`/`restore_customer`
   work end to end but nothing in Telegram raises one yet. Build: a
   ➖ Remove Contact door (CRM hub, CON-1's shape: pick person → reason →
   card enriched with outstanding/supply-count/children → queue), one
   `act:` case + one prefix dispatch block in the controller (surgical —
   **needs the owner's explicit go on the controller edit**, rule 2).
2. Attendance/auth status divergence (small): `attendanceService`
   compares `status`/`role` with exact `===` while `middlewares/auth.js`
   normalises since `ee6828a` — a Users cell reading `Active` keeps bot
   access but silently drops off the attendance roster. Normalise
   `getAudience` the same way.
3. Phase C (each independent): web-session revoke-by-user; `/sl/` and
   `/i/` link kill paths; the three zero-approval side doors; the Drive
   public-upload exposure.

Source: the 8-subsystem impact analysis of 16-Aug-2026 (250 references,
6 claims refuted on adversarial review, 3 confirmed by running the code).

## The owner's locked decisions

| # | Decision | Ruling |
|---|---|---|
| 1 | PAY-1 dual-admin gap | Fix immediately — shipped `9ce6a48` |
| 2 | Which word means removed | Reuse `inactive`; reason goes elsewhere, never in the status cell |
| 3 | Reversible? | **Yes** — a two-admin Restore beside Remove |
| 4 | Outstanding balance | **Warn** on the card, never block |
| 5 | Scope | Phase A + Phase B |

## Phase A — SHIPPED

Made `inactive` mean one thing across the four hide-rules that disagreed;
closed the phone block, the history-derived chips, the cold-customer
alert and the auth case-sensitivity; stopped the Deactivate card
promising a revocation it cannot deliver. See §14 of BUSINESS_RULES.

## Phase B — the door

### Shape

**Customers/contacts get a removal door; employees keep theirs.** There is
no second employee door — `deactivate_user` already exists and stays the
only one, upgraded rather than duplicated (owner's standing rule: never
two things doing the same job). CON-1 put one door on the way in; this
puts one door on the way out, per entity class.

### Actions

Three, each in **`WRITE_ACTIONS` + `ALWAYS_APPROVAL_ACTIONS` +
`DUAL_ADMIN_ACTIONS`** — all three lists. Membership of the first two
alone yields a single tap; that was the PAY-1 defect and §14 now forbids
repeating it.

| Action | Does |
|---|---|
| `remove_customer` | Customers row → `inactive`, **and** the bound Contacts node → `inactive` |
| `restore_customer` | Both back to active — decision 3 |
| `deactivate_user` | *existing action, added to `DUAL_ADMIN_ACTIONS`* |

Both registers move together, always. CON-1 made a customer exist in the
Customers sheet **and** as a bound node; a removal that flipped only one
would re-open the split-brain from the other side.

### The card

`buildRemoveCustomerCard` — CARD-3 grammar, a line only when it has
something to say:

- name · customer_id · phone · category
- **Outstanding balance**, badged when non-zero (decision 4: disclose,
  never gate)
- supplies on record (count + last date) — proof history survives
- network children, if any — who is left dangling
- the requester's reason (required; free text)

### Guards

- **Idempotent, loudly.** Removing an already-inactive customer fails with
  a message, never a silent no-op approval (the CUS-2 fail-loud rule).
- **Employees: last-admin and self-target guards.** Neither exists today —
  `_eligibleUsers` deliberately returns admins and the executor checks
  only "not found" / "already inactive". Two admins must not be able to
  strand the business with no admin, and nobody removes themselves.
- **Notify the target.** Today only `add_user` DMs the person. A removal
  is the one event they most need to hear about.

### Reason and audit — no schema change

The reason rides the ApprovalQueue `actionJSON` (permanent) and an
`AuditLog` row. **No new column**: §14 keeps the status cell as machinery,
and CLAUDE.md rule 4 keeps new columns at the end of a range only. The
Customers `notes` cell gets a short dated stamp so a human reading the
sheet knows why.

### What the card must SAY, because the bot cannot do it

For an employee held in a Railway variable, the flip revokes nothing.
Phase A already made the Deactivate card name the exact variables. The
same honesty applies anywhere a removal implies access.

## Explicitly OUT of Phase B

Phase C, each independently useful, none blocking B:

- revoke-by-user for the 12-hour web dashboard session (survives redeploy)
- kill paths for `/sl/` supply-ledger and `/i/` invoice links
- the three zero-approval side doors (Change Role, Assign Departments,
  `scripts/onboard-employee.js`) that can achieve a removal's effect with
  one admin and no audit row
- the Drive exposure: every upload is stamped public-to-anyone, filenames
  carry the person's name, and there is no unshare or delete

## Tests

- all three actions require two taps from an employee requester, one from
  an admin requester — asserting `requiredAdminApprovals`, never list
  membership (the PAY-1 lesson)
- approval flips **both** registers; the node stays bound
- removing an already-removed customer fails loud, request stays pending
- restore returns both registers to active
- a removed customer disappears from pickers, name lookup and history
  chips, while the Inventory sold rows are unchanged
- outstanding balance appears on the card and does **not** block
- self-target and last-admin guards refuse

## Gate

`npm test` + `npm run smoke` + `npm run lint` 0 errors → one commit →
ff-push `main`. §14 of BUSINESS_RULES is already landed.
