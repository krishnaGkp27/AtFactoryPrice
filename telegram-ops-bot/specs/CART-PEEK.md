# CART-PEEK — the basket rides every supply-request picker

**Status:** SHIPPED 16-Sep-2026 (`f188933a`), hardened the same day after an
adversarial review (escaping, caption budget, sold-out note, placement,
pointer wording, header-safe cut).

**Origin (owner, 16-Sep-2026),** on the shade picker of 202/201:

> "When I am selecting the design → shade → quantity from the supply
> request, I am not able to see what I have selected in the cart already.
> Can you check and make an arrangement for me in the bot so that I can
> keep on selecting the quantity, looking at what I already have in my
> basket?"

## 1 · What it is

One block, appended to every screen where the next cart line is chosen:

```
🛒 In cart · Σ 3B
202/201
  • 3 - Navy Blue · 2B
9037
  • 3 · 1B
```

The lines are the cart card's own — `cartFormat.formatCartPeek` reuses
`formatCartBlock` with no category, exactly as the requester's cart card
does — so the peek and the cart can never say two different things. The
tally rides the header so the total survives a cap.

## 2 · Where it lands (the decisions)

| Screen | Placement | Why |
|---|---|---|
| Design list | above `Select design:` (replaces the old `🛒 N in cart` count) | the prompt stays nearest the buttons |
| Shade picker — photo caption (fresh combo and morph-back) | after the header, **before** the TV-4b overflow lines | the overflow lines describe the buttons and belong beside them |
| Shade picker — album picker text and text fallback | before `Select shade:` | same rule |
| Sold-out design screen | before the sold-out note | the basket must not vanish on an info screen |
| Sold-out **shade** note | before "Nothing available to add" | it MORPHS the very message whose caption carried the basket |
| Quantity card (all renders: morph, shade-photo combo, single-shade combo, album, text) | between the availability line and `How many bales?` | the question stays nearest the chips |
| Typed Custom Quantity prompt | after the prompt, plain text | the fourth place a quantity is chosen |

An empty cart renders every screen byte-identically to before.

## 3 · The two limits, and how the block bows to them

**Markdown.** Six of the seven surfaces render with `parse_mode:
Markdown`. Design codes and shade names come from the catalogue and the
sheet; one `_` in a shade name would 400 the caption and take the whole
picker with it (the TRM-1 failure class), and the text fallback would then
fail the same way — no picker at all. The peek escapes `* _ \` [ ]` exactly
as the overflow lines beside it do. The typed prompt is plain text and is
passed `markdown: false`, so no backslashes leak there.

**Telegram's 1,024-character photo caption.** The shade picker's caption
already carries overflow lines (one per shade whose label exceeds 34
characters), so a fixed cap on the peek alone could still push the caption
over. The two photo call sites therefore pass the **room left**
(`1024 − everything else`) as the peek's budget; text screens use a 420
default. Past the budget the lines go and the tally line stays; past even
that, nothing — a caption that cannot send is worse than a caption without
the basket. Independently, the block caps at 8 lines with a pointer, and
the cut never lands on a bare design header.

**Wording of the pointer.** `…and more in the cart` / `— full list in the
cart`. It used to name the `🛒 Back to cart` button, which the quantity
card and the typed prompt do not have.

## 4 · Owner's live check

From the supply request add one shade of 202/201, tap ➕ Add More, and
confirm the shade picker's photo caption and the next quantity card both
list the line you already have. Then tap ⬅️ Back to shades from the
quantity card: the photo morphs back and its caption still carries the
basket.
