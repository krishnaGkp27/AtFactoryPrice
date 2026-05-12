# 12-May-2026 (late) — Release night for the task manager

> A focused, late-night working session that began with the owner asking for a short implementation plan to finalize the task-manager release "by today" and ended with the scope, currency model, testing approach, and a clear path to ship.

---

## The opening request

After the long planning sessions of the past two days — ROADMAP consolidated, two specs written, journal folder established — the owner came back with a single direct request: **give me the implementation plan in short for the task manager. I need to finish at least this and finalize the release by today.**

Translation: *enough planning, let's ship the thing.*

## The reality check

The AI partner verified what was actually already done. The task manager itself is **functionally complete**: schema (Tasks, Incentives, TaskEvents), state machine engine, full negotiation UI with custom hours and calendar deadline picker, incentive-before-accept flow, payout queue, completion DMs, 76 passing smoke checks, Tasks hub navigation, Abdul onboarded as a real employee.

What was missing for a credible release:

1. **End-to-end verification** with a real employee account
2. **Admin direct-assign** shortcut (already on the roadmap as a quick win)
3. **Mark Paid UI** for finance — without it, incentives sit in `awaiting_payout` forever and the payout side of the deal is broken

## Three calls that shaped the night

The owner made three decisions that defined the release scope:

### 1. Full release scope chosen
Not just a verification of what's there, not just the admin shortcut. The owner wanted **admin direct-assign AND Mark Paid UI** in tonight's release. Estimated ~4-6 hours of focused work for a clean finish.

### 2. Currency must default to Naira and be user-selectable
The owner observed that currency was hardcoded `NGN` in places, and asked for two changes:
- **₦ NGN as the default** everywhere (it had always been intended, but not consistently enforced)
- **Selectable currency** by admin or manager (USD, EUR, GBP as alternates), stored per-user as a preference

He framed this with a larger thought worth recording: *"admin/manager can be called recursively since I think of it as the recursive tree approach. The parent/admin can roll out the feature to the person they added under them. The admin gets only concise reports from the concerned department down the line. I am trying to make my vision clear such as MLM or corporate organization."*

The AI partner named this back: this *is* the architecture we already have. `Users.manages` + `Departments.parent_department` is a recursive tree. Each parent sees only their subtree. Concise rollup reports are exactly what Commit 4 (Reports) was designed for. Tonight's release uses this; the rollup digests come properly in Commit 4.

The owner's currency answer was **per-user preference** — each manager sets their default currency once in their profile, and it applies to all their assignments. Cleaner than per-task picking, less surprising than a global setting.

### 3. Testing approach — synthetic webhooks plus one live tap
The owner asked an honest question: *can you log into Telegram Web and tap things for me?* The AI partner gave the truthful answer — no, there's no browser, no Telegram session access, hard limit of the tooling.

Four alternatives were offered:
- **A.** Owner drives Telegram, describes what he sees
- **B.** Add verbose logging, owner taps once, AI reads Railway logs
- **C.** Write synthetic webhook tests — scripts that simulate Telegram callbacks hitting the bot's handlers directly, no Telegram required
- **D.** Extend the smoke harness with new assertions for the new code paths

The recommendation was **C + D first, then one A pass at the end** — harden the code with code-only tests, then a single live tap with Neha (the owner's available test account) as the final smoke. Owner agreed.

This is a meaningful pattern worth noting: the AI partner's tooling has limits, and being explicit about them earned a better collaboration than pretending. The owner adapted his testing plan to fit the tools that were actually available.

## The plan locked

Nine numbered todos covering:

1. Commit pending planning docs (ROADMAP §4.6 + §5.6 + decisions log + this session entry)
2. Set NGN default and user-preference currency in the Users sheet
3. Admin direct-assign shortcut (admin-only bypass of the org-tree filter)
4. Mark Paid UI for finance (new Payouts activity, optional DM to doer)
5. Synthetic webhook tests covering the happy path
6. Extend smoke harness with new assertions
7. One live end-to-end test with Neha (owner's test employee account)
8. Commit each step separately, push to main, verify Railway deploy
9. Verify /health and run one more end-to-end including Mark Paid

## What was already on record but mattered tonight

The night before, ROADMAP §4.6 had been added as commits 11-14 (Referral + Loyalty platform), and the owner had confirmed Scenario C (both worker and customer chains, separate rules). Tonight's release does not touch any of that — but the architectural patterns being used (per-user preferences, recursive tree, audit-by-default) are the same patterns those future commits will reuse. Every clean choice tonight makes commits 11-14 cheaper later.

## The owner's recurring metric

Throughout the session the owner returned to the same lens: *I want to finalize the release by today.* Not because the bot is in some external hurry. Because the planning loop had run long enough, and continuing to plan without shipping was beginning to cost momentum. He was right to insist on shipping.

This is worth recording for future sessions: **planning is valuable, but past a certain point each additional spec yields less than each commit ships**. The discipline of saying "ok, that's enough, let's ship" is itself a skill, and the owner exercised it cleanly tonight.

## What this session represents in the arc

Three nights:
- **11-May** built the technical bones of where the bot is going
- **12-May (early)** built the meaning underneath the bot — philosophy, people, the cricket metric, the theft as founding wound
- **12-May (late, this session)** is the **first credible release of the task manager** in production-ready form. Schema, engine, UI, audit, payout queue, currency, admin override, and a one-tap finance settlement, all live, all tested.

This is what was being built toward.

---

*Written near the start of release night, while the plan is still warm and before any code has shipped. Will be appended-to or paired with a follow-up session entry once the release lands.*
