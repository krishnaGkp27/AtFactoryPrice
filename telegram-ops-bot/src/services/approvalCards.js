/**
 * APU-1 — the single place approval-card content is built and request
 * attachments are forwarded to admins.
 *
 * Owner directive (18-Jul-2026): every approval rides one channel with the
 * same stages, and the approving admin must see the SAME detail level the
 * classic sale card established (customer + phone/address, salesperson,
 * canonical date, per-item lines with warehouse, totals, attached document
 * forwarded before the decision). See docs/AUDIT_APPROVALS_2026-07-18.md.
 *
 * Rules for builders here:
 *   - PLAIN TEXT ONLY. notifyAdminsApprovalRequest MarkdownV2-escapes the
 *     whole summary, so any '*'/'`' written here renders literally.
 *   - Render from the queued actionJSON wherever possible so the reminder
 *     sweep and the morning digest can rebuild the SAME card later from the
 *     sheet row alone (no session required).
 *   - Missing lookups (CRM, users) degrade silently to fewer lines — a card
 *     must never fail to render.
 */

'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const usersRepository = require('../repositories/usersRepository');
const { fmtQty } = require('../utils/format');
const fmtDate = require('../utils/formatDate');

/**
 * Resolve a Telegram user id to a human-readable display name.
 *
 * Sources, in order (owner 19-Jul: "everything human-readable"):
 *   1. Users sheet (user_id → name) — staff added via the bot.
 *   2. PendingUsers sheet — people who /start-ed but were never onboarded.
 *   3. Telegram itself via bot.getChat — works for ANYONE who has messaged
 *      the bot, including env-ADMIN_IDS admins who predate the Users sheet
 *      and therefore have no row in it (the exact case behind raw ids
 *      appearing on digest cards). Pass `bot` whenever you have one.
 *   4. The raw id, only when every source comes up empty.
 * Results are cached ~10 min so list renders don't hammer Sheets/Telegram.
 */
const _nameCache = new Map(); // id → { label, at }
const NAME_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * LBL-1 (owner, 07-Aug-2026) — the owner's vocabulary for action codes, in
 * ONE place. "Sale bundle is not actually a bundle. It is a bale. A bale
 * means a package." The queue keeps the internal codes (they are stamped on
 * every pending row and locked into the approval policy — renaming them
 * would orphan history); only the words humans read change. Every surface
 * that shows an action name (inbox chips, generic cards, the reminder
 * sweep, the morning digest, the dual-admin notice) must come through here.
 */
const ACTION_LABELS = {
  sale_bundle: 'sale bale',
  revert_sale_bundle: 'revert sale bale',
  sell_package: 'sell bale',
  return_package: 'return bale',
  transfer_package: 'transfer bale',
};

/** Human words for an internal action code. */
function actionLabel(action) {
  const a = String(action || 'action');
  return ACTION_LABELS[a] || a.replace(/_/g, ' ');
}

async function resolveUserLabel(userId, bot) {
  const key = String(userId || '').trim();
  if (!key) return 'Unknown';
  const hit = _nameCache.get(key);
  if (hit && Date.now() - hit.at < NAME_CACHE_TTL_MS) return hit.label;
  let label = '';
  try {
    const u = await usersRepository.findByUserId(key);
    if (u && u.name) label = u.name;
  } catch (_) { /* next source */ }
  if (!label) {
    try {
      const pendingUsersRepository = require('../repositories/pendingUsersRepository');
      const rows = await pendingUsersRepository.getAll();
      const p = rows.find((r) => String(r.telegram_id) === key);
      if (p) label = [p.first_name, p.last_name].filter(Boolean).join(' ') || (p.username ? `@${p.username}` : '');
    } catch (_) { /* next source */ }
  }
  if (!label && bot && typeof bot.getChat === 'function') {
    try {
      const c = await bot.getChat(key);
      label = [c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : '');
    } catch (_) { /* user never messaged the bot */ }
  }
  if (!label) label = key;
  _nameCache.set(key, { label, at: Date.now() });
  return label;
}

/** Test hook — clear the name cache. */
function _resetNameCacheForTests() { _nameCache.clear(); }

/** Best-effort CRM enrichment — returns { phone, address } or {}. */
async function customerContact(customerName) {
  try {
    const crmService = require('./crmService');
    const cust = await crmService.getCustomer(customerName);
    if (cust) return { phone: cust.phone || '', address: cust.address || '' };
  } catch (_) { /* CRM down ≠ no card */ }
  return {};
}

/**
 * Gold-standard sale card (shape of the classic Sell Bale card,
 * telegramController ~6140-6220).
 *
 * @param {object} p
 * @param {string} p.headline       e.g. 'Sale · Snap'
 * @param {string} p.customer
 * @param {string} [p.salesPerson]
 * @param {string} [p.paymentMode]
 * @param {string} [p.salesDate]    raw; canonicalized via fmtDate
 * @param {Array<{packageNo:string,design:string,shade?:string,thans?:number,yards?:number,warehouse?:string}>} p.items
 * @param {boolean} [p.docAttached]
 * @param {string}  [p.docLabel]    default 'Sales bill'
 */
