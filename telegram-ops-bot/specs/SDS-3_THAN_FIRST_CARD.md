# SDS-3 — the Stock-by-Shade card counts thans, not bales

**Status: SHIPPED 21-Aug-2026 (`b07c314`).** Layout locked 20-Aug-2026 by
the owner from his handwritten card, refined over four rounds in chat.
Layout questions are settled; do not re-ask.

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

## Which places get the than-first card

Not a warehouse list and not a Settings toggle: the card asks the LOC-1
`Locations` register what kind of place this is, and renders than-first
only where `kind = store`. The owner marked `Kano office` a store on
20-Aug-2026, so it is the first (and today the only) one. Marking another
place a store switches its card over with no deploy. If the register is
unreachable the flow defaults to `false` — the bale-first card every
warehouse had before this change.

## After the build — all done 21-Aug-2026

- ✅ `Stock_by_Shade_Reading_Guide.pdf` (Abdul's one-pager) rebuilt: the
  example section now shows BOTH cards side by side — store and bale
  warehouse — so a reader can see which shape belongs to which place.
- ✅ SDS layout notes updated in the flow header comment.
- ✅ Tests pin the three changes with the owner's on-screen fixture
  (624/784 available, 701/720 sold to Owaibula on 12-Jul) in
  `test/unit/flows/sdsThanFirstCard.test.js`.
