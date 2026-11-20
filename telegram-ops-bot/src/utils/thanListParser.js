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
 *   sell 1100                              the whole bale — every available
 *                                          than loads (SELL-T3c, 25-Sep);
 *                                          he drops one on chips if needed
 *
 * Grammar rules that keep it unambiguous:
 *  - a comma (or "and") ALWAYS separates bales; so does a space between
 *    two bale numbers of two digits or more ("sell 1111 1112 kano");
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
const NOISE = /\b(sell|sale|return|returns|than|thans|from|package|packages|bale|bales|pkg|no|number|to|in|at|of)\b/gi;

/**
 * True when the text looks like the sell shorthand (cheap pre-check so the
 * controller can try this BEFORE paying for an AI parse).
 * @param {string} raw
 * @returns {boolean}
 */
function looksLikeThanList(raw) {
  const t = String(raw || '').trim();
  if (!/^sell\b/i.test(t)) return false;
  // The shorthand: at least one `<bale>/<than>` or `<bale> x<n>` token.
  if (/\d+\s*\/\s*\d/.test(t) || /\d+\s*[xX]\s*\d+/.test(t)) return true;
  // SELL-T3d (owner's Go, 04-Nov-2026 — "Sell 1111,1112 to Abba" got the
  // chips card): a BARE-ONLY list is read locally as well — the numbers
  // come straight after the verb (an optional package / bale word before
  // them), each of two digits or more, joined by commas, "and" or spaces,
  // then whatever tail (the buyer, a store). Every bare bale loads WHOLE
  // (SELL-T3c) on the review card. The worded form "Sell than 3 from
  // package 5801 …" is NOT claimed: its 3 is a than, not a bale.
  return /^sell\s+(?:(?:packages?|bales?|pkgs?|no\.?|numbers?)\s+)?\d{2,}(?:\s*(?:,|\band\b|\s)\s*\d{2,})*(?:\s|$|,)/i.test(t);
}

/* ── RET-6 (owner, 20-Nov-2026) — a return line with WORDS in it ──────────
 *
 * Abdul typed a return three ways and got the chips card each time:
 *   Return 631/1+2+3+4+5,614/1 to Idumota
 *   Return package 631/1+2+3+4+5,614/1 to Idumota
 *   Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota
 * The return line took only a bare list of numbers.
 *
 * Two readers, kept apart on purpose:
 *  - the PURE list (numbers, commas, `/`, `+`, `-`, `x` and nothing else)
 *    is read exactly as RET-5 read it, by parseThanList's own code below;
 *  - a line with words goes to `parseReturnWords`, a token scanner written
 *    for returns: every token is an item, a word, or a number that is NOT
 *    an item — and that last kind is always REPORTED (`bad`), never loaded
 *    and never dropped. The bot does not guess stock (§2).
 *
 * In a return the small words mean the opposite of a sale: `from` names the
 * buyer the goods come back from, `to` / `at` / `in` / `@` the store. Neither
 * is trusted: the flow shows them next to the sale record.
 */

/** The pure list RET-5 read — its claim and its reading are unchanged. */
const PURE_RETURN = /^return\s+\d[\d\s,/+x-]*$/i;
/** A numeric date with its year, both separators the same: 18/11/2026 · 18-11-26 · 18.11.2026. */
const NUM_DATE_SRC = '\\b\\d{1,2}([/.-])\\d{1,2}\\1(?:\\d{4}|\\d{2})\\b';
/** A bare bale number among words: two to six digits, no leading zero. */
const BARE_BALE = /^[1-9]\d{1,5}$/;
/** The longest return line with words that is read (a 60-bale list is ~500 characters). */
const RETURN_LINE_MAX = 1500;
/** A word after a number that makes the number a COUNT or a measure, never a bale. */
const COUNT_WORD = /^(?:bales?|thans?|yards?|yds?|pcs?|pieces?|packages?|pkgs?|rolls?|days?|weeks?|months?|years?|hours?|hrs?|mins?|minutes?|times?|naira|ngn|k|kg|m|am|pm|percent)$/i;
/** A word in front of a number that makes it something else than a bale ("design 9043", "5 bales of 9006"). */
const QUALIFIER = /^(?:design|designs|dsn|shade|shades|colou?r|rate|price|amount|qty|quantity|of|phone|tel|call)$/i;
/** Words that carry nothing in a return line. `and` is handled apart (it may sit inside a name). */
const FILLER = /^(?:pls|plz|please|kindly|abeg|oga|sir|ma|also|add|plus|thanks|thank|you|today|yesterday|tomorrow|now|ago|on|the|a|an|goods|packages?|bales?|pkgs?|no|nos|numbers?|thans?)$/i;

