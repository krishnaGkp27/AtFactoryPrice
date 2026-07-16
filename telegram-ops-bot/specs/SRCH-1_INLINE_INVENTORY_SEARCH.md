# SRCH-1 — As-you-type INVENTORY search via Telegram inline mode (DRAFT)

Status: **draft — owner to lock §4.** Requested 16-Jul-2026; owner
correction the same day: this is an INVENTORY search (bale number, design
number, …), NOT part of the CNET-1 contact network.

## 1. What it does

Staff type `@<bot> 58…` (or `770…`, `Jul26…`, `cashm…`) in the bot chat —
Telegram fires an `inline_query` on EVERY keystroke and the bot answers
with a live-filtered suggestion panel that narrows as they type:

- `📦 Bale P58` — 77019 · shade 3 · IDUMOTA · available (7 thans, 420 yds)
- `🧵 Design 77019` — 94 bales available across 2 warehouses
- `🚢 Container Jul26` — 648 bales · 14 designs
- `🧣 Cashmere` — 2 designs · 263 bales

Tapping a suggestion posts a compact stock card into the chat (design
summary per warehouse / bale detail incl. status + soldTo when sold /
container summary). This complements the in-flow pickers (TRF-7 bale
search etc. stay unchanged) as the fast "find anything" path.

## 2. Mechanics

- Owner enables inline mode ONCE in BotFather: `/setinline` (~1 min) — the
  only owner action.
- server.js webhook dispatch gains an `update.inline_query` branch →
  `searchService.handleInlineQuery` → `bot.answerInlineQuery` (article
  results, max 20, `cache_time: 0, is_personal: true`).
- Index built from the existing 5s-TTL inventory snapshot (zero extra
  Sheets reads): packageNo, design, arrivalBatch, warehouse, shade names,
  DCAT-1 category. Ranking: exact match → prefix → substring; bale-number
  hits before design hits when the query is numeric-ish.
- SECURITY: inline queries arrive from ANY Telegram user who mentions the
  bot. Hard gate on the staff allow-list (auth.isAllowed); strangers get
  an empty panel. No money values in v1 results (CV-1: values are
  admin-gated elsewhere; quantities only here).

## 3. Not in scope

- Contacts/customers (CNET-1 has its own browse; owner explicitly
  separated the two).
- Editing anything from search results — read-only cards with a hint line
  pointing at the right flow tile.

## 4. Decisions for the owner

| # | Question | Recommendation |
|---|---|---|
| 1 | Searchable entities v1: bales + designs + containers + categories? | Yes, all four |
| 2 | Include SOLD bales (marked status + buyer) or available only? | Include sold — finding where a bale went is half the use |
| 3 | Money values in results? | No (quantities only); admin variant later if wanted |
| 4 | Who can search: all allow-listed staff? | Yes (same gate as bot access) |
