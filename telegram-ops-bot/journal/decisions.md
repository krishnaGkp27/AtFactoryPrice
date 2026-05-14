# Decisions — the business reasoning behind the build

> A record of *business* decisions, separate from technical ones. ROADMAP §7 captures technical decisions (state machine shape, schema choices, etc.). This file captures the *why* in human terms — what business reality made us choose what we chose.

> Ordered reverse-chronologically. Newest at the top. Append-only.

---

## 2026-05-14 (later) · Hygiene + UX pass — M1 + M3 + O1 in one session

After the morning's TG-1/TG-2/TG-4 commits, the owner asked for a workflow + code audit before further feature work. The audit identified three "Must do" and five "Optional" cleanups; we took the three lowest-risk, highest-leverage ones in one session so the codebase is cleaner before Commit 4 Reports → Templates → Customer Orders → Payment Automation open up.

`abb1bb6` collapsed seven duplicate `fmtMoney` definitions (and three duplicate `editOrSend`, plus the dead `genId` copy) into `src/utils/format.js` and `src/utils/telegramUI.js`. The new helpers accept a currency code so the per-user currency preference (ROADMAP §7 Decision 12) becomes a one-file change later. The dead `polling: false` option came off `server.js` in the same commit — identical behavior to the default, but a future maintainer might have flipped it to `true` and raced the production webhook.

`a9f2940` consolidated the Customers hub from six tiles into three. The four read-only views of the same customer (History, Pattern, Notes, Ranking) became a single "👤 Customer Details" card whose tabs swap in place. One customer pick, four views, one message — replacing three pick-customer round trips. Crucially: no Departments-sheet migration was needed. `filterByCodes()` auto-injects `customer_details` when it sees any of the deprecated codes in a department's CSV, and the legacy callbacks now also land on the new picker rather than dead-ending. Owner asked for this audit *before* feature work, and the consolidation pays dividends specifically because the upcoming customer-facing surfaces (wallet, orders, loyalty) will need that hub uncluttered.

Smoke 76/76 unchanged on both commits. ReadLints clean. Both verified live via `node -e` module-load before commit. Numbers came out byte-identical to what each call site was already producing.

---

## 2026-05-14 · Production-hygiene pass before customer-facing features (TG-1, TG-2, TG-4)

The owner returned the day after the late-night planning session, asked about the cloud agent's old improvement plan, and the AI partner showed that 22 of 26 items were still pending. Rather than work through all of them mechanically, the discussion narrowed to three that mattered before customer-facing features open up: a real runtime crash (TG-1), a real security gap (TG-2), and a misleading piece of dead code (TG-4). The other 19 items remain on the deferred list with the explicit understanding that *real engineering wins ≠ urgent*.

Three separate commits landed: `4d0e213` deleted the broken idempotency utility (32 lines, no behavior change because nothing referenced it); `cac0ea6` hoisted the sessionStore require in approvalEvents.js so the inline-require crash on the customer-approval resume path cannot recur; `e18aaa0` added webhook-secret validation in server.js and registered the secret with Telegram via the set-webhook script.

The reasoning matters more than the change itself: **bot-side floor must be patched before customer-side rooms are added**. Commits 8-9 will put real customer data through the same webhook; doing those commits over an unauthenticated webhook would have been a quiet timebomb. Doing them over a latent sessionStore crash would have generated mysterious incidents we'd have spent days diagnosing.

Smoke 76/76 unchanged across all three commits. ReadLints clean. Three commits separate so each is independently revertable.

## 2026-05-13 (~2:30am) · Payment automation becomes the closing piece of the order loop

Right after the task-manager release shipped, the owner introduced the next ambition: automate the payment side of customer orders. The vision is a three-layer system — auto-DM the customer with payment details the moment the order is delivered (tier-aware so premium customers see a richer experience), OCR uploaded receipts to spare admin from squinting at thermal paper at 11pm, and integrate Nigerian bank APIs (Mono, Okra, Paystack, Flutterwave) to auto-match incoming transfers without the customer even needing to upload anything.

The wallet system the owner described is the friendly customer-facing surface for what already exists internally as the customer ledger. Same data, vastly better UX. The existing `Ledger_Customers` + `LedgerTransactions` + `LedgerBalanceCache` infrastructure becomes the "Wallet" once we wrap a customer-side view around it.

The QR-code-with-amount-instant-disbursement fast path the owner imagined is real and shippable. When a PaymentRequest is generated with a QR that bakes in the amount and reference, and the customer pays via that QR, the bot can recognize the high-confidence match and present admin with a one-tap "Approve & credit wallet" card. Five seconds of admin attention per QR payment.

The five-commit track was added to the roadmap as PA-1 through PA-5. The full spec ships at `specs/payment-automation.md`. The architectural decision worth highlighting separately: **every domain in this bot is now consistently a state machine plus an append-only event log, communicating with other domains only through events on a shared bus**. Tasks, Orders, Payments, Loyalty — same shape, different content. The sixth domain costs the same as the fifth.

The hardest honesty in the design conversation: OCR is admin assistance, not proof of payment. Receipts are forgeable. The bot makes admin's life 95% easier by pre-filling fields, but admin still taps. The 1-second tap is the fraud-resistance. The bank statement remains the source of truth, with a weekly reconciliation report (added to the Reports commit) catching any drift.

## 2026-05-12 (late) · The business model itself is two-sided — referrals + loyalty are core, not peripheral

Late on this evening, the owner introduced a new layer of ambition that reframes the entire project: a **two-sided affiliate-and-customer-loyalty platform** that links the Telegram bot to the pre-existing `atfactoryprice.com` website. Workers can refer sub-workers (commission flows up the worker chain). Customers can refer customers (loyalty points flow up the customer chain). Both chains feed a shared `LoyaltyLedger`. Points are redeemable for goods, software, and hardware — the same generosity instinct that drove the customer-tier discussion earlier in the day, now made systematic.

The decision is to **add this as commits 11-14 in the roadmap**, after Customer Orders (commits 8-9) stabilize. Before any code starts, three real-world conversations must happen: a legal/accounting check on local Nigerian rules for multi-level commissions, an audit of the website's existing user model so identity reconciliation is designed correctly, and a decision on point governance (expiry, transferability, departure handling, accounting liability).

This decision matters because it confirms that the bot is not a productivity tool with optional features bolted on — it is **the operating layer of a multi-channel business**, where the same person can be a worker, a referrer, a customer, and a loyalty member all at once, and the bot keeps it all coherent.

The architectural payoff: the state-machine pattern (Tasks, Orders, Loyalty), the tree pattern (Departments, Referral chains), and the privacy pattern (Incentives gated by financeIds, points gated by chain membership) all generalize. Each new domain reuses the same shape. This is the reward for taking the time to design the first two domains carefully — every domain after is cheaper.

## 2026-05-12 (late) · Admin gets a direct-assign shortcut (folded into commit 4)

The owner asked for a simple addition: an admin shortcut to assign tasks directly to any employee, bypassing the org-tree filter. The state machine already supports this (the `assigner_or_admin` actor role); only the UI shortcut is missing. The decision is to fold this into **commit 4 (Reports)** as a quick win, because the owner needs it to test the reporting surface freely without dancing through the hierarchy.

This decision reflects a recurring pattern in the project: when the engine is already correct, UI affordances are cheap. Worth ~1-2 hours of work; immediate utility.

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