function isPureReturn(text) {
  const t = String(text || '').trim();
  return PURE_RETURN.test(t) && !new RegExp(NUM_DATE_SRC).test(t);
}

/**
 * Read a return line that has words in it.
 * @param {string} raw the whole typed line (the verb is optional)
 * @returns {object} parseThanList's shape plus `isReturn`, `returnFrom`,
 *   `returnTo`, `returnOther` and the facts the claim rule needs.
 */
function parseReturnWords(raw) {
  const out = {
    items: [], warehouseHint: '', bad: [], commaThanHint: false, ignoredCustomer: '', ignoredDate: '',
    isReturn: true, returnFrom: '', returnTo: '', returnOther: '',
    firstIsItem: false, firstConfident: false, leadWords: [], leadFrom: false, tooLong: false,
  };
  // White space is collapsed first and the length capped, so every pattern
  // below runs in linear time on a short string.
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (t.length > RETURN_LINE_MAX) { out.tooLong = true; return out; }
  t = t.replace(/^return(?:s|ed|ing)?\b[ :,-]*/i, '');
  // Dates are set aside (the date step asks): a numeric one with its year,
  // and day + month with a year only when it IS a year (19xx / 20xx) —
  // "18 Nov 6189" keeps bale 6189.
  const lift = (m) => { if (!out.ignoredDate) out.ignoredDate = m.trim(); return ' '; };
  t = t.replace(new RegExp(NUM_DATE_SRC, 'g'), lift)
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)? ${MONTH_WORD}\\b(?:,? (?:19|20)\\d{2}\\b)?`, 'gi'), lift)
    .replace(new RegExp(`\\b${MONTH_WORD} \\d{1,2}(?:st|nd|rd|th)?\\b(?:,? (?:19|20)\\d{2}\\b)?`, 'gi'), lift);
  // The worded forms, rewritten into the list grammar (R4 — the same card):
  // "than 2 from bale 5801" · "thans 1+2 of package 631" → 5801/2 · 631/1+2.
  t = t.replace(/\bthans? (\d+(?: ?[+-] ?\d+)*) (?:from|of|in) (?:the )?(?:(?:packages?|bales?|pkgs?) )?(?:(?:no\.?|numbers?) )?(\d+)\b/gi,
    (_m, spec, bale) => `${bale}/${spec.replace(/ /g, '')}`);
  // "bale 631 than 3" → 631/3 — only when the first number can be a bale and
  // the second a than; "2 thans 631" is a count in front of a bale.
  t = t.replace(/\b(\d+) thans? (\d+(?: ?[+-] ?\d+)*)(?![\d/])/gi, (m, bale, spec) => {
    const top = Math.max(...spec.split(/[+-]/).map((n) => parseInt(n, 10)));
    return (BARE_BALE.test(bale) && top < 100 && parseInt(bale, 10) > top) ? `${bale}/${spec.replace(/ /g, '')}` : m;
  });
  // Glue the list operators so one item is one token: "631 / 1 + 2" → 631/1+2,
  // "631/1 - 3" → 631/1-3, "771 x 3" → 771x3.
  t = t.replace(/(\d) ?\/ ?(?=\d)/g, '$1/');
  for (let prev = ''; prev !== t;) { prev = t; t = t.replace(/(\/\d+(?:[+-]\d+)*) ?([+-]) ?(?=\d)/g, '$1$2'); }
  t = t.replace(/(\d) ?[xX] ?(?=\d)/g, '$1x').replace(/@/g, ' at ');

  const toks = t.split(/[ ,;&]+/)
    .map((x) => x.replace(/^[#(["'“‘]+/, '').replace(/[.,;:!?)\]"'”’]+$/, ''))
    .filter(Boolean);
  const seq = [];                                   // { kind: 'item' | 'bad' | 'word', text }
  let sawNumber = false;
  const number = (kind, confident) => {
    if (!sawNumber) { sawNumber = true; out.firstIsItem = kind === 'item'; out.firstConfident = !!confident; }
  };
  for (let i = 0; i < toks.length; i += 1) {
    const tok = toks[i];
    const prevWord = seq.length && seq[seq.length - 1].kind === 'word' ? seq[seq.length - 1].text : '';
    if (/^\d+\/\d+(?:[+-]\d+)*$/.test(tok) || /^\d+x\d+$/i.test(tok)) {
      const got = readItem(tok);
      const ok = got && !got.bad && got.used === tok.length && !got.bare && !/^0/.test(tok) && !QUALIFIER.test(prevWord);
      number(ok ? 'item' : 'bad', ok);
      if (ok) { out.items.push(got.item); seq.push({ kind: 'item', text: tok }); }
      else { out.bad.push(tok); seq.push({ kind: 'bad', text: tok }); }
      continue;
    }
    if (/^\+?\d+$/.test(tok)) {
      const next = toks[i + 1] || '';
      let badText = '';
      if (QUALIFIER.test(prevWord)) { badText = `${prevWord} ${tok}`; seq.pop(); }   // "design 9043", "of 9006"
      else if (COUNT_WORD.test(next)) { badText = `${tok} ${next}`; i += 1; }
      else if (/^(?:\+|0)/.test(tok) || tok.length >= 7) {
        // a phone number: the digit groups that follow belong to it
        badText = tok;
        while (/^\d+$/.test(toks[i + 1] || '')) { badText += ` ${toks[i + 1]}`; i += 1; }
      } else if (!BARE_BALE.test(tok)) {
        badText = tok;                              // a single digit: "631/1, 2"
        if (out.items.length) out.commaThanHint = true;
      }
      number(badText ? 'bad' : 'item', false);
      if (badText) { out.bad.push(badText); seq.push({ kind: 'bad', text: badText }); }
      else { out.items.push({ packageNo: tok }); seq.push({ kind: 'item', text: tok }); }
      continue;
    }
    if (/\d/.test(tok) && !/^\p{L}/u.test(tok)) {
      // digits glued to something else and not a name: 24hrs, 614kg, 10:30, 50%, 9043-B, 631/abc
      number('bad', false);
      out.bad.push(tok); seq.push({ kind: 'bad', text: tok });
      continue;
    }
    if (/^[-/+]+$/.test(tok)) continue;             // a stray operator
    if (/^[xX]\d+$/.test(tok)) {                    // a count cut off from its bale: "… to Idumota x3"
      out.bad.push(tok); seq.push({ kind: 'bad', text: tok });
      continue;
    }
    seq.push({ kind: 'word', text: tok });           // a word (a name may carry digits: "A1")
  }

  // The words: what stands before the first number, then the clauses.
  const firstNum = seq.findIndex((e) => e.kind !== 'word');
  const lead = (firstNum < 0 ? seq : seq.slice(0, firstNum)).map((e) => e.text).filter((w) => !FILLER.test(w) && !/^and$/i.test(w));
  out.leadFrom = lead.length > 0 && /^from$/i.test(lead[0]);
  out.leadWords = out.leadFrom ? lead.slice(1) : lead;
  const said = { from: [], to: [], other: [] };
  let mode = 'other';
  for (let i = 0; i < seq.length; i += 1) {
    const e = seq[i];
    if (e.kind !== 'word') { mode = 'other'; continue; }           // a number ends a clause
    const w = e.text;
    if (/^from$/i.test(w)) { mode = 'from'; continue; }
    if (/^(?:to|into|at|in)$/i.test(w)) { mode = 'to'; continue; }
    if (/^and$/i.test(w)) {
      // inside a name ("Sani and Sons") it stays; between items it is nothing
      const nxt = seq[i + 1];
      if (mode !== 'other' && said[mode].length && nxt && nxt.kind === 'word' && (!FILLER.test(nxt.text) || /^(?:a|an|the)$/i.test(nxt.text))
        && !/^(?:from|to|into|at|in|and)$/i.test(nxt.text)) said[mode].push(w);
      continue;
    }
    // inside a name an article is part of it ("from A and B", "to The Place")
    if (FILLER.test(w) && !(mode !== 'other' && /^(?:a|an|the)$/i.test(w))) continue;
    said[mode].push(w);
  }
  out.returnFrom = said.from.join(' ');
  out.returnTo = said.to.join(' ');
  out.returnOther = said.other.join(' ');
  return out;
}

/**
 * RET-5 — a typed RETURN line: `Return 771, 779, 6189/5`. A bare-only list
 * qualifies (every typed return goes through the review card — owner ruling
 * R4, 20-Oct-2026); that pure list is claimed exactly as before.
 *
 * RET-6 (20-Nov-2026) — a line with words is claimed when its FIRST number
 * is a list item and it is clear the numbers are what the line is about:
 * nothing but noise in front of them, or `from <buyer>`, or a short name
 * followed by an item written with `/` or `x`. A sentence that opens with a
 * count ("Return 5 bales of 9006"), a phone number, an amount, or has no
 * item at all is NOT claimed — it gets the Return hint.
 */
function looksLikeReturnList(raw) {
  const t = String(raw || '').trim();
  if (!/^return/i.test(t)) return false;
  if (isPureReturn(t)) return true;
  if (!/^return(?:s|ed|ing)?\b/i.test(t.replace(/\s+/g, ' '))) return false;
  const p = parseReturnWords(t);
  if (p.tooLong || !p.items.length || !p.firstIsItem) return false;
  if (!p.leadWords.length) return true;
  if (p.leadFrom) return p.leadWords.length <= 6;
  return p.firstConfident && p.leadWords.length <= 4;
}

/**
 * TRF-23 (owner's Go, 31-Oct-2026) — a typed TRANSFER line:
 * `Transfer 832, 1186, 786 to kano` · `Move package 5804 to Lagos`.
 *
 * Until today this was the ONE typed door with no local reader: it rode
 * the AI parser alone, so when the provider stopped answering (31-Oct —
 * Abdul's four tries) the offline fallback, which knows no "transfer",
 * bounced it as "Need more info" while sells and returns kept working.
 * The verb opens the line (an optional please / pls / kindly in front) and
 * at least one number follows; everything else — bale/package words, a
 * `/than` suffix, the `to <store>` tail — is for
 * transferFlow.parseTypedTransfer, and every number is resolved against
 * live stock on the preload card (§2: the bot never picks bales).
 * @param {string} raw
 * @returns {boolean}
 */
function looksLikeTransferLine(raw) {
  const t = String(raw || '').trim();
  return /^(?:please\s+|pls\s+|kindly\s+)?(?:transfer|move)\b[^\n]*\d/i.test(t);
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

// A month NAME, whole word only: `aug`, `august`, `sept` — never the start
// of another word. The old prefix test (`mar[a-z]*`) read a buyer called
// Maryam, Mariam, Mayowa, Julius or Augustine as a month, so
// "Sell 1082, 1091 to Maryam" dropped bale 1091 as "a date".
const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
// A date written with a month word: "06 august 2026", "6th Aug", "August 6 2026",
// "august 2026".
// A day number is required, so a buyer called May or April is not a date.
const WORD_DATE_SRC = `(?:\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b(?:[\\s,]+\\d{2,4}\\b)?|${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:[\\s,]+\\d{2,4}\\b)?|${MONTH_WORD}\\s+(?:19|20)\\d{2}\\b)`;
const WORD_DATE = new RegExp(`\\b${WORD_DATE_SRC}`, 'i');
const WORD_DATE_ONLY = new RegExp(`^${WORD_DATE_SRC}$`, 'i');
const WORD_DATE_AT_FRONT = new RegExp(`^${WORD_DATE_SRC}`, 'i');

/** True when a segment IS a date, not a bale ("06 august 2026", "6/8/26"). */
function isDateLike(s) {
  const t = String(s).trim();
  if (WORD_DATE_ONLY.test(t)) return true;               // 06 august 2026 — the whole segment
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(t)) return true;  // 06/08/2026
  if (/^(today|yesterday|tomorrow)$/i.test(t)) return true;
  return false;
}

/**
 * A numeric date opening a string: `06/08/2026`, `6-8-26`, `06.08.2026`,
 * and year first `2026-08-06`. Only the space run asks: without the dotted
 * and year-first forms it read `06` / `2026` as bale numbers.
 */
const DATE_AT_FRONT = /^(?:\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}|(?:19|20)\d{2}\s*[.-]\s*\d{1,2}\s*[.-]\s*\d{1,2})\b/;

/**
 * Read ONE item off the front of `s`.
 * @param {string} s
 * @returns {{item:{packageNo:string, thans?:number[], count?:number}, used:number, bare?:boolean}
 *   |{bad:true}|null} the item and how many characters it used; `bad` for a
 *   than spec that cannot be read; null when `s` does not open with a number.
 */
function readItem(s) {
  // <bale>/<thanspec> — digits joined by + or -, with NO bare spaces, so
  // "1100/1 6/8/2026" stops the spec at `1` and leaves the date to the
  // tail instead of eating it as a than number.
  const slash = s.match(/^(\d+)\s*\/\s*(\d+(?:\s*[+-]\s*\d+)*)/);
  if (slash) {
    const thans = parseThanSpec(slash[2].trim());
    if (thans) return { item: { packageNo: slash[1], thans }, used: slash[0].length };
    // A spec that cannot be read (`1100/5-3`) is reported — never quietly
    // downgraded to "the whole bale 1100" (SELL-T3).
    return { bad: true };
  } else if (/^\d+\s*\//.test(s)) {
    return { bad: true };
  }
  // <bale> x<count>
  const times = s.match(/^(\d+)\s*[xX]\s*(\d+)/);
  if (times) {
    const count = parseInt(times[2], 10);
    if (isFinite(count) && count > 0 && count <= 500) {
      return { item: { packageNo: times[1], count }, used: times[0].length };
    }
  }
  // bare bale number — returned bare; the flow loads the whole bale
  // (SELL-T3c). The parser never decides what a number means.
  const bare = s.match(/^(\d+)\b/);
  if (bare) return { item: { packageNo: bare[1] }, used: bare[0].length, bare: true };
  return null;
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

  // RET-6 — a return line with words has its own reader; the pure list and
  // every sell line are read by the code below, unchanged.
  const isReturn = /^return/i.test(text);
  if (isReturn && !isPureReturn(text)) {
    const p = parseReturnWords(text);
    return {
      items: p.items, warehouseHint: '', bad: p.bad, commaThanHint: p.commaThanHint, ignoredCustomer: '',
      ignoredDate: p.ignoredDate, isReturn: true, returnFrom: p.returnFrom, returnTo: p.returnTo,
      returnOther: p.returnOther, ...(p.tooLong ? { tooLong: true } : {}),
    };
  }

  const body = text.replace(/^(?:sell|return)\b/i, ' ');
  const segments = body.split(/,|\band\b/i).map((s) => s.trim()).filter(Boolean);

  const take = (got) => {
    // A lone small number right after a `<bale>/<than>` item is almost
    // always someone writing "1100/1,2,3". Flag it so the caller can
    // show the `+` hint instead of hunting for a bale numbered "2".
    if (got.bare && items.length && Number(got.item.packageNo) <= 99) commaThanHint = true;
    items.push(got.item);
  };

  for (const seg of segments) {
    if (isDateLike(seg)) { ignoredDate = ignoredDate || seg; continue; }
    // Strip only the leading noise words; keep the rest intact so the tail
    // ("from kano office to karibullah") survives for the store parse.
    const s = seg.replace(/^\s*(?:than|thans|package|packages|bale|bales|pkg|no|number)\s+/i, '').trim();
    if (!s) continue;

    const first = readItem(s);
    if (first && first.bad) {
      // "1100/abc" — he MEANT a than spec and it is unreadable. Report it
      // rather than quietly downgrading to "the whole bale 1100".
      bad.push(seg.trim());
      continue;
    }
    if (!first) {
      // No number at the front: it is tail text (store / customer / words)
      // when it reads like words, otherwise something we genuinely can't read.
      if (/[A-Za-z]/.test(s)) tailBits.push(s);
      else bad.push(seg.trim());
      continue;
    }
    take(first);
    let rest = s.slice(first.used);

    // SPACES separate bales too ("sell 1111 1112 kano" — SELL-T3d). The run
    // goes on only while the next thing is a bale number (two digits or
    // more) and not a date; the first word ends it and starts the tail.
    // Before this the second number was dropped silently, or glued onto the
    // store name ("a store called 1112 kano").
    for (;;) {
      const next = rest.replace(/^\s+/, '');
      if (!/^\d{2,}/.test(next) || DATE_AT_FRONT.test(next) || WORD_DATE_AT_FRONT.test(next)) break;
      const more = readItem(next);
      if (!more) break;
      // A than spec that cannot be read is reported, never loaded as the
      // whole bale: `1100/abc`, and a range that makes no sense (`1100/5-3`),
      // which readItem hands back as the bare bale with `/5-3` left over.
      if (more.bad || (more.bare && /^\s*\//.test(next.slice(more.used)))) {
        const [token] = next.match(/^\S+/);
        bad.push(token);
        rest = next.slice(token.length);
        continue;
      }
      take(more);
      rest = next.slice(more.used);
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
    // … numeric ("6/8/26") or with a month word ("kano 06 august 2026").
    const d = tail.match(/\b\d{1,2}\s*[/-]\s*\d{1,2}\s*[/-]\s*\d{2,4}\b/) || tail.match(WORD_DATE);
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

  if (isReturn) {
    return { items, warehouseHint: '', bad, commaThanHint, ignoredCustomer: '', ignoredDate, isReturn: true, returnFrom: '', returnTo: '', returnOther: '' };
  }
  return { items, warehouseHint, bad, commaThanHint, ignoredCustomer, ignoredDate };
}

module.exports = { parseThanList, looksLikeThanList, looksLikeReturnList, looksLikeTransferLine, _internals: { parseThanSpec, parseReturnWords, isPureReturn } };