/**
 * CARD-2 (owner 22-Jul): canonical item order for every sale card —
 * design first, then shade, then bale number (all numeric-aware), so
 * mixed batches read grouped instead of pick order.
 */
function sortSaleItems(items) {
  const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });
  return [...(items || [])].sort((a, b) =>
    cmp(a.design, b.design) || cmp(a.shade, b.shade) || cmp(a.packageNo, b.packageNo));
}

/**
 * CARD-3 (owner, 10-Aug-2026) — "I cannot see the details properly … there
 * is repetition of words like 'shade', 'bale', 'than'. Make it elegant and
 * short."
 *
 * The old card wrote the three nouns once per LINE. A five-than Kano sale
 * printed "Bale" five times, "Than" five times and "thans" six times, and
 * the numbers that matter drowned in them. CARD-3 states each noun exactly
 * once — in a key line at the foot — and writes the goods in the same
 * grammar Abdul already types (`bale/than`, `#shade`):
 *
 *   🧾 Sale · Kano office
 *   👤 set at approval
 *   🧑 Abdul · 📅 09-Aug-2026
 *   📎 Sales bill
 *
 *   🧵 77014 · Cashmere — 3t · 90 yd
 *     #11 → 1100/1 · 1091/2
 *     #14 → 1082/1
 *   🧵 77020 — 2t · 60 yd
 *     #03 → 1122/1 · 1113/1
 *
 *   Σ 5t · 150 yd
 *   (bale/than · #shade)
 *
 * CARD-5 (owner, 29-Aug-2026: a Kano than sale read "Σ 28 than · 842 yd ·
 * 7 bale" — "it doesn't make sense here since the bale gets already open
 * and we supply in thans") — the tallies speak each item's OWN packaging,
 * in the rule-6c grammar (unitDisplayService.formatCounts): a than item
 * counts thans, a whole-bale item counts its printed number as one B.
 * "Σ 28t · 842 yd" than-only · "Σ 7B · 1,470 yd" whole-bale ·
 * "Σ 4B + 8t · 962 yd" mixed. A whole bale's internal than count is the
 * bale's business, not the tally's; bale NUMBERS stay in the shade lines.
 *
 * Nothing is dropped: every fact the SAB-1/APF-1/CARD-2 card carried is
 * still here (design, category, shade, bale, than, yards, warehouse,
 * salesperson, date, payment, doc, no-stock warnings) — only the words
 * around them are gone. Warnings stay in full sentences: an exception is
 * the one thing that must never be terse.
 */

/** One item as a token in the typed grammar: `1100/1`, or `1100 ×3`. */
function itemToken(it, showWarehouse) {
  const pkg = String(it.packageNo ?? '?');
  let tok;
  if (it.type === 'than' && it.thanNo) tok = `${pkg}/${it.thanNo}`;
  else if (Number(it.thans) > 1) tok = `${pkg} ×${it.thans}`;
  else tok = pkg;
  if (it.noStock) tok += ' ⚠️';
  if (showWarehouse && it.warehouse) tok += ` @${it.warehouse}`;
  return tok;
}

