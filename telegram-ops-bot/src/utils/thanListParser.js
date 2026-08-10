'use strict';

/**
 * thanListParser — SELL-T2 (owner-confirmed 09-Aug-2026).
 *
 * Abdul sells single thans out of many different bales to one customer.
 * The AI intent parser already understands the long sentence form
 * ("sell than 1 from package 1100, than 1 from package 1091 …" →
 * `sell_mixed` + thanItems), but it costs a round trip and dies with the
 * provider. This is the DETERMINISTIC shorthand, parsed locally:
 *
 *   sell 1100/1, 1091/1, 1082/1 kano      one than from each bale
 *   sell 1100/1+2+3                        thans 1, 2 and 3 of bale 1100
 *   sell 1100/1-3                          the same, as a range
 *   sell 1100 x3                           THREE thans of 1100 — he picks
 *                                          which, on chips (§2: the bot
 *                                          never selects stock)
 *   sell 1100                              open that bale's than chips
 *
 * Grammar rules that keep it unambiguous:
 *  - a comma (or "and") ALWAYS separates bales;
 *  - several thans of ONE bale join with `+` or a `-` range — never with
 *    commas, because "1100/1, 2" cannot be told apart from "bale 2";
 *  - a trailing warehouse hint is anything after `from`/`@`, or a
 *    trailing non-numeric word ("… 1082/1 kano").
 *
 * Nothing here touches the sheet: it returns intent only, and the flow
 * resolves every number against live stock. A token it cannot read is
 * returned in `bad` — never guessed at, never dropped silently.
 */

/** Words that may appear around the numbers and carry no meaning here. */
const NOISE = /\b(sell|sale|than|thans|from|package|packages|bale|bales|pkg|no|number|to|in|at|of)\b/gi;

/**
 * True when the text looks like the sell shorthand (cheap pre-check so the
 * controller can try this BEFORE paying for an AI parse).
 * @param {string} raw
 * @returns {boolean}
 */
function looksLikeThanList(raw) {
  const t = String(raw || '').trim();
  if (!/^sell\b/i.test(t)) return false;
  // At least one `<bale>/<than>` or `<bale> x<n>` token — a bare
  // "sell 1100" is left to the existing whole-bale typed path.
  return /\d+\s*\/\s*\d/.test(t) || /\d+\s*[xX]\s*\d+/.test(t);
}

function parseThanSpec(spec) {
  const out = [];
  for (const part of String(spec).split('+')) {
    const p = part.trim();
    if (!p) continue;
    const range = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const a = parseInt(range[1], 10);
      const b = parseInt(range[2], 10);
      if (!isFinite(a) || !isFinite(b) || b < a || b - a > 200) return null;
      for (let n = a; n <= b; n += 1) out.push(n);
      continue;
    }
    if (!/^\d+$/.test(p)) return null;
    out.push(parseInt(p, 10));
  }
  return out.length ? [...new Set(out)] : null;
}

/**
 * Parse the shorthand into bale/than intents.
 * @param {string} raw
 * @returns {{items:Array<{packageNo:string, thans?:number[], count?:number}>,
 *            warehouseHint:string, bad:string[], commaThanHint:boolean}}
 */
function parseThanList(raw) {
  const text = String(raw || '').trim();
  const items = [];
  const bad = [];
  let warehouseHint = '';
  let commaThanHint = false;

  // Pull the warehouse hint off the end first: "… from kano office", "@kano".
  let body = text.replace(/^sell\b/i, ' ');
  const fromCut = body.match(/\s(?:from|@|in|at)\s+([A-Za-z][A-Za-z\s.'-]*)$/i);
  if (fromCut) {
    warehouseHint = fromCut[1].trim();
    body = body.slice(0, fromCut.index);
  } else {
    // Trailing bare word(s) with no digits — "… 1082/1 kano office".
    const tail = body.match(/([A-Za-z][A-Za-z\s.'-]*)$/);
    if (tail) {
      const words = tail[1].trim();
      const cleaned = words.replace(NOISE, '').trim();
      if (cleaned) { warehouseHint = cleaned; body = body.slice(0, tail.index); }
    }
  }

  const segments = body.split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const s = seg.replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
    if (!s) continue;

    // <bale>/<thanspec>
    const slash = s.match(/^(\d+)\s*\/\s*(.+)$/);
    if (slash) {
      const thans = parseThanSpec(slash[2]);
      if (!thans) { bad.push(seg.trim()); continue; }
      items.push({ packageNo: slash[1], thans });
      continue;
    }
    // <bale> x<count>
    const times = s.match(/^(\d+)\s*[xX]\s*(\d+)$/);
    if (times) {
      const count = parseInt(times[2], 10);
      if (!isFinite(count) || count <= 0 || count > 500) { bad.push(seg.trim()); continue; }
      items.push({ packageNo: times[1], count });
      continue;
    }
    // bare bale number — open its chips, never auto-pick
    if (/^\d+$/.test(s)) {
      // A lone small number right after a `<bale>/<than>` item is almost
      // always someone writing "1100/1,2,3". Flag it so the caller can
      // show the `+` hint instead of hunting for a bale numbered "2".
      if (items.length && Number(s) <= 99) commaThanHint = true;
      items.push({ packageNo: s });
      continue;
    }
    bad.push(seg.trim());
  }

  return { items, warehouseHint, bad, commaThanHint };
}

module.exports = { parseThanList, looksLikeThanList, _internals: { parseThanSpec } };
