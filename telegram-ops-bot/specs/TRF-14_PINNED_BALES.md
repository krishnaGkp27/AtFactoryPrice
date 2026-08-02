# TRF-14 — typed transfers pin their bale numbers (+ REP-2 one-off repair)

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