async function buildSaleCard(p) {
  const items = sortSaleItems(p.items);
  // The store is a header fact when the whole request ships from one place;
  // a mixed request keeps it per item so no bale is mis-attributed.
  const stores = [...new Set(items.map((it) => String(it.warehouse || '')).filter(Boolean))];
  const oneStore = stores.length === 1 ? stores[0] : '';

  let text = `🧾 ${p.headline || 'Sale'}${oneStore ? ` · ${oneStore}` : ''}`;
  text += `\n👤 ${p.customer || 'set at approval'}`;
  const contact = await customerContact(p.customer);
  const who = [contact.phone, contact.address].filter(Boolean).join(' · ');
  if (who) text += `\n   ${who}`;
  const meta = [];
  if (p.salesPerson) meta.push(`🧑 ${p.salesPerson}`);
  if (p.salesDate) meta.push(`📅 ${fmtDate(p.salesDate)}`);
  if (p.paymentMode) meta.push(`💳 ${p.paymentMode}`);
  if (meta.length) text += `\n${meta.join(' · ')}`;
  if (p.docAttached) text += `\n📎 ${p.docLabel || 'Sales bill'}`;
  text += '\n';

  const { formatCounts } = require('./unitDisplayService');
  // CARD-5 — an item's own packaging decides its unit: type 'than' counts
  // thans (a thin, unenriched than item still counts as 1); anything else
  // is a whole bale and counts DISTINCT printed numbers, so a five-than
  // sale out of three bales can never read "5 bale".
  const thanCount = (arr) => arr.reduce(
    (s, x) => s + (x.type === 'than' ? (Number(x.thans) || 1) : 0), 0);
  const baleCount = (arr) => new Set(arr.filter((x) => x.type !== 'than')
    .map((x) => String(x.packageNo ?? ''))).size;
  let totalYards = 0;
  // APF-1 / §2 — an item with no design heads no design group, and the
  // two causes are DIFFERENT facts that must not share a heading: "no live
  // rows at all" is sold-already / unknown-number (a warning), while "one
  // number living under two designs" is merely unknown — never guessed.
  const groupKey = (it) => (it.design ? `d:${it.design}` : (it.noStock ? 'gone' : 'unknown'));
  const groupKeys = [...new Set(items.map(groupKey))];
  for (const gk of groupKeys) {
    const dKey = gk.startsWith('d:') ? gk.slice(2) : '';
    const group = items.filter((x) => groupKey(x) === gk);
    const gYards = group.reduce((s, x) => s + (Number(x.yards) || 0), 0);
    let cat = '';
    if (dKey) {
      try { cat = require('../repositories/designCategoriesRepository').categoryOfSync(dKey) || ''; } catch (_) { /* bare */ }
    }
    const head = dKey
      ? `🧵 ${dKey}${cat ? ` · ${cat}` : ''}`
      : (gk === 'gone'
        ? '⚠️ no available stock (sold already, or unknown number)'
        : '🧵 not resolved — this number lives under more than one design');
    const qty = [formatCounts({ bales: baleCount(group), thans: thanCount(group) }),
      gYards ? `${fmtQty(gYards)} yd` : ''].filter(Boolean).join(' · ');
    text += `\n${head}${qty ? ` — ${qty}` : ''}`;
    const shades = [...new Set(group.map((x) => String(x.shade ?? '')))];
    for (const sh of shades) {
      const line = group.filter((x) => String(x.shade ?? '') === sh);
      const toks = line.map((it) => itemToken(it, !oneStore)).join(' · ');
      text += `\n  ${sh ? `#${sh} → ` : ''}${toks}`;
    }
    totalYards += gYards;
  }

  // CARD-5 — one packaging tally in the rule-6c grammar: "28t", "7B",
  // "4B + 8t". Thans of a still-sealed bale ride inside its B; only sold
  // thans are counted as t.
  const pkgLabel = formatCounts({ bales: baleCount(items), thans: thanCount(items) });
  text += `\n\nΣ ${pkgLabel ? `${pkgLabel} · ` : ''}${fmtQty(totalYards)} yd`;
  text += '\n(bale/than · #shade)';
  const noStock = items.filter((it) => it.noStock).length;
  if (noStock && noStock === items.length) {
    text += '\n🚨 NOTHING in this request is available — it may already be executed, or duplicate another sale. Approving will NOT sell or charge anything.';
  } else if (noStock) {
    text += `\n⚠️ ${noStock} of ${items.length} item(s) marked ⚠️ have no available stock — check before approving.`;
  }
  // CARD-4 (owner 23-Aug) — the backdated banner belongs to the SHARED
  // builder, not to each door. Every sale path used to word it its own way
  // (or prepend it), so the same fact read three different ways depending
  // on which tile the seller used.
  if (p.backdated) {
    const d = Number(p.daysBack) || 0;
    text += `\n⚠️ BACKDATED sale — ${d ? `${d} day(s)` : 'dated'} in the past. Check the date before approving.`;
  }
  return text;
}

/**
 * CNET-2 (owner, 13-Aug-2026) — the add-contact TRIAGE card.
 *
 * "Even after approving a contact requested by Abdul, I am not able to see
 * this customer when approving the sales bill." The old card approved a
 * phonebook row and nothing else, and the admin had no way to say WHERE the
 * person belongs. This card shows everything the requester's message parsed
 * into, and the keyboard routes the approval to one of three destinations:
 *
 *   🛒 Customer — CRM entity (sale-assignable) + a bound network buyer node
 *   📒 Contact  — phonebook row, exactly the old behaviour
 *   🕸 Network  — phonebook row + a subordinate_of edge under a buyer
 *
 * A plain `approve:` from any old/generic surface (inbox delegate, stale
 * card) executes as 📒 Contact — the pre-CNET-2 behaviour, never a surprise
 * registration.
 */
