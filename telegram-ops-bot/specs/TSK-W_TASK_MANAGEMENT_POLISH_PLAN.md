# TSK-W — Task management polish: the plan

**Status:** proposal for the owner. No implementation. Nothing here changes the
approval pipeline's internal design.
**Researched:** 01-Sep-2026, 16 agents over taskFlow, taskStateMachine, snapTask,
gantt/web, identity, approvals, money and nudges; three competing plans scored by
three judges; two adversarial critics (completeness + locked-rule).

---

## 0. The finding that reorders everything

**The task engine is already built, and it is good.** `Tasks` carries a `track`
column (`salaried` | `incentivized`), `taskStateMachine.js` is a real funnel with
10 statuses, actor-role enforcement, a 3-round negotiation cap and an append-only
`TaskEvents` row per change. There is a finance-quarantined `Incentives` sheet, a
Payouts queue, TRM-1 armed reminders riding the existing dual-admin pipeline, an
hourly nudge sweep with a durable once-per-day guard, and a Gantt web page.

**Two live defects make most of that unreachable:**

1. **Every bonus in production is ₦0.** `incentivesRepository.setAmount` has
   exactly one call site (`taskFlow.js:1331`), inside a session
   (`task_incentive_flow`) whose typed input the controller never routes —
   `telegramController.js:4148` routes text only for `task_assign_flow`. The
   only other way through is the Skip button, which hard-codes 0. So the
   incentivized track has never paid a naira, and the [✅ Accept] button on an
   incentivized task in Team Tasks is a dead end.
2. **Sheet-promoted admins are locked out of every task action.**
   `taskStateMachine.js:309` has a private `isAdmin()` reading only env
   `config.access.adminIds`, while every UI gate uses `auth.isAdmin` (env **∪**
   active Users rows with `role='admin'`). So a sheet-promoted admin is shown
   buttons and gets a raw `NotActor: event=assigner_approved...` when he taps
   them. Two lines.

So this is a **polish-and-connect** job, not a build job. The plan below fixes
the words, the gates and the visibility before it builds anything new.

---

## 1. The two paths, in the owner's words

Today's vocabulary is the office's, not the warehouse's. Proposed plain words —
**owner's call on the exact wording**:

| Internal | Card says today | Proposed |
|---|---|---|
| `track: salaried` | "Salaried" | **📋 Normal job** — you give the time, you do the work |
| `track: incentivized` | "Incentivized" | **💰 Bonus job** — finish it and there is money on it |

**Normal job (salaried) — 3 taps, and it already works end to end:**
new job DM → [⏱ How long do you need?] → tap one time chip → the clock starts on
that same tap → [✅ I finished] → boss checks → done. No deadline is ever stored;
the finish is computed at read time from `started_at + proposed_hours`.

**Bonus job (incentivized) — 6 taps, and it is broken at tap 4:**
new job DM → time chip → **deadline** chip or mini-calendar → boss accepts or
counters (max 3 rounds) → **boss sets the ₦ amount ← DEAD, always ₦0** → worker
accepts the deal → clock starts.

---

## 2. The split, unchanged

> **Telegram is where work is DECIDED. The web is where work is SEEN.**

