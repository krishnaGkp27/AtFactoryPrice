'use strict';

/**
 * thanListParser — SELL-T3 (owner-confirmed 09-Aug-2026).
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

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/** True when a segment is a DATE, not a bale ("06 august 2026", "6/8/26"). */
function isDateLike(s) {
  const t = String(s).trim();
  if (MONTHS.test(t)) return true;                       // 06 august 2026
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return true;  // 06/08/2026
  if (/^(today|yesterday|tomorrow)$/i.test(t)) return true;
  return false;
}

/**
 * Parse the shorthand into bale/than intents.
 *
 * SELL-T3b (Abdul, 09-Aug-2026) — he naturally writes the WHOLE sale in one
 * line: "Sell 1108/1, 1126/1 … from kano office to karibullah, 06 august
 * 2026". The first cut only looked for a warehouse at the very END, so the
 * customer + date tail swallowed the last bale and the store was lost.
 * Items are now read from the FRONT of each segment and everything left
 * over becomes tail text — store, customer and date are pulled out of it
 * and the customer/date are reported as ignored (the admin sets them at
 * approval, DSP-1) instead of breaking the line.
 *
 * @param {string} raw
 * @returns {{items:Array<{packageNo:string, thans?:number[], count?:number}>,
 *            warehouseHint:string, bad:string[], commaThanHint:boolean,
 *            ignoredCustomer:string, ignoredDate:string}}
 */
function parseThanList(raw) {
  const text = String(raw || '').trim();
  const items = [];
  const bad = [];
  const tailBits = [];
  let commaThanHint = false;
  let ignoredDate = '';

  const body = text.replace(/^sell\b/i, ' ');
  const segments = body.split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);

  for (const seg of segments) {
    if (isDateLike(seg)) { ignoredDate = ignoredDate || seg; continue; }
    // Strip only the leading noise words; keep the rest intact so the tail
    // ("from kano office to karibullah") survives for the store parse.
    const s = seg.replace(/^\s*(?:than|thans|package|packages|bale|bales|pkg|no|number)\s+/i, '').trim();
    if (!s) continue;

    let rest = '';
    let matched = false;

    // <bale>/<thanspec> — digits joined by + or -, with NO bare spaces, so
    // "1100/1 6/8/2026" stops the spec at `1` and leaves the date to the
    // tail instead of eating it as a than number.
    const slash = s.match(/^(\d+)\s*\/\s*(\d+(?:\s*[+-]\s*\d+)*)/);
    if (slash) {
      const thans = parseThanSpec(slash[2].trim());
      if (thans) {
        items.push({ packageNo: slash[1], thans });
        rest = s.slice(slash[0].length);
        matched = true;
      }
    } else if (/^\d+\s*\//.test(s)) {
      // "1100/abc" — he MEANT a than spec and it is unreadable. Report it
      // rather than quietly downgrading to "the whole bale 1100".
      bad.push(seg.trim());
      continue;
    }
    // <bale> x<count>
    if (!matched) {
      const times = s.match(/^(\d+)\s*[xX]\s*(\d+)/);
      if (times) {
        const count = parseInt(times[2], 10);
        if (isFinite(count) && count > 0 && count <= 500) {
          items.push({ packageNo: times[1], count });
          rest = s.slice(times[0].length);
          matched = true;
        }
      }
    }
    // bare bale number — open its chips, never auto-pick
    if (!matched) {
      const bare = s.match(/^(\d+)\b/);
      if (bare) {
        // A lone small number right after a `<bale>/<than>` item is almost
        // always someone writing "1100/1,2,3". Flag it so the caller can
        // show the `+` hint instead of hunting for a bale numbered "2".
        if (items.length && Number(bare[1]) <= 99) commaThanHint = true;
        items.push({ packageNo: bare[1] });
        rest = s.slice(bare[0].length);
        matched = true;
      }
    }

    if (!matched) {
      // No number at the front: it is tail text (store / customer / words)
      // when it reads like words, otherwise something we genuinely can't read.
      if (/[A-Za-z]/.test(s)) tailBits.push(s);
      else bad.push(seg.trim());
      continue;
    }
    if (rest && rest.trim()) tailBits.push(rest.trim());
  }

  // ── the tail: store, customer, date ────────────────────────────────
  let tail = tailBits.join(' ').replace(/\s+/g, ' ').trim();
  let ignoredCustomer = '';
  let warehouseHint = '';
  if (tail) {
    // Lift any date out of the tail first so it can never be mistaken for
    // a store name.
    const d = tail.match(/\b\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{2,4}\b/);
    if (d) {
      if (!ignoredDate) [ignoredDate] = d;
      tail = tail.replace(d[0], ' ').replace(/\s+/g, ' ').trim();
    }
    const cust = tail.match(/\bto\s+([A-Za-z][A-Za-z\s.'-]*)/i);
    if (cust) ignoredCustomer = cust[1].trim();
    // `@` is not a word character, so it needs its own alternative — a
    // \b in front of it never matches after a space ("… 1100/1 @ Idumota").
    const store = tail.match(/(?:\bfrom\b|\bin\b|\bat\b|@)\s*([A-Za-z][A-Za-z\s.'-]*?)(?=\s+to\b|$)/i);
    if (store) {
      warehouseHint = store[1].trim();
    } else {
      // Bare trailing words: "… 1082/1 kano office" — minus any customer
      // clause and the noise words. A store name always has letters.
      const bare = tail.replace(/\bto\s+[A-Za-z][A-Za-z\s.'-]*/ig, ' ')
        .replace(NOISE, ' ').replace(/@/g, ' ').replace(/\s+/g, ' ').trim();
      if (bare && /[A-Za-z]/.test(bare)) warehouseHint = bare;
    }
  }

  return { items, warehouseHint, bad, commaThanHint, ignoredCustomer, ignoredDate };
}

module.exports = { parseThanList, looksLikeThanList, _internals: { parseThanSpec } };
