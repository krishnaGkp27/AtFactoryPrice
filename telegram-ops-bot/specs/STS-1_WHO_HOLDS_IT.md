# STS-1 — "Where is it pending, and with whom?"

**Status:** audit + proposal. TRF-19 / TRF-19b / DEC-1 / DEC-1b shipped
14-Sep-2026 as the first two answers. The rest waits on the owner's word.

**Origin (owner, 14-Sep-2026),** holding a "please dispatch" transfer card
he had opened from the approvals inbox:

> "I am not able to see the exact status of this transfer. Where is it
> pending? Under whose approval or acceptance? Can you find a way of
> managing this? Also check any other activities later but for this now."

The transfer half is built. This document is the "other activities" half:
every multi-stage workflow in the bot, scored on whether **any** screen
answers *where is request X, and whose move is it now*.

---

## 1 · What shipped already (14-Sep-2026)

| Code | What it does |
|---|---|
| **TRF-19 / 19b** | One line on every transfer card and list row: `⏳ With Musa to dispatch · raised by Krishna · 3d waiting`. Stage-specific clocks, Markdown-escaped names, the stand-in note for an admin holding someone else's card, a tappable 📋 Transfers list. |
| **DEC-1 / 1b** | `✅❌ Decided` group in the 🛂 inbox — approved and rejected rows, newest decision first, naming the decider from ApprovalQueue column H. Survives a clear queue. Window = Settings `APPROVALS_DECIDED_DAYS`. |

The wording `With <name>` is the house vocabulary: it follows PAY-2's
shipped `🏦 With finance to pay`, and it does not read as an accusation
when the holder is the person reading the card.

---

## 2 · Correction, 14-Sep-2026

**The first cut of this audit was wrong and is replaced below.** It scored
returns, goods receipts and Edit Bale at 0/3 — "invisible once the submit
message scrolls away". A verification pass against the code refuted that on
four counts. Every claim in §3 has now been read out of the source.

### What EVERY dual-admin request already has

A pending `return_thans`, `receive_goods`, `edit_bale`, sale or contact is
visible on five surfaces, not one:

1. **The 🛂 Approvals inbox category** — `↩️ Returns & reversals`,
   `📦 Stock intake` and the rest each render a chip with a count, a `⚠️`
   dual-admin badge, and an age dot taken from the OLDEST item, so
   staleness cannot hide (`approvalsInboxFlow` CATEGORIES + renderCategories).
2. **Drill-in** — the full card is rebuilt from the queue row with
   `Requested by <name> · Nd ago · <ref>` and live ✅ / ❌.
3. **An hourly re-send** — the APR-1 reminder sweep re-sends the pending
   card, and a return's re-send re-forwards the returned-goods photo.
   `isStandardApprovable` excludes only `transfer_stock` and a
   `supply_request` below `admin_review`. Everything else is chased.
4. **A named first signature** — on signature one the requester is DM'd
   `🔏 Your request … has 1 of 2 admin approvals — signed by <name>.`
   (`approvalEvents`, APR-1).
5. **The decided record** — once resolved it appears in the DEC-1
   `✅❌ Decided` group, naming the decider from column H.

Transfers were the genuine blind spot, and they are also the ONE family the
reminder sweep excludes — which is why nothing ever nagged about the card
the owner was holding. That is fixed.

## 3 · The gaps that are actually real

| # | Gap | Evidence | Fix |
|---|---|---|---|
| **G1** | The inbox's one-signature note is hardcoded — `1 of 2 approvals already given — a different admin must give the second` — and names **nobody**. The requester's DM names the signer; the admin about to give the second signature, the person who most needs it, cannot see whose it joins. | `approvalsInboxFlow` dual note vs `approvalEvents` `signedBy` | Resolve `actionJSON.approvals[0]` through `approverStamp.labelFor`. ~5 lines |
| **G2** | The inbox chip (the row scanned in bulk) carries age + action + **requester**, never the holder and never the signature count. | `approvalsInboxFlow` generic chip | Append `1/2` for dual actions. ~3 lines |
| **G3** | **No raiser-facing door outside payments.** A non-admin who raised a return or a receipt cannot pull its state; they depend on the push messages surviving in their chat. `paymentFlow.showMine` is the only "what happened to what I asked for" screen in the bot. | `paymentFlow.showMine` has no sibling | One shared `📋 My requests` over ApprovalQueue by `user`. **R1** |
| **G4** | **Tasks name a role, not a person.** `Waiting on sign-off` says which stage but not which admin; `Waiting for assigner to accept timeline` names a role. The admin-side team chips fall through to a bare `📨 waiting` with no actor, and the status line is never given the viewer's identity. Tasks are the best-covered family, but they are not the finished model the first cut called them. | `taskFlow` STATUS_LABEL, `teamChipFact` default, `adminStatusLine` | Pass the assigner label into the status line. ~10 lines |
| **G5** | The supply-request card rebuilt for the inbox never reads `aj.stage`, so the inbox shows no stage — even though the DM path puts a provenance note at the very top of the card (`✅ Confirmed by Dispatch: <name> on <time>`). The gap is the REBUILD, not the push. | `approvalCards.buildSupplyRequestCard` | Print stage + holder in the builder. ~10 lines |
| **G6** | The supply approve path has an action guard but no **stage** guard, so an approval can land on a request that has not reached `admin_review`. The dispatch-side path has one. | `approvalEvents` | Mirror the dispatch-side guard. **R2** |
| **G7** | `/ops` hardcodes `requesterIsAdmin: false`, so it can report "2 required" for a request that needs 1, and it carries no stage and no signer names. | `apiController` | Pass the real flag; add stage + signers. **R3** |

### Rulings owed

- **R1 — one shared `📋 My requests`.** *Recommended: yes.* It is the only
  gap that leaves a person with no way at all to ask about their own
  request, and one flow closes it for every family at once. Question: should
  an admin's copy list everything, or only what they raised?
- **R2 — the supply stage guard.** *Recommended: yes.* Touches
  `approvalEvents.js`, an ask-first file, so it needs your explicit go.
- **R3 — the web dashboard.** *Recommended: later.* Telegram is where the
  work happens; `/ops` is oversight. The hardcoded flag is worth fixing
  whenever that file is next opened.

G1, G2, G4 and G5 need no ruling — roughly 30 lines in total.

## 4 · What this audit does NOT propose

- No new sheet, no new column, no Postgres table. Every line above is read
  at render time from data the ApprovalQueue row already carries
  (`user`, `status`, `createdAt`, `resolvedAt`, `approver`, and the stage
  and actor ids inside `actionJSON`).
- No change to approval semantics. Nothing here adds, removes or relaxes a
  signature requirement; R2 is a guard that makes an existing rule harder
  to bypass, not a new rule.
