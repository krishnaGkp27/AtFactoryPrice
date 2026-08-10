# SELL-T3 — Typed than-list sale (mixed bales, one customer)

> Renamed 10-Aug-2026: this shipped as "SELL-T2", which was already the tag
> of the 21-Jul sale-date calendar (`sellBaleFlow`, `dateCalendar`). The
> calendar keeps SELL-T2; the typed than-list is SELL-T3.

**Status: SHIPPED.** `55d3b2a` (build, owner-confirmed 09-Aug-2026) +
`2f855c2` (SELL-T3b, fixes from Abdul's first live use the same day).

## Problem

Kano sells in thans. A customer takes one than from this bale, one from
that bale, across five different designs and colours — one sale. Reaching
that through the picker cost design → shade → bale → than, five times
over.

Abdul typed it instead:

```
Sell than 1 from package 1100, than 1 from package 1091, … to ABBA
```

`intentParser` already understood that as `sell_mixed` with `thanItems`.
But `startSaleFlow` only preloaded for `sell_package` / `sell_batch`, so
than-level sales fell through to the generic "Sales now run through
💰 Sell Bale" redirect. **The bot read him correctly and threw it away.**

## Locked decisions (owner, 09-Aug-2026)

1. **Both input forms land on the same review card** — the long sentence
   (AI-parsed) and a deterministic shorthand.
2. **The shorthand is parsed LOCALLY, before the AI round trip.** It is
   free, instant, and survives an OpenAI outage — this is Abdul's fastest
   daily path and it must not depend on a provider.
3. **The typed customer stays dropped** (DSP-1, 26-Jul): the dispatcher
   raises what physically ships; the admin names the buyer, rate and
   payment at approval. Same for a typed date.
4. **Never substitute a than** (BUSINESS_RULES §2). A named than that is
   gone is reported with its reason; the bot never quietly loads its
   neighbour. `1100 x3` and a bare `1100` open that bale's chips so the
   human picks.
5. **Ambiguity asks, never guesses**: bales spread over two stores, or an
   unrecognised store name, stop and ask.

### Why this does not weaken §2

§2 forbids the BOT selecting physical stock (FIFO picks, auto-fill,
pre-ticked chips). Here every than in the cart was named by the human —
the bot only resolves his numbers against live stock. Same precedent as
SELL-T1 (whole-bale typed preload) and TRF-8b (transfer preload).

## The grammar

`src/utils/thanListParser.js` — pure, no I/O, no AI.

| Typed | Means |
|---|---|
| `1100/1` | bale 1100, than 1 |
| `1100/1+2+3` | thans 1, 2 and 3 of bale 1100 |
| `1100/1-3` | the same, as a range |
| `1100 x3` | 3 thans of 1100 — **he** picks which, on chips |
| `1100` | open that bale's chips |
| `,` or `and` | **always** starts a new bale |
| `from <store>` · `@<store>` · trailing words | the store |
| `to <name>` · a date | read, reported as ignored |

**A comma never joins thans.** `1100/1, 2, 3` cannot be told apart from
"bale 2, bale 3", so it is read as bales and the card raises the `+` hint
rather than guessing (§2). A malformed spec (`1100/abc`) is reported, not
downgraded to "the whole bale".

Entry: `looksLikeThanList()` gates the controller intercept (requires
`sell` + a `<num>/<num>` or `x<n>` token), so whole-bale typed sales keep
their SELL-T1 path.

## The review card

`bundleSaleFlow.startWithThans()` → `renderPreloadReview()`:

```
🧵 Sell Thans — 5 of 5 typed than(s) loaded
From Kano office

📦 1100 · 77014 · Shade 11 — than 1 · 30 yd
…
━━━━━━━━━━
5 than · 150 yd · 5 bale(s)

[✅ Confirm & submit] [🛒 Edit list] [➕ Add more] [❌ Cancel]
```

Then the existing cart → confirm → `sale_bundle` approval path,
unchanged. The cart was always design-agnostic (one line per than,
each carrying its own design/shade), so mixed-design sales needed no
change downstream — only the confirm header, which used to print a
single design and now names them all.

## Reason taxonomy (SELL-T3b)

The first cut answered every failure with "no available than on this bale
(sold, or wrong number)". Abdul's live card showed four bales rejected
that way with no way to act. The sheet already knows the truth, so each
reason is now derived from the row's real state:

| State found | Card says | What he does |
|---|---|---|
| `in_transit` | still on the road to *X* — receive it into the store first | receive the transfer, then sell |
| `sold` | already sold to *Y* on *date* | wrong bale/than |
| `available` elsewhere | available in *X*, not *this store* | fix the store |
| no row at all | no bale with this number on record | typo |
| than missing, bale live | than *n* is not available — this bale has than 1, 2, 3 | use a listed than, or 🔎 Open |
| unknown store name | I don't know a store called *X* + list of stores with stock | re-send with a real name |

Listing the thans a bale *does* have guides him without choosing for him.

## Faults found in first live use (all fixed in `2f855c2`)

1. **The tail ate a bale.** He writes the whole sale on one line
   ("… from kano office to karibullah, 06 august 2026"). The store was
   only looked for at the very END of the text, so the customer+date tail
   both swallowed the last bale and lost the store → "From any store" and
   4 bales "not loaded". Items are now read from the FRONT of each
   segment; leftovers become tail text, and store/customer/date are
   extracted from it.
2. **Useless reasons** — see the taxonomy above.
3. **Markdown leak.** Reasons went through the flow's MarkdownV2-style
   `escapeMd` while the card sends `parse_mode: 'Markdown'` (v1), so
   Telegram printed the backslashes: `\(sold, or wrong number\)`. Prose
   now uses flowKit's v1-safe `mdEscape`; `escapeMd` stays for the
   identifier fields it was written for.

## Tests

- `test/unit/utils/thanListParser.test.js` — the grammar, including
  Abdul's exact live message, the comma-vs-`+` rule, dates never becoming
  than numbers or store names, `@store`, and malformed specs.
- `test/characterization/sellThanList.test.js` — the real controller:
  preload across designs, no-substitution, `x3`/bare-bale chips, each
  reason string, unknown store, no stray backslashes, split stores ask,
  and the AI `sell_mixed` path landing on the same card.

## Open / next

- Abdul's operating card: `docs/` PDF handed to him 09-Aug-2026.
- The 08-Aug "approved but could not be completed" failure
  (`3a9c9a05-…`) is UNRELATED and still undiagnosed — the admin-side
  `⚠️ Approved but execution failed: <reason>` line is needed.
