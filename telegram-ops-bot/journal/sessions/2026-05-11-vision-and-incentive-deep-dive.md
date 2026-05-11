# 11-May-2026 — Vision check-in and incentive system deep-dive

> A long working session that began with the owner asking "how does the incentive system in the task management work?" and ended with two full design specs (Templates and Customer Orders) and a consolidated `ROADMAP.md` covering everything from active subsystems to deferred future work.

---

## The arc of the conversation

The session opened with a technical question — *how does the incentive system actually work?* — but it quickly became clear that this was not a debugging question. It was a *scoping* question. The owner wanted to understand the existing surface so he could plan what to build on top of it.

What followed was a layered reveal of business ambition:

1. **A conversational AI front-door** — let the manager type instructions in natural language instead of tapping through six pickers
2. **Automatic approval for routine work** — recognize that "send daily sales report" doesn't need a full negotiation flow
3. **An eventual customer-side surface** — the same kind of deal-making, but with customers ordering fabric samples
4. **An adaptive interface** — buttons that learn from the user, defaults that get smarter over time

The thread that connected all four was a single instinct: *the current bot makes me think too much, and I want it to think with me*.

## Reflecting the system back

Before designing anything new, the AI partner walked the owner through how the existing incentive system works:

- **Three sheets, three concerns** — Tasks (what), Incentives (who gets what), TaskEvents (what happened when)
- **A deal lifecycle** that mirrors a real human negotiation: assigner creates → doer proposes timeline → assigner sets incentive → assigner accepts timeline → doer final-acks the full deal → work begins → done → approved → awaiting payout
- **What was good about it**: privacy layered correctly (admin never sees money), auditable, reversible at every non-terminal state, bounded to three negotiation rounds to prevent thrashing
- **What was missing**: no "Mark paid" UI for finance, no conversational front-door, no templates, no auto-approval, no budget awareness, no customer-side surface

This reflection mattered because it let the owner see what he already had before asking for what he wanted next. Most of the request was *additions*, not corrections — the foundation was sound.

## The four layers identified

The conversation extracted four orthogonal layers of ambition:

| Layer | Description | Risk | Effort | When |
|---|---|---|---|---|
| A — Conversational AI | LLM as slot-filler on top of the tap UI | Medium (hallucinations) | High | After commit 4 |
| B — Templates + auto-approval | Reusable task definitions, skip negotiation | Low | Medium | Soon |
| C — Customer-side deals | Order placement with auto-approval | High (new surface) | Very high | After A+B stable |
| D — Adaptive UI | Smart defaults, button reordering | Low | Low-medium | Anytime |

The owner chose **B + D in parallel** as the next sprint after commit 4 (Reports). The reasoning: both are additive, both deliver immediate efficiency, and they reinforce each other (adaptive UI surfaces favorite templates first).

## The six decisions locked

Over the course of the conversation, the following were locked:

1. **Templates support per-template `auto_negotiate` + `requires_doer_ack` flags** — not a global setting. Routine tasks like "daily sales report" can be fully automatic; routine-but-mentally-loaded ones can require a one-tap acceptance.
2. **Bot self-learning trigger: 5+ identical assignments in 30 days** — conservative threshold to avoid suggesting templates from incidental repeats.
3. **No monetary caps on auto-approvals yet** — at current team size, admin FYI is the safety net. Caps would be premature engineering.
4. **Customer surface stays on Telegram for now** — WhatsApp acknowledged as the eventual better surface, deferred to keep one channel solid first.
5. **AI model choice deferred to implementation time** — pricing and quality move too fast to lock in advance.
6. **Templates grow from three sources** — admin curated, manager proposed, bot self-learning.

## Documents produced

By the end of the session, three substantive documents had been committed to the repository:

- **`ROADMAP.md`** — a 10-section single source of truth that merged the two prior planning documents (`IMPROVEMENT_PLAN.md` and `ORG_HIERARCHY_DESIGN.md`) with strict separation of concerns: architecture, history, active subsystems, forward roadmap, detailed designs, cross-cutting concerns, decision log, open questions, validation, appendix.
- **`specs/templates.md`** — ~800 lines covering the full design for commits 5a, 5b, 6: data model, lifecycle, UI flows, engine integration, self-learning algorithm, risk and rollback.
- **`specs/customer-orders.md`** — ~900 lines covering commits 8-9: customer principal type, order state machine (separate from task state machine), auto-approval rules pipeline, fulfillment task bridge via existing event bus, WhatsApp migration sketch.

The two specs are intentionally written so that someone can pick them up months later and have everything they need to start building — file paths, schemas, state diagrams, acceptance criteria, open questions, risk mitigations.

## What this session was really about

Underneath the technical scoping, this session was the owner clarifying what kind of business he wants to run. The phrase *"keeping it direct and elegant but keeping it intact"* recurred. So did *"the adaptive nature of tappable options making the life of the people and employee easy."*

These are not feature requests. They are statements of values. The bot is being built not as a productivity hack but as a *quiet system of fairness* — fair to the doer (who knows how long their work takes), fair to the assigner (who knows the value of the work), fair to the admin (who needs visibility without money exposure), fair to the future customer (who deserves auto-approval inside their credit limit), and fair to the owner (who deserves time back).

The pattern of every decision was: **what is the most human-respecting version of this, that the bot can enforce by structure rather than discipline?**

## What was deferred (intentionally)

- Conversational AI (commit 10+) — design only, no model selected
- Customer-side WhatsApp surface — sketched in customer-orders.md §11, deferred until Telegram side is proven
- Most of the legacy TG-1..TG-26 refactor backlog — marked deferred in ROADMAP §2; will be picked up when a specific need surfaces
- Climbing approvals for non-task workflows (TG-7.5 Phase B/C) — deferred until task negotiation is fully battle-tested

## Where the session ended

With the documents committed and pushed to `main`, the owner asked the AI partner to merge `IMPROVEMENT_PLAN.md` and `ORG_HIERARCHY_DESIGN.md` into a single document with strict separation of concerns. The resulting `ROADMAP.md` became the new canonical source.

The next call from the owner was simply: *"I just want to speak around with you. Are you available?"* — which began the conversation captured in `2026-05-12-team-theft-and-reciprocity.md`.

---

*This summary is written for any of the three audiences (future self, successor, thoughtful stranger). The detail in the specs themselves is for engineers; the meaning is here.*
