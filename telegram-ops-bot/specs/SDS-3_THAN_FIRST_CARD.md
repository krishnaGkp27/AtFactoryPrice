# SDS-3 — the Stock-by-Shade card counts thans, not bales

**Status: LAYOUT LOCKED 20-Aug-2026 by the owner (from his handwritten
card, refined over four rounds in chat). NOT YET IMPLEMENTED — the owner
is batching this with the next issue; build both together when he says
go.** Layout questions are settled; do not re-ask.

## The owner's reasoning

Once a bale is open, "2 Bales" answers nothing — the than is the unit
that sells. His paper note writes `Available = 21t` and
`Owaibula : 26`; the card follows it.

## The locked card

```
📦 9043 — Kano office
Shade A

✅ Available — 4t
624 (1t), 784 (3t)

💰 Sold
12-Jul-26 — Owaibula (26t)
701 (14t), 720 (12t)

🚚 In transit — (unchanged)
655 → Lagos office
```

## The three changes vs today (all in `src/flows/stockByShadeFlow.js`)

1. **Available header** — than count, not bale count: `Available — 4t`.
   Where whole unopened bales exist the header uses the locked §6c
   grammar: `2B + 4t` (whole as B, open as t, never double-counted).
   Pure-than stock reads pure `Nt`.
2. **Available roster** — drop the word `left`: `624 (1t), 784 (3t)`.
3. **Sold section** — header is plain `💰 Sold` (no bale figure); each
   day-line carries its than total: `12-Jul-26 — Owaibula (26t)`, with
   the per-bale detail beneath unchanged: `701 (14t), 720 (12t)`.

Everything else on the card (grouping oldest-first, container tags,
missing-detail dashes, the sold-lines cap, the In-transit bucket) stays
exactly as SDS-2 shipped it.

## After the build

- Refresh `Stock_by_Shade_Reading_Guide.pdf` (Abdul's one-pager) so the
  example card matches.
- Update the SDS layout notes in the flow header comment.
- Tests: pin the three changes with the fixture from the chat preview
  (624/784 available, 701/720 sold to Owaibula on 12-Jul) — the same
  numbers the owner approved on screen.
