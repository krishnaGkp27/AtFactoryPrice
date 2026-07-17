# Audit — Contact Network approval gating (16–17 Jul 2026)

**Question asked by the owner:** is EVERY addition of a member (and every
detail change) in the contact network verified through admin approval?

**Method:** three independent adversarial audit agents — (1) exhaustive
trace of every code path that writes the Contacts / ContactLinks sheets,
(2) dissection of who can execute an approval, (3) active bypass attempts
(forged callbacks, stale sessions, bogus fields, web API probing).

**Verdict: GATED** (all three agents, independently). Two hardening gaps
found and fixed; three accepted notes documented below.

## Evidence

1. **The flow cannot write.** `contactNetworkFlow.js` contains zero writes
   to the contact sheets — Submit only appends a *pending* ApprovalQueue
   row. The only graph-writing code in the entire bot lives inside
   `inventoryService.executeApprovedAction` (add_contact_link ~:1097,
   update_contact_info ~:1116), reachable exclusively from the `approve:`
   handler.
2. **Only admins execute.** `approvalEvents.handleApprovalCallback`
   rejects non-admins ("Only admins can approve.") before any execution;
   the SEC-P1 H1 guard blocks the requester approving their own request
   whenever another admin exists. Both actions sit in
   ALWAYS_APPROVAL_ACTIONS, so even an admin requester needs one OTHER
   admin (and they are deliberately NOT dual-admin).
3. **Bypass attempts failed.** No-session / wrong-type / draft-less
   callbacks short-circuit; `cn:ef:` rejects non-whitelisted fields;
   `cn:dupe` cannot be forged (dupe id only set by the validated phone
   step); the global allow-list gate runs before flow dispatch; the
   website endpoint is GET-only and key-gated; reject leaves zero orphan
   state because nothing is written pre-approval.
4. **Complete write-path inventory** (every caller of the four mutators):
   executor branches (approval-gated), `ensureNodeForCustomer` (mirror
   only — see note 1), NL `add_contact` executor (employee path gated;
   admin path was direct — FIXED, see below), and two legacy supplier
   name-only quick-adds (note 2).

## Gaps fixed

| # | Gap | Fix | Commit |
|---|-----|-----|--------|
| 1 | Submit buttons lacked a wizard-step guard — out-of-order taps could queue degenerate blank-value requests (still approval-gated, but approvable unread) | `cn:ok`/`cn:edok` now valid only from their confirm screens; tests pin "premature submit is a no-op" and "zero writes between submit and approval" | 24de18c |
| 2 | Legacy NL "add contact" let ADMINS write the phonebook directly (free-text name/phone), below the network's approval standard | `add_contact` added to ALWAYS_APPROVAL_ACTIONS — every contact addition now reviewed by one non-requester admin | 17-Jul |
| 3 | Links could be created but never removed (deactivate had no UI) — the documented "cheap reversal" didn't exist | Admin-only 🗑 Unlink on person cards: edge deactivated (never deleted), audit-logged; person row remains | 17-Jul |

## Accepted notes (documented, not changed)

1. **Shadow nodes:** first open of a buyer's card auto-creates their
   contact row WITHOUT approval — but it only copies data already in
   Customers/Inventory (the buyer name comes from a server-side index,
   never free text). No new information can enter this way.
2. **Supplier quick-adds** (Receive Goods / Procurement) append a
   name-only supplier contact directly. Pre-CNET legacy; gating them would
   block goods receiving mid-flow for negligible risk (no phone/address
   captured). Revisit if suppliers join the network UI.
3. **Approver pool is env ADMIN_IDS only** at the approve gate;
   sheet-promoted admins (USR-C3b) pass `isAdmin()` elsewhere but cannot
   tap Approve. Fail-closed (no escalation risk), with one liveness edge:
   a sole env-admin requester + only sheet-promoted colleagues = stuck
   request. Widening the pool is an approval-semantics change → owner
   decision.
4. **Webhook secret enforcement is still dormant** (owner's pending
   SEC-P1 task). Until enabled, forged webhook updates could QUEUE
   requests as any staff id — they still cannot execute anything without
   a genuine admin tap. Enabling enforcement closes this fully.