This is already `BUSINESS_RULES §15` ("The web DISPLAYS; Telegram DECIDES… There
is no approve/reject endpoint in the ops API and there must not be") and the code
enforces it: the whole state machine has exactly one door, `taskFlow.handleCallback`
behind the `tsk:` prefix. **No phase below adds a task write endpoint.**

The web earns its place on the three things a phone card cannot hold: **time
spans** (a week, a month), **totals and history**, and **comparison across people**.

---

## 3. The phases, in order

Each is independently shippable; phase 1 alone is worth having. Effort S/M/L.

| # | Phase | Surface | Effort | What it kills |
|---|---|---|---|---|
| **W1** | **One vocabulary, said once** | bot | S | Words only, zero logic. Time chips read `1 hr / 4 hrs / 1 day / 1 week`, not `1h/1w`. Track names become the owner's words. The assign confirmation stops promising a negotiation the *default* track does not have. The drop card stops naming a button that does not exist. The clock-started card gets a real footer (⬅ back / 🏠 menu) instead of one lone button. **One wave, one broadcast** — never spread across releases (§15 protects muscle memory). |
| **W2** | **Let promoted admins tap what they are shown** | backend | S | The two-line `auth.isAdmin` swap. Highest value-per-line in the whole map. |
| **W3** | **The bonus becomes a real number** | bot | M | ₦ chips replace the unreachable typed step (`INCENTIVE_CHIPS_NGN` Settings key); the dead [✅ Accept] is un-killed; the three orphaned typed handlers are **deleted, not routed** — so the parked controller is never touched. ⚠️ **Blocked on decision D1.** |
| **W4** | **"Am I late?" — one fact, computed once** | bot | M | Lateness exists in **four** separate implementations today (`taskFlow:826`, `apiController:1005`, `morningDigest:32`, `taskReminderService:182`). Collapse to ONE exported helper, then show it where it was never shown: **on the worker's own chip**, so he learns he is late before anyone shouts. Salaried work has no lateness signal anywhere today. Stays derived at read time (§10 — never stamped into a cell). |
| **W5** | **Say why, in chips** | bot | M | Send-back carries **no reason at all** today. Reason chips on send-back / decline / drop, plus **[🖐 I am stuck]** — and "waiting for someone" opens the person picker and nudges *that* person, turning a complaint into a routed request. Reasons are already written to `TaskEvents.meta_json`; `getByTaskId` reads them back for free — no schema change. |
| **W6** | **My Tasks shows all of them** | bot | M | Silent truncation at 9 with no pager and no route to the rest. Plus the **5-minute card death** (`sessionStore` TTL) that punishes a worker for walking across the warehouse to do the work the card told him to do. Plus a **track-aware month line** — see §4. |
| **W7** | **Fewer tiles to learn** | bot | S | ⏳ Pending Sign-off is `showTeamTasks` with a mode pre-set. Merge it in as a filter chip: one tile, one activity code and one controller case *removed*. A rare net subtraction. |
| **W8** | **Knobs, not code** | sheet | S | Page sizes, negotiation rounds, calendar months, session TTL, stall days, chip ladders → `settingsRepository.DEFAULTS` with sheet override. |
| **W9** | **Open the work plan to the people it charts** | web | L | Managers are handed a button that always fails *and lies about why*; the production page still ships a DEMO switcher; every open tab issues two uncached Sheets reads every 15s forever. ⚠️ **Blocked on decision D3.** |
| **W10** | **Pay the bonus like money** | bot | M | Today ✅ Mark paid is **one finance tap writing three cells** — no dual approval, no registered account, no proof, no reversal. ⚠️ **Entirely decision D2/D6.** |

---

## 4. What the salaried majority gets (the thing all three drafts missed)

Every "what am I owed" surface is incentive-only — so for the **default track,
which is most of the crew, it renders permanently blank.** A salaried man opening
his money card would see zeroes forever and conclude the system thinks he is worth
nothing.

Same card, one branch on `track`:

- **Bonus job worker:** `💰 Waiting for you: ₦22,000 (3 jobs) · ✅ Paid this month: ₦45,000`
- **Normal job worker:** `📋 This month — 18 jobs finished · 96 hours you gave · 15 finished on time`

That last line is the salaried man's earnings statement, and it is computed from
data already on the sheet.

---

## 5. Decisions only you can make

These block the phases named. Everything else I can carry.

| # | Decision | Why it is yours | My recommendation |
|---|---|---|---|
| **D1** | **Does setting a bonus need dual-admin approval?** | `BUSINESS_RULES §13`, your words: *"All the financially related transactions go through Dual Admin for now. This includes the first one."* Today's ₦0 bug makes the single-signature path **inert**; W3 makes it live money. | **Yes** — a new `set_task_incentive` action code through the existing pipeline. It needs your sign-off (rule 3). |
| **D2** | **How does a finished bonus job become cash?** | §13's self-only clause: a person raises payment **for themselves only**. So finance *cannot* raise a payment into a worker's account. | The **worker** taps [🏦 Ask for payment] on his own card and it enters the shipped PAY-1 flow as a self-raise carrying the task id. Compliant, and it inherits two signatures + the registered account + PAY-ID. |
| **D3** | **Can an ordinary worker hold a web session at all?** | Today `web_dashboard` refuses anyone not admin/manager, and `webSessionService` mints **only** those two roles — it coerces everything else to `manager`. This is an auth-surface change, not a branch. | Decide the principle first. If yes: a real third `worker` role, refused for field roles and for customer/marketer links (§16's one-surface fence). |
| **D4** | **Do your warehouse staff read English?** | There is no i18n anywhere in the codebase; every label is a hardcoded English string. The best-designed screen you have is the time chart — precisely because `4h` is a numeral plus one letter and works **without being read**. | If the answer is "not really", the fix is not translation: it is making every chip survive not being read — unique leading emoji, numerals, fixed position. |
| **D5** | **Does salaried "1 day" / "1 week" mean calendar or working time?** | Today `1w` adds **168 raw wall-clock hours**, so a Friday commitment is judged against Sunday. | Working time, with warehouse hours in Settings. |
| **D6** | **Is an outcome bonus to an *employee* allowed?** | §16 makes commission the marketer's thing and marketers explicitly *not* part of the company. A per-task bonus is not a percentage of a sale, so it is genuinely ambiguous — and W3 makes it real money for the first time. | Rule it one line either way, and I add it to §16 in the same change. |
| **D7** | **`TaskEvents` lives in Google Sheets, against storage rule 5b.** | Pre-existing, and load-bearing: TRM-1's once-per-day reminder guard depends on it surviving redeploys. Every phase above deepens it. | Either grant a written carve-out in BUSINESS_RULES, or plan its move to Postgres — but stop claiming 5b is satisfied. |

---

## 6. Deliberately NOT in the plan

- **Batch approve ("approve all N shown")** — it industrialises D-4, your stated
  top danger. The identity-line half of that idea (one `identityLine()` feeding
  all three approval renderers so two rows can never look identical) is worth
  doing on its own, and is a pure renderer fix.
- **Reassignment / "give to someone else"** — genuinely needed, but
  `Tasks.assigned_to` is write-once today and `Incentives` has **no doer column**:
  the payee is *derived* by joining back to the task. Move the task and a settled
  bonus silently follows to a new payee. Stamp the doer onto the Incentives row
  **first**, then reassignment is safe.
- **Bulk / repeat / template tasks** — rule 2 forbids pre-ticked chips *anywhere*.
  Buildable, but every chip must open unticked.
- **A `blocked` status** — 🖐 I am stuck should be a note plus a routed nudge, not
  an 11th status. A status means a transition-table edit and a new fact on every
  surface.

## 7. Known edges worth a later phase

Proof of completion (a worker cannot attach a photo of finished work, while PAY-1
asks for a bill photo); disputes are unbounded (haggling over *hours* is capped at
3 rounds, arguing about whether work *happened* is not); attendance and tasks have
never heard of each other (a task can be assigned to a man on leave and the sweep
will nudge him on his day off); multi-day work is silent until it is already late.

---

## 8. Testing discipline (non-negotiable for every phase)

`taskFlow.js` has 55 passing tests and the salaried track still shipped crashing —
commit `be157cab`'s own message says why: *"not one of them ever drew a card."*
No test in `test/**` drives a typed task step through the real controller, which is
exactly why the ₦0 bonus defect shipped green. **Every phase adds a
`controllerHarness` characterization test that renders the card, not a
state-machine assertion.**