function buildAddContactCard(aj) {
  let text = `📇 New contact — ${aj.name || '?'}`;
  const bits = [`🏷 typed as: ${aj.type || 'other'}`];
  if (aj.phone) bits.push(`📞 ${aj.phone}`);
  text += `\n${bits.join(' · ')}`;
  if (aj.address) text += `\n🏠 ${aj.address}`;
  // CON-1 — the customer-only answers, shown only when the flow collected
  // them (CARD-3: a line appears when it has something to say).
  const trade = [];
  if (aj.category) trade.push(`🏷 ${aj.category}`);
  if (aj.credit_limit !== undefined && aj.credit_limit !== null && aj.credit_limit !== '') {
    trade.push(`💳 limit ${Number(aj.credit_limit).toLocaleString('en-NG')}`);
  }
  if (aj.payment_terms) trade.push(`📄 ${aj.payment_terms}`);
  if (trade.length) text += `\n${trade.join(' · ')}`;
  if (aj.notes) text += `\n📝 ${aj.notes}`;
  if (aj.destination) {
    // A second admin's reminder copy after a choice was already persisted.
    text += `\n\n➡️ Destination chosen: ${aj.destination}${aj.boss_name ? ` (under ${aj.boss_name})` : ''}`;
  }
  text += '\n\nWhere does this person belong?'
    + '\n🛒 Customer — registered for sales bills, and joins the network as a buyer'
    + '\n📒 Contact — phonebook only'
    + "\n🕸 Network — phonebook + placed under a buyer's people";
  // CON-1 — silence is no longer "phonebook": a plain Approve now honours
  // the kind the requester picked, so the card says so rather than
  // leaving an admin to guess what not choosing will do.
  if (aj.type === 'customer') {
    text += '\n\n_Approving without choosing registers them as a CUSTOMER, as requested._';
  }
  return text;
}

/**
 * CNET-2 — the keyboard a pending request should carry. Returns null for
 * every action that keeps the standard Approve/Reject pair, so callers can
 * fall through unchanged.
 */
function keyboardForRequest(requestId, aj) {
  if (!aj || aj.action !== 'add_contact') return null;
  return {
    inline_keyboard: [
      [
        { text: '🛒 Customer', callback_data: `ctg:${requestId}:c` },
        { text: '📒 Contact', callback_data: `ctg:${requestId}:p` },
      ],
      [
        { text: '🕸 Network', callback_data: `ctg:${requestId}:n` },
        { text: '❌ Reject', callback_data: `reject:${requestId}` },
      ],
    ],
  };
}

/** Card for a queued snap-sale sell_package actionJSON. */
async function buildSellPackageCard(aj) {
  return buildSaleCard({
    headline: aj.source === 'snap_sale' ? 'Sale · Snap' : 'Sale',
    customer: aj.customer,
    salesPerson: aj.salesPerson,
    salesDate: aj.salesDate,
    items: [{ packageNo: aj.packageNo, design: aj.design, shade: aj.shade, thans: aj.thans, yards: aj.yards, warehouse: aj.warehouse }],
    docAttached: !!aj.sale_doc_file_id,
    docLabel: aj.source === 'snap_sale' ? 'Sales bill (label photo)' : 'Sales bill',
  });
}

/**
 * Card for a return (sale reversal) — the approving admins were previously
 * shown ONLY the bale number for one of the riskiest dual-admin actions.
 * Enriched best-effort from Inventory; degrades to the bare line.
 */
async function buildReturnCard({ packageNo, thanNo, warehouse }) {
  // TRF-INT4 — when the request pinned a warehouse, every lookup on this
  // card is scoped to it, so the admins judge the SAME physical bale the
  // executor will flip (not a same-numbered duplicate elsewhere).
  let text = thanNo
    ? `Return Request\nBale ${packageNo} — Than ${thanNo}`
    : `Return Request\nBale ${packageNo} (whole bale)`;
  try {
    const inventoryService = require('./inventoryService');
    const info = await inventoryService.getPackageSummary(packageNo, { warehouse });
    if (info) {
      text += `\nDesign: ${info.design}${info.shade ? ` Shade ${info.shade}` : ''}`;
      if (info.warehouse) text += `\nWarehouse: ${info.warehouse}`;
      text += `\nCurrently available there: ${info.availableThans || 0} thans, ${fmtQty(info.availableYards || 0)} yds`;
    }
  } catch (_) { /* lookup failure must not block the card */ }
  // RET-1 — the signing admins are the safety net against a wrong bale
  // number: show exactly what is being reversed and WHOSE account gets
  // the credit, straight from the Inventory rows.
  try {
    const inventoryRepository = require('../repositories/inventoryRepository');
    const rows = await inventoryRepository.findByPackage(packageNo, { warehouse });
    const sold = rows.filter((r) => r.status === 'sold'
      && (!thanNo || String(r.thanNo) === String(thanNo)));
    if (sold.length) {
      const names = [...new Set(sold.map((r) => String(r.soldTo || '').trim()).filter(Boolean))];
      const yds = sold.reduce((s, r) => s + (r.yards || 0), 0);
      text += `\nReturning: ${sold.length} sold than${sold.length === 1 ? '' : 's'}, ${fmtQty(yds)} yds`;
      if (names.length > 1) {
        text += `\n⚠️ Sold to MULTIPLE buyers (${names.join(', ')}) — the ledger credits only ONE account. Reject and have it returned than by than.`;
      } else {
        text += `\nSold to: ${names.length ? names[0] : '(no customer recorded)'} — the return credits this account`;
      }
    } else {
      text += '\n⚠️ No sold thans found on this bale — the executor will refuse.';
    }
  } catch (_) { /* lookup failure must not block the card */ }
  text += '\n⚠️ Reverses a completed sale — verify the goods physically came back.';
  return text;
}

