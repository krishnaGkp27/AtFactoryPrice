# Decisions — the business reasoning behind the build

> A record of *business* decisions, separate from technical ones. ROADMAP §7 captures technical decisions (state machine shape, schema choices, etc.). This file captures the *why* in human terms — what business reality made us choose what we chose.

> Ordered reverse-chronologically. Newest at the top. Append-only.

---

## 2026-05-12 · Theft becomes the founding wound, not a feature request

A theft of goods early in the business cost not only the goods but the entire profit margin of the design they were part of. That loss reframed everything. The bot is not a productivity tool; it is a *records system that happens to also help with productivity*. Audit-by-default — every inventory movement, payment, sample, return logged with actor and timestamp — is the floor, not the ceiling. Every commit must protect or extend this floor.

This decision elevates the planned `StockMovements`-style audit layer from "nice to have" to "non-negotiable". It also explains why the bot's Telegram-first design matters: the moment of action and the moment of recording must be the same moment, with no gap for forgetting.

## 2026-05-12 · Abdul gets bot-generated weekly digests, not better discipline

Abdul's late audits are a symptom of his load (5 roles on one set of shoulders), not his character. The fix is not to push him harder; it is to make audit a side effect of the daily work he already does. The bot generates the weekly digest from the records that already exist. He confirms. The owner reads on Thursday morning over coffee.

This shapes the design of the upcoming Reports commit (commit 4 in the roadmap). The Performance Report is not generic — it is, specifically and unapologetically, *Abdul's weekly digest*, with the structure that solves Abdul's problem. Other employees inherit the same pattern; Abdul is the first user.

## 2026-05-12 · Yarima's role is intentionally bounded, by structure not by trust

The decision to give Yarima a deliberately narrow Telegram menu is not punitive and is not based on suspicion. It is based on the observation that some helpers do their best work in narrow lanes, and that broadening their access creates friction for both sides. The bot enforces the boundary so the owner does not have to enforce it through conversation. This protects the working relationship by removing the source of friction from view.

This decision means future hires of similar shape get the same structural treatment by default. The role-and-department architecture (`departments`, `manages`, role-scoped menus) already supports this; we just have to use it intentionally.

## 2026-05-12 · Loyal customers get architectural-level rewards, not just discounts

The owner's instinct — "the customer who pays well, I want to give them everything extra I am capable of: computer, software, hardware" — is treated as a first-class business model, not a marketing afterthought. The Customer Orders spec (commits 8-9) will bake **tiers** into the schema from day one: Standard, Silver, Gold, Platinum, with threshold-based privileges. Reaching a tier triggers a bot-side flag so the owner is reminded of what he has promised, even if he is busy.

The rewards themselves can be manual at first (the owner physically gifts the computer). The bot just guarantees nobody is forgotten.

## 2026-05-12 · The metric for "the bot is working" is Wednesday afternoon cricket

The owner wanted to be a businessman to have *time*. The bot's success is therefore measured against time returned to the owner, not against features shipped. The target image is specific: by mid-2027, the owner takes Wednesday afternoons off to play cricket. The shop runs on the bot + Abdul. The owner checks the weekly digest on Thursday.

Every commit on the roadmap is evaluated against this. Features that produce dashboards but require constant tending fail this test. Features that delegate work cleanly to capable people and let the bot do the bookkeeping pass it.

## 2026-05-11 · Templates + Adaptive UI before Conversational AI

When asked to prioritize among Templates, Adaptive UI, Conversational AI, and Customer Orders, the owner chose **Templates + Adaptive UI in parallel** as the next sprint. The reasoning: both are additive layers on the existing task state machine, both deliver immediate efficiency to a small team (the owner and Abdul), and both have low risk. Conversational AI is deferred because the model choice is moving too fast to lock in. Customer Orders is deferred because it adds a new surface and should not happen while internal flows are still maturing.

This decision is not just sequencing; it is a statement that **internal operations must be solid before customer-facing operations open up**. A bot that confuses internal users will confuse customers worse.

## 2026-05-11 · No monetary caps on auto-approvals, rely on admin FYI

For automated monetary commitments via templates (e.g., a manager auto-assigning a ₦3000 incentive via a template), the owner chose not to install per-task or per-day caps yet. The bot just notifies the admin (the owner himself, at this size) for visibility. The reasoning: at current team size, the trust is high and the admin can intervene if something looks off. Caps would be premature engineering for a problem that does not yet exist.

This decision will be revisited when the team grows past five people or when a real instance of misuse appears.

## 2026-05-11 · Customer surface stays on Telegram; WhatsApp deferred

The customers will be asked to use the Telegram bot. WhatsApp is acknowledged as the eventual better surface for customers (familiar, low-friction, supports list messages and product catalogs) but is deferred because shipping one surface well is better than shipping two surfaces poorly. The Customer Orders spec includes a WhatsApp migration plan (§11 of the spec) so that when the time comes, the move is mechanical, not architectural.

## 2026-05-11 · The Incentives sheet is private; admin views are money-blind by default

The decision to keep `Tasks` and `Incentives` as separate sheets, with `Incentives` gated by a finance role list (`financeIds`), is treated as architectural law, not policy. The scrum-master admin views the work but not the compensation. This decision was made for two reasons: privacy of compensation (employees should not see each other's incentives) and clarity of role (the operations admin's job is to track work, not money).

This is an example of *privacy as architecture* (philosophy §7) — trust the structure, not the discipline.

## 2026-05-10 · The doer proposes the timeline; the assigner sets the incentive; the doer accepts the full deal

The negotiation flow was designed with deliberate asymmetry. The doer best knows how long their work takes, so they propose hours and deadline. The assigner best knows the value of the work, so they set the incentive. The doer then sees the full deal — work + reward — and accepts or renegotiates. This mirrors how fair agreements happen between human beings: each side controls what they best know.

Three rounds of negotiation are allowed; after that the deal either locks or breaks. This prevents thrashing while preserving the genuine back-and-forth of a real conversation.

## 2026-05-10 · Salaried and incentivized tasks both require the doer's final acknowledgment

There is no fast-path for salaried tasks. The doer's final acceptance is required for both tracks. The reasoning: even for routine paid work, the moment of explicit acceptance is the moment the clock starts and the moment the doer takes ownership. Skipping it for salaried tasks would create a class of work where the doer feels assigned-at rather than agreed-with. Symmetric design respects everyone.

(Templates can later soften this for routine work by allowing one-tap acceptance or fully automated start — but the per-template setting must be deliberate, not default.)

---

*Future decisions append below as they happen. The reasoning matters more than the decision itself; preserve both.*
