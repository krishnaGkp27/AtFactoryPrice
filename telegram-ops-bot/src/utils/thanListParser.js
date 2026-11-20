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

/** Words that follow a COUNT, never a bale number: "Return 5 bales of 9006". */
const COUNT_WORD = /^(?:bales?|thans?|yards?|yds?|pcs?|pieces?|packages?|pkgs?|rolls?|days?|weeks?|months?|hours?|hrs?|times?|naira|ngn)\b/i;
/** A bare bale number among WORDS: two to six digits, no leading zero — a phone number or a `5` is never one. */
const BARE_BALE = /^[1-9]\d{1,5}$/;
/** The longest return line read (a 60-bale list is ~500 characters). */
const RETURN_LINE_MAX = 1500;
/** Words in front of the numbers that carry no meaning: "package", "the goods". */
const LEAD_NOISE = /^(?:(?:the|a|an)\s+)?(?:packages?|bales?|pkgs?|goods|no\.?|numbers?)\b[\s:.#-]*/i;
const NOISE_WORD = /^(?:the|a|an|packages?|bales?|pkgs?|goods|no\.?|numbers?|thans?)$/i;

/**
 * RET-6 (owner, 20-Nov-2026 — Abdul's three lines all got the chips card:
 * `Return 631/1+2+3+4+5,614/1 to Idumota`, the same with `package` in
 * front, and `Return package from soldier madam 631/… to Idumota`) — take a
 * typed RETURN line apart: the verb, the words in front of the numbers
 * (`package`, `from <buyer>`), and the list with whatever follows it.
 *
 * In a return the small words mean the OPPOSITE of a sale: `from` names the
 * buyer the goods come back from, `to` / `at` / `in` the store they come
 * back to. Neither is ever trusted — the flow checks both against the sale
 * record and says so on the card when they differ.
 *
 * @param {string} raw
 * @returns {{from:string, body:string}|null} null when no number list opens
 *   the line once those words are set aside.
 */
function splitReturnLine(raw) {
  // Whitespace is collapsed FIRST and the length capped: every pattern below
  // then runs in linear time (a run of 4,000 spaces after "Return from" used
  // to take over a minute and froze the bot for everyone).
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  if (t.length > RETURN_LINE_MAX) return null;
  // The pure list RET-5 read (numbers, commas, `/`, `+`, `-`, `x` and nothing
  // else) keeps its exact old reading; the stricter rules are for lines with words.
  const pure = /^return \d[\d ,/+x-]*$/i.test(t);
  const verb = t.match(/^return(?:s|ed|ing)?\b[ :,-]*/i);
  if (!verb) return null;
  t = t.slice(verb[0].length);
  // The worded forms, rewritten into the list grammar (R4 — they open the
  // same card): "than 2 from bale 5801" · "thans 1+2 of package 631" →
  // `5801/2` · `631/1+2`.
  t = t.replace(/\bthans? (\d+(?: ?[+-] ?\d+)*) (?:from|of|in) (?:the )?(?:(?:packages?|bales?|pkgs?) )?(?:(?:no\.?|numbers?) )?(\d+)\b/gi,
    (_m, spec, bale) => `${bale}/${spec.replace(/ /g, '')}`);
  // "bale 631 than 3" → `631/3` — only when the first number can be a bale
  // and the second a than: "2 thans 631" is a COUNT in front of a bale and
  // is left alone (it was read as bale 2, than 631).
  t = t.replace(/\b(\d+) thans? (\d+(?: ?[+-] ?\d+)*)(?![\d/])/gi, (m, bale, spec) => {
    const nums = spec.split(/[+-]/).map((n) => parseInt(n, 10));
    const top = Math.max(...nums);
    return (BARE_BALE.test(bale) && top < 100 && parseInt(bale, 10) > top) ? `${bale}/${spec.replace(/ /g, '')}` : m;
  });
  const dropNoise = () => { let prev; do { prev = t; t = t.replace(LEAD_NOISE, ''); } while (t !== prev); };
  dropNoise();
  // "from <buyer>" in front of the numbers: the words up to the first digit.
  let from = '';
  if (/^from /i.test(t)) {
    const at = t.search(/\d/);
    if (at < 0) return null;
    const said = t.slice(5, at).replace(/[ :,-]+$/, '');
    if (said.includes(',')) return null;            // "from Abba, 0801…, Kano" is not a return list
    const words = said.split(' ').filter(Boolean);
    while (words.length && NOISE_WORD.test(words[words.length - 1])) words.pop();   // "from soldier madam package 631"
    while (words.length && NOISE_WORD.test(words[0])) words.shift();                // "from bale 5801"
    from = words.join(' ');
    t = t.slice(at);
  }
  dropNoise();
  // A date in front of the numbers ("Return 18 Nov 631/1") is set aside — the
  // date step asks; its day was read as bale 18.
  // A numeric date with its year ("18/11/2026 631/1") is a date in any line:
  // no list item has two slashes. (It was read as bale 18, than 11.)
  let lead = t.match(DATE_AT_FRONT);
  if (!lead && !pure) {
    lead = t.match(WORD_DATE_AT_FRONT);
    // "18 Nov 631/1": the 631 is a bale, not a year — a year has two or four
    // digits and is never followed by `/` or `x`.
    if (lead && (/(?:^|\D)\d{3}$/.test(lead[0]) || /^ ?[/xX]/.test(t.slice(lead[0].length)))) {
      lead = t.match(DAY_MONTH_AT_FRONT);
    }
  }
  if (lead) { t = t.slice(lead[0].length).replace(/^[ ,:-]+/, ''); dropNoise(); }
  if (!/^\d/.test(t)) return null;
  return { from, body: t, pure };
}

/** Does `body` open with a list item — and not with a count ("5 bales of 9006")? */
function opensWithList(body, pure) {
  if (pure) return true;                               // the pure list, as since RET-5
  if (/^\d+\s*\/\s*\d/.test(body)) return true;        // 631/1…
  if (/^\d+\s*[xX]\s*\d+/.test(body)) return true;     // 771 x3
  const bare = body.match(/^(\d+)\b[ ,]*([\s\S]*)$/);
  // …a bale number (two to six digits, no leading zero — not a phone number,
  // not an amount written with a 0) that is not a count ("5 bales", "12 days").
  return !!bare && BARE_BALE.test(bare[1]) && !COUNT_WORD.test(bare[2]);
}

/**
 * RET-5 — a typed RETURN line: `Return 771, 779, 6189/5`. A bare-only list
 * qualifies (every typed return goes through the review card — owner ruling
 * R4, 20-Oct-2026).
 *
 * RET-6 (20-Nov-2026) — the line may also carry words: `package` / `bale`
 * in front, the buyer (`from Soldier Madam`, before or after the numbers)
 * and the store (`to Idumota`). The numbers decide; the words are checked
 * against the sale record on the card. A sentence that opens with a count
 * ("Return 5 bales of 9006") or has no number list is NOT claimed.
 */
function looksLikeReturnList(raw) {
  const split = splitReturnLine(raw);
  return !!split && opensWithList(split.body, split.pure);
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
/** Day and month only, opening a string: "18 Nov" (RET-6 — see splitReturnLine). */
const DAY_MONTH_AT_FRONT = new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_WORD}\\b`, 'i');

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

  // RET-6 — a return line is taken apart first: the buyer may stand in
  // front of the numbers, and its small words mean the opposite of a sale's.
  const ret = /^return/i.test(text) ? splitReturnLine(text) : null;
  const body = ret ? ` ${ret.body}` : text.replace(/^(?:sell|return)\b/i, ' ');
  // A return line with WORDS in it is read more strictly than the pure list
  // (which stays exactly as RET-5 read it): a bare number must look like a
  // bale, a count is reported, and "and" inside a buyer's name ("Sani and
  // Sons") no longer cuts the line — it separates only when a number follows.
  const strict = !!ret && !ret.pure;
  const segments = (strict
    ? body.split(/,|\band\b(?= (?:(?:thans?|packages?|bales?|pkgs?|no\.?|numbers?) )?\d)/i)
    : body.split(/,|\band\b/i)).map((s) => s.trim()).filter(Boolean);

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
    if (strict && first.bare) {
      // "2 thans 614" / "5 bales" — a count, never a bale: reported, and the
      // rest of the segment is still read.
      const after = s.slice(first.used).replace(/^\s+/, '');
      const count = after.match(COUNT_WORD);
      if (count || !BARE_BALE.test(first.item.packageNo)) {
        bad.push(count ? `${first.item.packageNo} ${count[0]}` : first.item.packageNo);
        if (!count && items.length && Number(first.item.packageNo) <= 99) commaThanHint = true;
        const left = count ? after.slice(count[0].length) : after;
        if (left.trim()) tailBits.push(left.trim());
        continue;
      }
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
    if (ret) {
      // A number left among the words is NEVER dropped: it is an item when
      // it reads as one ("… to Idumota 614/1", "… package 614/1"), otherwise
      // it is reported as unreadable.
      tail = tail.replace(/\d+(?: ?\/ ?\d+(?: ?[+-] ?\d+)*| ?[xX] ?\d+)?(?:[/+-]\S*)?/g, (tok) => {
        const got = readItem(tok);
        const whole = got && !got.bad && got.used === tok.length;
        if (whole && (!got.bare || BARE_BALE.test(got.item.packageNo))) items.push(got.item);
        else bad.push(tok.trim());
        return ' ';
      }).replace(/\s+/g, ' ').trim();
      // RET-6 — `to` / `at` / `in` / `@` names the STORE, `from` the BUYER.
      const clean = (v) => ` ${String(v || '').replace(NOISE, ' ').replace(/[.,;:!?]+/g, ' ')} `
        .replace(/ [-/]+(?= )/g, ' ')                       // a stray `/` or `-` left by a number
        .replace(/\s+/g, ' ').trim().replace(/(?:(?:^| )(?:on|please|pls|kindly|thanks|today|now))+$/i, '').trim();
      const storeM = tail.match(/(?:\bto\b|\binto\b|\bat\b|\bin\b|@)\s*([A-Za-z][A-Za-z\s.'-]*?)(?=\s+from\b|$)/i);
      const custM = tail.match(/\bfrom\s+([A-Za-z][A-Za-z\s.'-]*?)(?=\s+(?:to|into|at|in)\b|\s*@|$)/i);
      let rest = tail;
      if (storeM) rest = rest.replace(storeM[0], ' ');
      if (custM) rest = rest.replace(custM[0], ' ');
      return {
        items, warehouseHint: '', bad, commaThanHint, ignoredCustomer: '', ignoredDate,
        isReturn: true,
        returnFrom: ret.from || (custM ? clean(custM[1]) : ''),
        returnTo: storeM ? clean(storeM[1]) : '',
        returnOther: clean(rest.replace(/@/g, ' ').replace(/\band\b/gi, ' ')),
      };
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

  if (ret) {
    return {
      items, warehouseHint: '', bad, commaThanHint, ignoredCustomer: '', ignoredDate,
      isReturn: true, returnFrom: ret.from, returnTo: '', returnOther: '',
    };
  }
  return { items, warehouseHint, bad, commaThanHint, ignoredCustomer, ignoredDate };
}

module.exports = { parseThanList, looksLikeThanList, looksLikeReturnList, looksLikeTransferLine, _internals: { parseThanSpec, splitReturnLine } };