/**
 * Card for a payment approval (dual-admin finance action) — shows the
 * customer's live outstanding balance and the before→after picture so the
 * signing admins have monetary context, not just the amount.
 */
async function buildPaymentCard({ customer, amount, method }) {
  let text = `Record Payment Request\nCustomer: ${customer}\nAmount: ₦${Number(amount || 0).toLocaleString('en-NG')}\nMethod: ${method || '—'}\nDate: ${fmtDate(require('../utils/dates').todayInLagos())  /* TIME-1 */}`;
  try {
    const accountingService = require('./accountingService');
    const { outstandingAsOfToday } = await accountingService.getCustomerLedger(customer);
    const after = Number(outstandingAsOfToday) - Number(amount || 0);
    text += `\nOutstanding today: ₦${Number(outstandingAsOfToday).toLocaleString('en-NG')}`
      + `\nAfter this payment: ₦${after.toLocaleString('en-NG')}`;
    if (after < 0) text += `\n⚠️ Payment EXCEEDS the outstanding balance.`;
  } catch (_) { text += '\n(Outstanding balance unavailable right now.)'; }
  return text;
}

/**
 * Card for removing a bank — previously the thinnest card in the system
 * for a destructive finance action. Adds how much history points at the
 * bank so the approver can judge the blast radius.
 */
async function buildRemoveBankCard({ bankName }) {
  let text = `Remove Bank Request\nBank: ${bankName}`;
  try {
    const receiptsRepository = require('../repositories/receiptsRepository');
    const receipts = (await receiptsRepository.getAll()).filter(
      (r) => String(r.bank_account || '').toLowerCase() === String(bankName).toLowerCase());
    text += `\nReceipts recorded against it: ${receipts.length}`;
    const latest = receipts.map((r) => String(r.created_at || r.uploaded_at || '')).sort().pop();
    if (latest) text += `\nMost recent: ${fmtDate(latest.slice(0, 10))}`;
  } catch (_) { /* context is best-effort */ }
  text += '\n⚠️ Removal only hides it from pickers — recorded history keeps the name.';
  return text;
}

/**
 * SAB-1 (owner, 06-Aug-2026: "I cannot see complete details in this
 * approval") — resolve a bundle's bare bale numbers to design / shade /
 * warehouse / quantities from Inventory, so the approver judges goods, not
 * numbers.
 *
 * BUSINESS_RULES §2 caveat: a printed number can live twice. A number whose
 * LIVE rows span two designs stays bare rather than being guessed onto one.
 * Everything here is best-effort — a Sheets hiccup degrades to the old thin
 * card (reminders rebuild these cards and must never fail on a read).
 */
async function enrichBundleItems(rawItems) {
  const inventoryRepository = require('../repositories/inventoryRepository');
  const inv = await inventoryRepository.getAll();
  const live = inv.filter((r) => r.status === 'available' || r.status === 'in_transit');
  const byPkg = new Map();
  for (const r of live) {
    const k = String(r.packageNo);
    if (!byPkg.has(k)) byPkg.set(k, []);
    byPkg.get(k).push(r);
  }
  return rawItems.map((it) => {
    let rows = byPkg.get(String(it.packageNo)) || [];
    // TRF-INT4 parity — when the item names its own store, resolve inside
    // THAT store so a same-numbered bale elsewhere can never describe it.
    // (Falls back to the unscoped rows when the store holds none.)
    if (it.warehouse) {
      // CARD-4a — NO fallback to the unscoped rows. Falling back described
      // a pinned request using a same-numbered bale in ANOTHER store —
      // different design, shade and yardage — with no warning at all. The
      // pinned store holding nothing live is a FACT the approver must see,
      // so it degrades to noStock ("sold already, or unknown number").
      rows = rows.filter((r) => String(r.warehouse || '').trim().toLowerCase()
        === String(it.warehouse).trim().toLowerCase());
    }
    const designs = [...new Set(rows.map((r) => r.design))];
    // APF-1 — the three bare-item causes are DIFFERENT facts and the card
    // must not conflate them: no live rows at all = sold/unknown (warn
    // loudly — the R-9CEB executed-but-pending case); two designs under
    // one number = ambiguous (stay bare, §2: never guess); an Inventory
    // outage throws before this map and claims nothing.
    if (!rows.length) return { ...it, noStock: true };
    if (designs.length !== 1) return { ...it }; // ambiguous — never guess
    if (it.type === 'than') {
      const row = rows.find((r) => String(r.thanNo) === String(it.thanNo)) || rows[0];
      return {
        ...it, design: row.design, shade: row.shade, warehouse: row.warehouse,
        thans: 1, yards: Number(row.yards) || 0,
      };
    }
    const avail = rows.filter((r) => r.status === 'available');
    return {
      ...it, design: rows[0].design, shade: rows[0].shade, warehouse: rows[0].warehouse,
      thans: avail.length, yards: avail.reduce((s, r) => s + (Number(r.yards) || 0), 0),
    };
  });
}

