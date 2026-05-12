# 13-May-2026 (~2:30am) — Payment automation planning

> A short, focused planning session that began ~30 minutes after the task-manager release shipped. The owner — still awake, still thinking — introduced the next ambition: automate the payment side of customer orders.

---

## How it opened

After commits landed `dbea342` (Payouts queue + admin badge) and `2eca0c8` (journal close-out), and after the AI partner suggested sleep, the owner came back with a new thought: *"Here in this place there are lot of payment methods. Going ahead I want to bring in the system to auto-request the payment after the delivery with all detailed information for my client in premium features. So I want to make sure all the receipt of the payment upload must pass through OCR for some scripted lines to use in regard to payment and understanding. Like in case of QR code with amount just needs admin approval which will be disbursed from the wallet system instantly."*

In one paragraph he had named four distinct ambitions:

1. **Auto-request payment after delivery** — the bot DMs the customer with payment details the moment the order is delivered
2. **Premium-tier experience** — Gold and Platinum customers see a richer payment-request DM
3. **OCR on uploaded receipts** — bot pre-processes receipts so admin doesn't have to squint at thermal paper
4. **QR-code-with-amount instant disbursement** — for the QR fast path, admin approval triggers an instant wallet credit

He asked for the AI partner's views, where the feature is most needed, and what intensity it deserves.

## The AI partner's response

The first move was to reflect the system back as one coherent flow:

```
ORDER DELIVERED → auto-DM payment request → customer pays via N methods
  → customer uploads receipt OR bank API auto-detects transaction
  → OCR extracts fields / bank match scored
  → admin one-tap approval card (pre-filled, high-confidence flagged)
  → on approve: wallet credited, customer DMed thank-you, order marked paid
```

Three sub-systems wearing one coat — auto-request, OCR + bank-API verification, wallet.

## The three engineering honesties

The AI partner then surfaced three realities the owner needed to know before the design got locked in:

**1. OCR is not proof of payment.** An OCR'd receipt tells you what the image says, not that money arrived. A fraudster can photoshop a receipt in 30 seconds. OCR is **admin assistance**, not a truth source. Bank statement is the truth source. The proper flow is OCR-fills-fields, admin-still-taps, and weekly reconciliation against actual bank data.

**2. Bank API integration is the real gold — and it's gappy in Nigeria.** Real-time bank-account monitoring exists via Mono, Okra, Paystack, Flutterwave — but coverage varies, pricing varies, and the choice needs a real research conversation with each provider.

**3. The wallet system already partly exists.** The existing `Ledger_Customers` + `LedgerTransactions` + `LedgerBalanceCache` infrastructure is the wallet. We don't need a new system. We need a customer-friendly skin over what's already there.

## The intensity heatmap

Rather than a flat "let's build it," the AI partner mapped where this work is most needed:

| Slot | Intensity | What it gets |
|---|---|---|
| Customer Orders (commits 8-9) | 🔥🔥🔥 Critical | Auto payment request closes the order loop |
| Loyalty platform (11-14) | 🔥🔥🔥 Critical | Wallet houses loyalty points; same ledger |
| Existing receipt upload | 🔥🔥 High | OCR plugs in cleanly |
| Customer tiers | 🔥🔥 High | Premium payment-request DM is a tier reward |
| Admin pending queue | 🔥 Medium | Payment review extends the same queue pattern |
| Bank API integration | 🔥 Medium (research first) | Replaces OCR in happy path; needs provider decision |

## The two decisions the owner made

Despite the 2am hour, the owner pushed through:

- **Write the full spec tonight** rather than defer to tomorrow. The AI partner had recommended sleep; the owner overruled.
- **Both OCR and Bank API designed from day one** — provider-agnostic abstractions so either can be swapped without rewriting the matcher.

## What got produced

`specs/payment-automation.md` — ~900 lines covering:

- §1 Goals/non-goals (explicit non-goals: no payment-gateway-on-outbound-side; no multi-currency yet; no refunds/splits yet)
- §2 The three subsystems (auto-DM, OCR+bank verification, wallet)
- §3 Data model — 4 new sheets, 2 sheet extensions, new Settings keys
- §4 9-state payment state machine with the QR fast-path detailed
- §5 OCR provider abstraction (Google Vision default, Tesseract fallback, AWS Textract option)
- §6 Bank API provider abstraction (Mono default, Okra/Paystack/Flutterwave alternates)
- §7 Wallet UI — customer-side My Wallet view + admin payment-review queue
- §8 Auto-DM integration via `erpEventBus`
- §9 Premium tier DM templates including the "Talk to John directly" Platinum button
- §10 12 open questions
- §11 5 risks with explicit mitigations
- §12 5-commit decomposition (PA-1..PA-5)
- §13 Per-commit acceptance criteria
- §14 Architectural note: every domain is now a state machine + event log on a shared bus

## The architectural insight worth preserving

While writing the spec, the AI partner named explicitly what had been quietly emerging:

> *"Every domain in this bot is a state machine plus an append-only event log, connected to other domains only through events on a shared bus."*

That single sentence summarizes what we've built. Tasks, Orders, Payments, Loyalty — all the same shape. The cost of adding a sixth domain is the cost of adding the fifth. There is no shared mutable state to coordinate. There is only events on the bus.

This means the roadmap from here is far more linear than it would be in a typical project. The hard architectural work was done in TG-7.5 (Phase A through 3.5). Everything from PA-1 onward is filling out the pattern.

## What was deferred

- The full spec is written but no code was started. Each PA-commit is sized to be independently shippable behind a feature flag.
- Bank API provider research (~2-3 hours with each Nigerian fintech) is flagged as a blocker before PA-3 begins.
- QR code format decision (NQR vs bank-specific vs static) is in open questions §10.4 — recommended to start with static QR and migrate later.

## The closing

After the spec landed and was committed, the AI partner suggested again: *sleep*. The release shipped at ~1:30am. The spec landed at ~2:45am. The next session can begin with a fresh head, knowing:

- The task manager is live
- The payment automation is fully designed but not coded
- The roadmap has clear commits ahead with no architectural ambiguity
- The journal records both *what* and *why*

Three nights of work, one shipped feature, four written specs, one consolidated roadmap, one journal folder with thirteen documents — and tomorrow morning the owner can read all of it over coffee with no need to remember anything.

---

*Written immediately after the spec was drafted, while the design was still warm. The owner's late-night insistence on completing the spec rather than deferring it shaped this entry — the work was worth doing while the thoughts were fresh, and the discipline of writing it down then is the discipline of letting tomorrow be a different day.*
