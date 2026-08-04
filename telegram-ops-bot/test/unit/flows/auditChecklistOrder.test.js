'use strict';

/**
 * AUD-ORD1 — the audit checklist reads oldest reconciliation first, and the
 * done-date on the chip reads DD-MMM-YY (owner, 04-Aug-2026: "make it in
 * order of the oldest to the newest reconciliation with date format in
 * dd-month-yy").
 *
 * The ordering carries a correctness hazard worth pinning: the chip callback
 * is `wai:ck:<index>` into the SAME array the flow stores as
 * session._checklist. If the two ever sort differently, tapping one design
 * counts another — so the last test drives the real render and checks the
 * index the button carries against the design it names.
 */

process.env.ADMIN_IDS = '777';
process.env.WAREHOUSE_AUDIT_ENABLED = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const flow = require(path.join(SRC, 'flows/warehouseAuditFlow'));
const fmtDate = require(path.join(SRC, 'utils/formatDate'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const { loadChecklist, renderChecklist, sendOfflineTemplate, SESSION_TYPE } = flow._internals;

const WH = 'IDUMOTA';

/** One sealed bale of `design` in IDUMOTA — enough to reach the checklist. */
function bale(pkg, design) {
  return {
    packageNo: pkg, design, shade: 'X', thanNo: 1, yards: 60,
    status: 'available', warehouse: WH,
  };
}

/**
 * @param {Array<[string,string]>} designs [design, packageNo]
 * @param {object} reconciled design -> ISO audited_at
 */
function seed(designs, reconciled = {}) {
  inventoryRepository.getAll = async () => designs.map(([d, p]) => bale(p, d));
  // renderChecklist also asks for today's rows (mismatch/lock markers).
  stockTakesRepository.rowsForDay = async () => [];
  stockTakesRepository.latestFor = async () => {
    const m = new Map();
    for (const [d, at] of Object.entries(reconciled)) {
      // loadChecklist only counts it reconciled when the book figures match
      // what it just computed: one sealed bale, no loose thans.
      m.set(d.toUpperCase(), { design: d, audited_at: at, sheet_bales: 1, sheet_bundles: 0 });
    }
    return m;
  };
}

test('fmtDate.short renders DD-MMM-YY and leaves junk alone', () => {
  assert.equal(fmtDate.short('2026-07-22'), '22-Jul-26');
  assert.equal(fmtDate.short('2026-01-05'), '05-Jan-26');
  assert.equal(fmtDate.short('2026-12-31'), '31-Dec-26');
  // Unparseable input must come back untouched, never sliced into nonsense.
  assert.equal(fmtDate.short('not a date'), 'not a date');
  assert.equal(fmtDate.short(''), '—');
  // The 4-digit default is unchanged — it is used all over the bot.
  assert.equal(fmtDate('2026-07-22'), '22-Jul-2026');
});

test('counted designs run oldest reconciliation → newest', async () => {
  seed([['9045', 'P1'], ['9037', 'P2'], ['408/204', 'P3']], {
    '9045': '2026-07-30T09:00:00.000Z',
    '9037': '2026-07-22T09:00:00.000Z',
    '408/204': '2026-07-26T09:00:00.000Z',
  });
  const list = await loadChecklist({ warehouse: WH });
  assert.deepEqual(list.map((d) => d.design), ['9037', '408/204', '9045']);
});

test('never-counted designs come first — never reconciled is the oldest state', async () => {
  seed([['44200', 'P1'], ['9037', 'P2'], ['77008', 'P3']], {
    '9037': '2026-07-22T09:00:00.000Z',
  });
  const list = await loadChecklist({ warehouse: WH });
  assert.deepEqual(list.map((d) => d.design), ['44200', '77008', '9037']);
});

test('within a group the old design-code order is kept, so the count sheet is unchanged', async () => {
  seed([['77016', 'P1'], ['44201', 'P2'], ['44200', 'P3'], ['77014', 'P4']]);
  const list = await loadChecklist({ warehouse: WH });
  assert.deepEqual(list.map((d) => d.design), ['44200', '44201', '77014', '77016']);
});

test('same-day reconciliations fall back to design order, not insertion order', async () => {
  const day = '2026-07-22T09:00:00.000Z';
  seed([['9059-C', 'P1'], ['9037', 'P2'], ['9045', 'P3']],
    { '9059-C': day, '9037': day, '9045': day });
  const list = await loadChecklist({ warehouse: WH });
  assert.deepEqual(list.map((d) => d.design), ['9037', '9045', '9059-C']);
});

test('the chip shows the short date and the index still points at its own design', async () => {
  seed([['44200', 'P1'], ['9037', 'P2'], ['9045', 'P3']], {
    '9045': '2026-07-30T09:00:00.000Z',
    '9037': '2026-07-22T09:00:00.000Z',
  });
  const userId = '777';
  sessionStore.clear(userId);
  sessionStore.set(userId, { type: SESSION_TYPE, warehouse: WH, location: 'Lagos' });
  const bot = createFakeBot();
  await renderChecklist(bot, userId, userId);

  const sent = bot.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  const kb = sent[sent.length - 1].args.opts.reply_markup.inline_keyboard.flat();
  const labels = kb.map((b) => b.text);

  // Oldest first: un-counted 44200, then 9037 (22nd), then 9045 (30th).
  assert.equal(labels[0].includes('44200'), true, `expected 44200 first, got ${labels}`);
  assert.match(labels[1], /9037 \(done 22-Jul-26\)/);
  assert.match(labels[2], /9045 \(done 30-Jul-26\)/);
  assert.ok(!labels.some((l) => /done \d{4}-\d{2}-\d{2}/.test(l)), 'no ISO date left on any chip');

  // The tappable chip's index must resolve to the design it names.
  const session = sessionStore.get(userId);
  const tappable = kb.filter((b) => String(b.callback_data).startsWith('wai:ck:'));
  assert.ok(tappable.length >= 1, 'the un-counted design is tappable');
  for (const b of tappable) {
    const idx = Number(String(b.callback_data).split(':')[2]);
    const named = b.text.replace(/^[^\w]*/, '').trim();
    assert.equal(session._checklist[idx].design, named,
      `wai:ck:${idx} points at ${session._checklist[idx].design} but the button says ${named}`);
  }
});

/* ── the hazard the reordering introduced, and its guard ─────────────────── */

/**
 * Sorting by reconciliation makes `wai:ck:<i>` volatile: counting a design
 * moves it out of the un-reconciled block and shifts every index below it.
 * That is fine for the CURRENT card — the keyboard and _checklist are built
 * from one array — but a card left behind by a re-anchor still carries the
 * old indices. This pins that the order really does move (so nobody
 * "simplifies" the guard away) and that a stale tap is refused.
 */
test('counting a design DOES shift the indices — a stale card cannot be trusted', async () => {
  const designs = [['9037', 'P1'], ['9045', 'P2'], ['44200', 'P3']];
  seed(designs);
  const before = (await loadChecklist({ warehouse: WH })).map((d) => d.design);
  seed(designs, { '9037': '2026-08-04T09:00:00.000Z' });
  const after = (await loadChecklist({ warehouse: WH })).map((d) => d.design);
  assert.notEqual(before[0], after[0],
    'if these ever match again the stale-card guard may look unnecessary — it is not');
});

test('a tap from a stale card is refused instead of counting another design', async () => {
  seed([['9037', 'P1'], ['9045', 'P2'], ['44200', 'P3']]);
  const userId = '777';
  sessionStore.clear(userId);
  const bot = createFakeBot();
  sessionStore.set(userId, { type: SESSION_TYPE, warehouse: WH, location: 'Lagos' });
  await renderChecklist(bot, userId, userId);

  const session = sessionStore.get(userId);
  session.step = 'checklist';
  session.flowMessageId = 500; // the live card
  sessionStore.set(userId, session);

  await flow.handleCallback(bot, {
    id: 'q', data: 'wai:ck:0', from: { id: userId },
    message: { chat: { id: userId }, message_id: 401 }, // an OLD card
  });

  const alerts = bot.callsTo('answerCallbackQuery');
  assert.ok(alerts.some((a) => /out of date/i.test(String(a.args.opts && a.args.opts.text))),
    'the stale tap is called out');
  assert.equal(sessionStore.get(userId).step, 'checklist', 'no pad opened');
  assert.equal(sessionStore.get(userId).countDesign, undefined, 'no design armed for counting');
});

test('a tap from the CURRENT card still opens the pad', async () => {
  seed([['9037', 'P1'], ['9045', 'P2']]);
  const userId = '777';
  sessionStore.clear(userId);
  const bot = createFakeBot();
  sessionStore.set(userId, { type: SESSION_TYPE, warehouse: WH, location: 'Lagos' });
  await renderChecklist(bot, userId, userId);

  const session = sessionStore.get(userId);
  session.step = 'checklist';
  session.flowMessageId = 500;
  sessionStore.set(userId, session);

  await flow.handleCallback(bot, {
    id: 'q', data: 'wai:ck:0', from: { id: userId },
    message: { chat: { id: userId }, message_id: 500 }, // the live card
  });
  assert.equal(sessionStore.get(userId).countDesign, '9037', 'the named design is armed');
});

test('switching to an empty store does not carry the old store’s count sheet', async () => {
  seed([['9037', 'P1'], ['9045', 'P2']]);
  const userId = '777';
  sessionStore.clear(userId);
  const bot = createFakeBot();
  sessionStore.set(userId, { type: SESSION_TYPE, warehouse: WH, location: 'Lagos' });
  await renderChecklist(bot, userId, userId);
  assert.equal(sessionStore.get(userId)._checklist.length, 2, 'IDUMOTA is loaded');

  // Now the auditor moves to a store with nothing in Inventory.
  seed([]);
  const s = sessionStore.get(userId);
  s.warehouse = 'CHINOS STR';
  sessionStore.set(userId, s);
  await renderChecklist(bot, userId, userId);

  assert.deepEqual(sessionStore.get(userId)._checklist, [],
    'the previous store’s designs are gone from the session');
  const bot2 = createFakeBot();
  await sendOfflineTemplate(bot2, userId, userId, { quietWhenEmpty: true });
  const texts = bot2.calls.map((c) => String((c.args && c.args.text) || '')).join('\n');
  assert.ok(!texts.includes('9037') && !texts.includes('9045'),
    'no count sheet for the warehouse the auditor already left');
});
