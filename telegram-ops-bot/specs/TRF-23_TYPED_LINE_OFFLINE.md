# TRF-23 — the typed transfer line needs no AI

Owner's Go, 31-Oct-2026 ("Go, implement both. Also code it perfectly so
that it doesn't require any API").

## 1. The incident

31-Oct-2026, 10:38 and 10:55. Abdul typed

```
Transfer package 832,1186,786,812,828,1193,1202,802,1191,822,1111,1328 to kano
```

four ways (with and without the word *package*, with and without spaces)
and got, every time:

```
Need more info: Please provide more details (Bale number, than number, customer name, etc.).
```

That sentence is the intent parser's **offline fallback** string
(`intentParser.fallbackParse`). It is returned only when the OpenAI call
never produced an answer: no key, the per-user limit, or the request
threw (revoked key, exhausted credits, outage). The model itself never
produces it. The fallback's regex list knew sell / add / analyze / list /
detail — not *transfer* — so every transfer sentence became a vague
`check` with a clarification, and the controller bounced it.

The failure was swallowed (`catch { return fallbackParse() }`) — not one
log line in Railway.

Why only transfers broke: the sell line (SELL-T3, 09-Aug) and the return
line (RET-5, 20-Oct) are parsed **locally**, before the AI round trip. The
transfer line was the one typed door still riding the provider.

## 2. What shipped

| # | Change | Where |
|---|--------|-------|
| 1 | `looksLikeTransferLine(text)` — the line opens with `transfer` / `move` (an optional *please / pls / kindly* in front) and carries at least one number. Nothing else is claimed: a sell line, a return line, "Transfer stock" (no number) and "Can you transfer …" (verb not first) are left to their own doors. | `src/utils/thanListParser.js` |
| 2 | The controller tries it **before** `intentParser.parse`, right after the RET-5 block, and hands the raw text to `transferFlow.startFromText` — the same preload card the AI path used. Falls through to the AI only when the flow shows nothing (not allowed). | `src/controllers/telegramController.js` (surgical, owner's Go) |
| 3 | `parseTypedTransfer` reads the sell grammar as **whole bales**: `6189/5` → bale 6189 (its than part set aside), `771 x3` → 771, "than 3 from package 5801" → 5801. Before, the `5` and the `3` were looked up as bale numbers and matched whatever ended in that digit. The card says `ℹ️ Whole bales move — the than part of N number(s) was ignored`. A trailing full stop after the store no longer breaks the destination match. | `src/flows/transferFlow.js` |
| 4 | The offline fallback itself knows *transfer* / *move* + a number → `transfer_batch` with no clarification, so even a sentence the local reader does not claim ("Can you transfer 5801 to kano") lands on the preload card when the AI is down, instead of "Need more info". The card resolves every number against live stock and waits for a tap — nothing moves. | `src/ai/intentParser.js` |
| 5 | The swallowed error is **logged**: `intentParser: OpenAI parse failed, offline fallback used — <message>`, and once per boot `intentParser: no OPENAI_API_KEY — typed sentences use the offline fallback`. | `src/ai/intentParser.js` |

No sheet, no column, no knob, no new action code (`transfer_batch` already
exists in the enum). BUSINESS_RULES §2 untouched: every number is still
resolved against live stock on the preload card, and the dispatcher still
ticks what physically leaves.

## 3. What still goes through the AI

Only free wording — a sentence that does not start with *Transfer* or
*Move*, or carries no number. With the AI down those reach the fallback,
which now routes the ones with a number (change 4). The office guide
(`docs/TRF_TRANSFER_REQUEST_GUIDE.pdf`) tells staff to retype as
`Transfer <numbers> to <store>` whenever the bot answers *Need more info*.

## 4. Still owed (owner)

- **Why OpenAI stopped answering.** Check the OpenAI account (credits /
  billing, the key) and Railway `OPENAI_API_KEY`. From now on the Railway
  log names the cause on every failure.
- Other typed sentences (stock questions, reports) still need the AI.
  A local reader for the most-used ones is a separate ask.

## 5. Tests

- `test/unit/utils/thanListParser.test.js` — the detector: Abdul's four
  real lines, *move*, *please*, than tokens; never a sell / return line.
- `test/unit/ai/intentParser.test.js` — the offline fallback routes a
  transfer sentence with a number and still asks for more without one.
- `test/characterization/typedTransferLine.test.js` — the real
  controller with the AI stub answering the incident's offline shape:
  Abdul's exact line opens the preload card with **zero** AI calls, every
  unloadable number named with its reason, `kano` matched to *Kano
  office*; `6189/5` loads 6189 and never a bale ending in 5; "Transfer
  stock" still asks the AI.

## 6. Live check (owner)

1. Have Abdul send his line exactly as on 31-Oct. Expect the preload
   card: `🚚 Transfer Stock — preloaded N of 12 typed bale(s)`, the
   numbers not on the Lagos shelf listed with reasons, `📍 Destination:
   Kano office`, `➡ Continue`.
2. Send `Transfer 6189/5 to kano` — the bale loads whole and the card
   carries the ℹ️ line.
3. Railway log after any typed stock question: if the AI is still down,
   one `intentParser: OpenAI parse failed …` line names why.

## 7. Amended 11-Nov-2026 (FIX-TRANSFERS)

- **The bale that IS the typed number wins.** A typed number used to match
  any available bale whose number equals it OR ends with it, first hit on
  the source shelf — typing `832` could load `1832`. Now, when a bale
  carries exactly that number (any store, any status), nothing else is
  considered: an exact bale that is sold, on the road or in another store
  is skipped with its usual reason. The ending match stays only for a
  number no bale carries exactly (`transferFlow.typedHits`).
  FIX-BALEMATCH2, same day: the same rule now governs the two sale doors
  that read a bale number — 📸 Snap Sale (label photo and PDF batch) and
  the typed Sell Bale preload — through one helper, `utils/baleNumberMatch`.
- **❌ Cancel on the preload card (and anywhere in the Transfer Stock
  wizard) now draws.** The card is replaced by `🚚 Transfer cancelled —
  nothing was moved.` + `🏠 Menu`; before, the session ended but the card
  stayed on screen with its buttons. A ❌ Cancel tapped while a ✅ Send is
  still being written is ignored (the order cannot be recalled): the card
  then shows the send's own result, never a cancelled line.
- Tests: `test/unit/flows/transferTypedHits.test.js`,
  `test/characterization/transferCancelNoopExact.test.js`.
