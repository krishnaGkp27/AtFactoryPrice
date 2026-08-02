# TRF-14 — typed transfers pin their bale numbers (+ REP-2 one-off repair)

> **Superseded in part by TRF-15 (owner rule, later the same day):** the
> "picker pre-selects the pinned bales" decision below is replaced by
> NO pre-selection of any kind — see the TRF-15 section at the bottom.
> Pinned numbers remain stored and shown as 📌 Ordered guidance, and the
> confirm-screen deviation warning stands.

Owner-reported 02-Aug-2026 (Abdul's screenshot): typed order
"Transfer packages 869,843,874,864,903 to Kano" was dispatched as
867/842/873/863/903 — FIFO neighbours of the same design/shade, not the
bales on the truck.

## Root cause

`startFromText` (TRF-8b) resolved the typed numbers, then collapsed them
into `{design, shade, qty}` lines — the numbers never reached the queue.
The dispatch picker pre-ticked `cands.slice(0, qty)` (oldest sheet rows) and
the dispatcher, reasonably assuming his typed numbers were kept, tapped
through. Likely also explains the near-miss pattern in the 01-Aug PDF
reconciliation (14/43).

## Locked decisions (owner, 02-Aug)

1. Typed numbers are PINNED: order lines carry `bales`; every card prints
   them on the line rows (same bracket style as TRF-12).
2. The dispatch picker pre-selects exactly the pinned bales. FIFO
   pre-selection remains only for tap-built orders that never named bales.
3. A pinned bale that is no longer available forces the picker open with a
   ⚠️ note; the shortfall is FIFO-filled but never silently.
4. The dispatch-confirm screen spells out any requested-vs-selected
   deviation ("order asked for *869* — you are dispatching *867* instead")
   above the Dispatch button. Deviation stays ALLOWED — physical truth
   wins — but never unstated.

## REP-2 — repair for transfer 02Aug·01

One-off, fingerprint-matched (TR-20260802-*, IDUMOTA→Kano, logged set
{842,863,867,873,903}), state-guarded swap of the four wrong rows back to
available @ source and the four physically-taken bales into the transfer
(by bale_uid; design/shade-scoped). Handles pending (in-transit) and
approved (received) states; a rejected transfer needs no swap. Rewrites the
queue row's `bales`/`baleUids`/`dispatched`, audit-logs
`transfer.bale_repair`, DMs admins, refreshes the receiver's card while
in transit. Idempotent — runs at boot (server.js, 30 s), no-ops forever
after the swap. Remove the hook after it has run in production.

## Files

- `src/flows/transferFlow.js` — startFromText pins bales; linesBlock /
  confirm print them; picker pre-tick + Ordered note; confirm warnings.
- `src/services/transferService.js` — createTransferRequest keeps
  `line.bales` (deduped, capped to qty).
- `src/services/transferRepair.js` + `server.js` boot hook — REP-2.
- Tests: `test/characterization/transferFlow.pinnedBales.test.js`,
  `test/unit/services/transferRepair.test.js`.

---

## TRF-15 — the bot NEVER selects bales (owner rule, 02-Aug, locked)

> "Don't put any order of selection from your own side at any place — be it
> transfer, dispatch, return, or anywhere else. The confirmation only comes
> from the warehouse boy. The source of truth is only the image followed by
> approval. No random selections."

1. **No pre-selection anywhere.** The dispatch picker opens every line
   UNTICKED — for typed and tap-built orders alike. A typed order's numbers
   show as 📌 Ordered guidance only; the dispatcher must still tick each
   bale himself.
2. **Auto-pick is gone.** The "⏭ Auto-pick remaining" button is removed;
   a legacy tap on an old card just re-renders the picker.
3. **No auto-fill / no skipped lines.** Every line is shown, even when
   stock exactly matches the request. The old "auto-filled (oldest first)"
   path is deleted.
4. **Service-level enforcement.** `transferService.dispatch` REFUSES a call
   without explicit per-line picks — the FIFO fallback is removed. The two
   legitimate pick sources are the picker's human ticks and the numbers
   read from the load photo (snap transfers: image = source of truth).
5. **Zero-tick review blocks.** The confirm screen withholds the Dispatch
   button until at least one bale is ticked.

The requested-vs-ticked deviation warning (TRF-14 §4) still fires; short
lines still dispatch flagged `⚠️ short` — both are the dispatcher's explicit
choices, never the bot's.