/** The persisted bill-check verdict as one card line (SAB-1). */
function docVerifyLine(aj) {
  const v = aj && aj.docVerify;
  if (!v) return '';
  const bad = (v.differs || 0) + (v.missing || 0) + (v.extra || 0);
  // VRF-3 — a MIXED sale's thans are never compared (a than has no bale
  // number on the bill). Without saying so the line renders a clean ✅ for
  // a request that was only partly checked, which is a worse lie than the
  // false ❌s this feature removed: the approver reads it as "all good".
  const unchecked = Number(v.thanUnchecked) || 0;
  const tail = unchecked ? ` · ${unchecked} than not checked` : '';
  return `\n🔬 Bill check: ${v.ok || 0} confirmed · ${v.differs || 0} differ · `
    + `${v.missing || 0} missing · ${v.extra || 0} extra${tail}`
    + `${bad ? ' ⚠️' : (unchecked ? ' ◍' : ' ✅')}`;
}

/** Card for a queued classic sale_bundle actionJSON. SAB-1: enriched from
 *  Inventory best-effort; degrades to the bare item list on any failure. */
async function buildSaleBundleCard(aj) {
  let items = (Array.isArray(aj.items) ? aj.items : []).map((it) => ({ ...it }));
  try { items = await enrichBundleItems(items); } catch (_) { /* thin items still render */ }
  let text = await buildSaleCard({
    headline: 'Sale',
    customer: aj.customer,
    salesPerson: aj.salesPerson,
    paymentMode: aj.paymentMode,
    salesDate: aj.salesDate,
    items,
    docAttached: !!aj.sale_doc_file_id,
    docLabel: 'Sales bill',
    backdated: !!aj.backdated,
    daysBack: aj.daysBack,
  });
  // When enrichment could not price a single item (Sheets down, or every
  // number ambiguous), the computed total reads 0 — the queue row's own
  // total is the honest figure the requester submitted.
  if (!items.some((i) => Number(i.yards)) && aj.totalYards) {
    text += `\nQueued total: ${fmtQty(aj.totalYards)} yards`;
  }
  text += docVerifyLine(aj);
  return text;
}

/**
 * Plain-text supply-request card rebuilt from the queue row — the goods
 * live only in aj.cart, which the generic field list can't render. Without
 * this, a reminder's approve button asked admins to decide a multi-bale
 * request without seeing what is being requested.
 */
function buildSupplyRequestCard(aj) {
  let text = `Supply Request\nCustomer: ${aj.customer || '—'}\nWarehouse: ${aj.warehouse || '—'}`;
  if (aj.salesperson) text += `\nSalesperson: ${aj.salesperson}`;
  if (aj.paymentMode) text += `\nPayment: ${aj.paymentMode}`;
  if (aj.salesDate) text += `\nDate: ${fmtDate(aj.salesDate)}`;
  const cart = Array.isArray(aj.cart) ? aj.cart : [];
  if (cart.length) {
    text += '\n\nItems:';
    let total = 0;
    for (const c of cart.slice(0, 15)) {
      text += `\n  • ${c.design}${c.shade ? ` Shade ${c.shade}` : ''} × ${c.quantity}`;
      total += Number(c.quantity) || 0;
    }
    if (cart.length > 15) text += `\n  …+${cart.length - 15} more lines`;
    text += `\nTotal: ${total} container(s)`;
  }
  if (aj.sale_doc_file_id) text += '\n📎 Bill attached';
  return text;
}

/**
 * Detail block for bulk/photo receive approvals (dual-admin container
 * uploads) — per-design breakdown + provenance, rendered from actionJSON.
 * Returns '' when there is nothing beyond the caller's headline.
 */
function buildReceiveDetail(aj) {
  const lines = [];
  const bales = Array.isArray(aj.bales) ? aj.bales : [];
  if (bales.length) {
    const byDesign = new Map();
    for (const b of bales) {
      const key = b.design || '?';
      const d = byDesign.get(key) || { pkgs: new Set(), yards: 0 };
      if (b.packageNo) d.pkgs.add(String(b.packageNo));
      d.yards += Number(b.yards) || 0;
      byDesign.set(key, d);
    }
    lines.push('Designs:');
    let i = 0;
    for (const [design, d] of byDesign) {
      if (i++ >= 12) { lines.push(`  …+${byDesign.size - 12} more designs`); break; }
      lines.push(`  • ${design}: ${d.pkgs.size} bale${d.pkgs.size === 1 ? '' : 's'}, ${fmtQty(d.yards)} yds`);
    }
  } else if (aj.stagedCount) {
    lines.push(`⚠️ ${aj.stagedCount} rows staged locally (too large for the queue row) — review the source file before approving.`);
  }
  if (aj.supplier) lines.push(`Supplier: ${aj.supplier}`);
  if (aj.arrivalBatch) lines.push(`Container: ${aj.arrivalBatch}`);
  if (aj.ocrConfidence !== undefined && aj.ocrConfidence !== '') lines.push(`OCR confidence: ${Math.round(Number(aj.ocrConfidence) * 100)}%`);
  if (aj.fileHash) lines.push(`File hash: ${String(aj.fileHash).slice(0, 12)}…`);
  if (aj.sourceUrl || aj.driveLink) lines.push(`Source file: ${aj.sourceUrl || aj.driveLink}`);
  return lines.length ? `\n${lines.join('\n')}` : '';
}

/**
 * Best card we can rebuild for ANY queued actionJSON — used by the
 * reminder sweep (and anywhere else that only has the sheet row). Sale
 * actions get their full card; everything else gets a generic card that
 * surfaces every recognisable business field instead of dropping them.
 */
/**
 * APX-4 (owner 31-Jul) — human-readable request reference. Approval ids
 * are UUIDs (idempotency keys); nobody should have to read one. The ref
 * is STABLE (first 4 id characters, not a list position — "R-9DDC" means
 * the same request on every admin's screen forever) and display-only:
 * buttons and sheet rows keep the full id underneath.
 */
function shortRequestRef(requestId) {
  const clean = String(requestId || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return clean ? `R-${clean.slice(0, 4)}` : 'R-????';
}

/**
 * APX-4b — human-readable transfer reference: TR-20260724-003 → "24Jul·03".
 * Anything that doesn't match the TR date format (legacy UUID transfers)
 * falls back to the stable R-XXXX ref — a raw UUID must never reach a
 * screen. Display-only; callbacks and sheet rows keep the full id.
 */
function shortTransferRef(requestId) {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = String(requestId || '').match(/^TR-(\d{4})(\d{2})(\d{2})-(\d+)$/);
  if (!m) return shortRequestRef(requestId);
  const seq = m[4].replace(/^0+/, '') || '0';
  return `${m[3]}${MON[Number(m[2]) - 1]}·${seq.padStart(2, '0')}`;
}

/**
 * APX-4 — Add Warehouse card with CONTEXT: the existing warehouses ride
 * on the card, so a duplicate or a mix-up (a design category typed as a
 * warehouse) is caught at a glance instead of after approval.
 */
async function buildAddWarehouseCard(aj) {
  const name = String(aj.name || aj.warehouse || '').trim();
  let text = `🏭 Add Warehouse — "${name || '?'}"`;
  try {
    const inventoryRepository = require('../repositories/inventoryRepository');
    const existing = (await inventoryRepository.getWarehouses()).filter(Boolean);
    text += `\nExisting (${existing.length}): ${existing.join(' · ') || '—'}`;
    if (name && existing.some((w) => String(w).trim().toLowerCase() === name.toLowerCase())) {
      text += `\n⚠️ "${name}" ALREADY EXISTS — approving would duplicate it.`;
    }
  } catch (_) { /* context is best-effort; the card still renders */ }
  try {
    const designCategoriesRepository = require('../repositories/designCategoriesRepository');
    const cats = new Set((designCategoriesRepository.DEFAULT_CATEGORIES || []).map((c) => String(c).toLowerCase()));
    if (name && cats.has(name.toLowerCase())) {
      text += `\n⚠️ "${name}" is also a design category — check this isn't a mix-up.`;
    }
  } catch (_) { /* best-effort */ }
  return text;
}

/**
 * RMV-1 — the removal card. Two admins decide with the consequences in
 * view, so this card's job is disclosure, not persuasion.
 *
 * CARD-3 grammar: a line only when it has something to say. The
 * outstanding balance is BADGED, never a gate — the owner's decision 4,
 * mirroring §13 where a threshold badges and does not block.
 */
function buildRemoveCustomerCard(aj) {
  const removing = aj.action === 'remove_customer';
  let text = removing
    ? `🚪 Remove customer — ${aj.name || '?'}`
    : `↩️ Restore customer — ${aj.name || '?'}`;

  const bits = [];
  if (aj.customer_id) bits.push(`🆔 ${aj.customer_id}`);
  if (aj.phone) bits.push(`📞 ${aj.phone}`);
  if (aj.category) bits.push(`🏷 ${aj.category}`);
  if (bits.length) text += `\n${bits.join(' · ')}`;

  const owed = Number(aj.outstanding_balance || 0);
  if (owed > 0) {
    text += `\n\n⚠️ *Owes ₦${owed.toLocaleString('en-NG')}* — removing them does not clear it, and their ledger stays on record.`;
  }

  if (aj.supply_count) {
    text += `\n📦 ${aj.supply_count} supply record${aj.supply_count === 1 ? '' : 's'}`
      + (aj.last_supply_date ? ` · last ${aj.last_supply_date}` : '')
      + `\n_History is never rewritten — every sale stays exactly as recorded._`;
  }
  if (aj.network_children) {
    text += `\n🕸 ${aj.network_children} person(s) sit under them in the network and will be left without a parent.`;
  }

  if (aj.reason) text += `\n\n📝 Reason: ${aj.reason}`;

  text += removing
    ? `\n\n_Two admins must approve. They keep their row and full history; they stop appearing in pickers, search and the network._`
    : `\n\n_Two admins must approve. They return to pickers, search and the network._`;
  return text;
}

async function buildCardFromActionJSON(aj) {
  if (!aj || typeof aj !== 'object') return 'pending action';
  try {
    if (aj.action === 'sell_package') return await buildSellPackageCard(aj);
    if (aj.action === 'sale_bundle') return await buildSaleBundleCard(aj);
    if (aj.action === 'supply_request') return buildSupplyRequestCard(aj);
    if (aj.action === 'add_contact') return buildAddContactCard(aj);
    if (aj.action === 'remove_customer' || aj.action === 'restore_customer') return buildRemoveCustomerCard(aj);
    if (aj.action === 'add_warehouse') return await buildAddWarehouseCard(aj);
  } catch (_) { /* fall through to generic */ }
  const parts = [actionLabel(aj.action)];
  const fields = [
    ['customer', 'Customer'], ['customer_name', 'Customer'], ['name', 'Name'],
    ['design', 'Design'], ['shade', 'Shade'], ['packageNo', 'Bale'],
    ['warehouse', 'Warehouse'], ['toWarehouse', 'To'], ['arrivalBatch', 'Container'],
    ['price', 'Price'], ['amount', 'Amount'], ['bank_name', 'Bank'],
    ['phone', 'Phone'], ['grnId', 'GRN'], ['supplier', 'Supplier'],
  ];
  const seen = new Set();
  for (const [key, label] of fields) {
    if (aj[key] === undefined || aj[key] === null || aj[key] === '' || seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label}: ${aj[key]}`);
  }
  return parts.join('\n');
}

/**
 * CARD-3 (owner, 10-Aug-2026): "No need to write a big reason stating
 * everything explicitly like 'requires admin approval' — just write sent
 * for approval. It will not always be approved by an admin."
 *
 * Every queued row carries a riskReason, and most of them are boilerplate
 * that repeats what the card's own header already says — and names the
 * approver's ROLE, which is wrong now that approval rights are moving to
 * other roles. Strip the boilerplate sentences; keep anything that is a
 * real fact about THIS request (a backdated sale, a threshold breach).
 *
 * @param {string} reason
 * @returns {string}
 */
const BOILERPLATE_REASON = /\b(requires?|require)\s+(a\s+|an\s+)?(admin|second admin|dual[- ]admin|manager)?\s*approval\b/i;
function shortReason(reason) {
  const kept = String(reason || '')
    .split(/(?<=\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s && !BOILERPLATE_REASON.test(s));
  return kept.join(' ') || 'Sent for approval';
}

/**
 * Forward a request's attachments (bill photo, receipt, …) to every admin
 * except excludeId — the same loop the classic sale card runs at
 * telegramController 6205-6216, shared. Best-effort per admin; returns how
 * many sends succeeded so callers can surface total failure.
 *
 * @param {object} bot
 * @param {string} requestId
 * @param {Array<{fileId:string,kind?:'photo'|'document',caption?:string}>} attachments
 * @param {string|undefined} excludeId
 */
async function forwardAttachmentsToAdmins(bot, requestId, attachments, excludeId) {
  let sent = 0;
  for (const att of attachments || []) {
    if (!att || !att.fileId) continue;
    const caption = att.caption || `📷 Sales bill for request ${requestId}`;
    for (const adminId of config.access.adminIds) {
      if (excludeId && String(adminId) === String(excludeId)) continue;
      try {
        if (att.kind === 'document') await bot.sendDocument(adminId, att.fileId, { caption });
        else await bot.sendPhoto(adminId, att.fileId, { caption });
        sent += 1;
      } catch (e) {
        logger.warn(`approvalCards: attachment to admin ${adminId} failed for ${requestId}: ${e.message}`);
      }
    }
  }
  return sent;
}

module.exports = {
  resolveUserLabel,
  actionLabel,
  _resetNameCacheForTests,
  sortSaleItems,
  // CARD-4 — the one enrichment every sale door resolves goods through.
  enrichBundleItems,
  shortReason,
  shortRequestRef,
  shortTransferRef,
  buildAddWarehouseCard,
  buildSaleCard,
  buildSellPackageCard,
  buildReturnCard,
  buildSaleBundleCard,
  buildAddContactCard,
  buildRemoveCustomerCard,
  keyboardForRequest,
  buildSupplyRequestCard,
  buildPaymentCard,
  buildRemoveBankCard,
  customerContact,
  buildReceiveDetail,
  buildCardFromActionJSON,
  forwardAttachmentsToAdmins,
};
