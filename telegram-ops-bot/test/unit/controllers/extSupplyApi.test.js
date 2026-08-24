'use strict';

/**
 * SUP-1 — the customer Supply Record API (/api/ext/supply*, /api/ext/design).
 *
 * What these tests hold down, in the owner's words:
 *   - "Not one naira." Every response body is scanned key-by-key for any
 *     money-shaped field, so a rate or amount added upstream tomorrow fails
 *     here rather than on the customer's screen.
 *   - A session sees ONLY its own goods and its own documents: walking
 *     :day / :i cannot reach another customer's paperwork, and a design
 *     the customer was never supplied has no catalogue picture.
 *   - No bearer, no data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const apiController = require(path.join(SRC, 'controllers/apiController'));
const extLedgerService = require(path.join(SRC, 'services/extLedgerService'));
const supplyLedgerService = require(path.join(SRC, 'services/supplyLedgerService'));
const supplyLedgerWebController = require(path.join(SRC, 'controllers/supplyLedgerWebController'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const designAssetsService = require(path.join(SRC, 'services/designAssetsService'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));

/* ── fixtures ──────────────────────────────────────────────────────────── */

const SESSIONS = { 'tok-qari': 'Qaribullah', 'tok-bello': 'Bello' };

// SUP-2 — supplySession now verifies that the session's display name is not
// shared by two live customers before reading a single row, so these tests
// have to supply the identity context that guard reads. Both names are
// unique here, which is what lets every case below reach its endpoint.
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
customersRepository.getAll = async () => ([
  { customer_id: 'CUST-1', name: 'Qaribullah', phone: '+2348138475360', status: 'Active' },
  { customer_id: 'CUST-2', name: 'Bello', phone: '+2348012345678', status: 'Active' },
]);

extLedgerService.sessionCustomer = async (t) => SESSIONS[String(t)] || null;

supplyLedgerService.namesFor = async (c) => [String(c).toLowerCase()];

supplyLedgerService.buildLedger = async (customer) => {
  if (customer !== 'Qaribullah') return { entries: [], net: { bales: 0, yards: 0, thans: 0 } };
  return {
    entries: [
      { day: '2026-07-12', kind: 'supply', bales: 14, thans: 14, yards: 1764, qty: '14 Bales', label: '14 Bales (1,764 yards)' },
      { day: '2026-08-05', kind: 'supply', bales: 12, thans: 12, yards: 1512.4, qty: '12 Bales', label: '12 Bales (1,512 yards)' },
      { day: '2026-08-15', kind: 'return', bales: 2, thans: 2, yards: 0, qty: '2 Bales', label: 'Return — 2 Bales' },
    ],
    net: { bales: 42, yards: 5292.2, thans: 24 },
  };
};

supplyLedgerService.dayDetail = async (customer, day) => {
  if (customer !== 'Qaribullah') return [];
  if (day === '2026-07-12') {
    return [{
      design: '8802-A',
      category: 'Cotton lace',
      shades: [{ shade: '2', bales: ['5810', '5811'], thans: 2, yards: 252 }],
    }];
  }
  if (day === '2026-08-05') {
    return [
      { design: '9031-C', category: 'Voile', shades: [{ shade: '3', bales: ['6311'], thans: 1, yards: 126 }] },
      { design: '8802-A', category: 'Cotton lace', shades: [{ shade: '4', bales: ['5852'], thans: 1, yards: 126.6 }] },
    ];
  }
  return [];
};

// Documents exist for BOTH customers on the same day — the fixture that makes
// a cross-customer index walk observable.
const DOCS = {
  Qaribullah: { '2026-07-12': [{ fileId: 'FILE-QARI-1', kind: 'photo' }, { fileId: 'FILE-QARI-2', kind: 'document' }] },
  Bello: { '2026-07-12': [{ fileId: 'FILE-BELLO-1', kind: 'photo' }] },
};
supplyLedgerWebController._internals.docsForDay = async (customer, day) => (DOCS[customer] || {})[day] || [];

inventoryRepository.getSoldRows = async () => [
  { soldTo: 'Qaribullah', design: '8802-A', packageNo: '5810', soldDate: '2026-07-12', yards: 126 },
  { soldTo: 'Bello', design: '7777-Z', packageNo: '9001', soldDate: '2026-07-12', yards: 126 },
];

designAssetsService.getPhotoForSend = async (design) => (design === '8802-A'
  ? { design, photo: 'TG-FILE-8802', photoSource: 'telegram_file_id' }
  : null);

telegramFiles.downloadTelegramFile = async (bot, fileId) => ({
  buffer: Buffer.from(`bytes:${fileId}`), ext: 'jpg', mimeType: 'image/jpeg',
});

const BOT = { getFile: async () => ({ file_path: 'photos/x.jpg' }) };

/* ── harness ───────────────────────────────────────────────────────────── */

let ipSeq = 0;
/** Each call gets its own client IP so the 120/hour throttle never fires. */
function call(handler, { token, params = {}, bot } = {}) {
  ipSeq += 1;
  return new Promise((resolve) => {
    const headers = { 'x-forwarded-for': `10.0.0.${ipSeq % 250}` };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = {
      statusCode: 200,
      headers: {},
      status(c) { this.statusCode = c; return this; },
      set(k, v) { this.headers[k] = v; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
      send(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); },
    };
    handler({ headers, params, query: {}, socket: {} }, res, bot);
  });
}

/**
 * The owner lock, mechanised: walk the whole response and fail on anything
 * money-shaped — a key that names money, or a value carrying a naira sign.
 */
const MONEY_KEY = /(price|rate|amount|naira|ngn|lc_|landed|cost|debit|credit|balance|paid|payment|invoice|total_?ngn)/i;
function assertNoMoney(node, trail = '$') {
  if (node == null) return;
  if (typeof node === 'string') {
    assert.ok(!node.includes('₦'), `naira sign in ${trail}: ${node}`);
    return;
  }
  if (Array.isArray(node)) { node.forEach((v, i) => assertNoMoney(v, `${trail}[${i}]`)); return; }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      assert.ok(!MONEY_KEY.test(k), `money-shaped key ${trail}.${k}`);
      assertNoMoney(v, `${trail}.${k}`);
    }
  }
}

/* ── tests ─────────────────────────────────────────────────────────────── */

test('every supply endpoint refuses a missing or unknown bearer with 401', async () => {
  const cases = [
    [apiController.getExtSupply, {}],
    [apiController.getExtSupplyDay, { day: '2026-07-12' }],
    [apiController.getExtSupplyDoc, { day: '2026-07-12', i: '0' }],
    [apiController.getExtDesignPhoto, { code: '8802-A' }],
  ];
  for (const [handler, params] of cases) {
    const none = await call(handler, { params, bot: BOT });
    assert.equal(none.status, 401, `${handler.name} with no token`);
    const bad = await call(handler, { token: 'not-a-session', params, bot: BOT });
    assert.equal(bad.status, 401, `${handler.name} with a stale token`);
  }
});

test('GET /api/ext/supply — day rows, design codes, and totals from the service', async () => {
  const r = await call(apiController.getExtSupply, { token: 'tok-qari' });
  assert.equal(r.status, 200);
  assert.equal(r.body.customer, 'Qaribullah');
  assert.equal(r.body.days.length, 3);

  assert.deepEqual(r.body.days[0], {
    date: '2026-07-12', kind: 'supply', designs: ['8802-A'], bales: 14, yards: 1764,
  });
  // Two designs on one day, both codes on the row; fractional yards rounded.
  assert.deepEqual(r.body.days[1].designs, ['9031-C', '8802-A']);
  assert.equal(r.body.days[1].yards, 1512);

  // A return is carried as a return, never flattened into a supply.
  assert.equal(r.body.days[2].kind, 'return');
  assert.deepEqual(r.body.days[2].designs, []);

  // Hero totals come from net — NOT from summing the rows (14+12 = 26 ≠ 42).
  assert.deepEqual(r.body.totals, { bales: 42, yards: 5292, thans: 24 });
  assertNoMoney(r.body);
});

test('GET /api/ext/supply/day/:day — shades, printed bale numbers, docs by position', async () => {
  const r = await call(apiController.getExtSupplyDay, { token: 'tok-qari', params: { day: '2026-07-12' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.designs, [{
    design: '8802-A',
    category: 'Cotton lace',
    shades: [{ shade: '2', bales: ['5810', '5811'], yards: 252 }],
  }]);
  // Documents are positions and labels only — the Telegram file_id never
  // leaves the server, or anyone holding the bot token could fetch it.
  assert.deepEqual(r.body.docs, [
    { i: 0, label: 'Sale photo 1' },
    { i: 1, label: 'Sale document 2' },
  ]);
  assert.equal(JSON.stringify(r.body).includes('FILE-QARI'), false);
  assertNoMoney(r.body);
});

test('the day endpoint refuses anything that is not a YYYY-MM-DD day', async () => {
  for (const day of ['2026-7-12', '../../etc/passwd', '2026-07-12T00:00:00Z', '']) {
    const r = await call(apiController.getExtSupplyDay, { token: 'tok-qari', params: { day } });
    assert.equal(r.status, 400, `day=${day}`);
  }
});

test('documents are scoped to the session — :day/:i cannot reach another customer', async () => {
  const mine = await call(apiController.getExtSupplyDoc, {
    token: 'tok-qari', params: { day: '2026-07-12', i: '0' }, bot: BOT,
  });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.toString(), 'bytes:FILE-QARI-1');

  // Bello's session on the SAME day and index gets Bello's single document —
  // never Qaribullah's — and index 1, which exists for Qaribullah, is a 404
  // for Bello rather than a walk into the neighbour's paperwork.
  const theirs = await call(apiController.getExtSupplyDoc, {
    token: 'tok-bello', params: { day: '2026-07-12', i: '0' }, bot: BOT,
  });
  assert.equal(theirs.body.toString(), 'bytes:FILE-BELLO-1');
  const past = await call(apiController.getExtSupplyDoc, {
    token: 'tok-bello', params: { day: '2026-07-12', i: '1' }, bot: BOT,
  });
  assert.equal(past.status, 404);
});

test('a negative or non-numeric document index is a 404, not an array trick', async () => {
  for (const i of ['-1', 'x', '1e0', '0.5']) {
    const r = await call(apiController.getExtSupplyDoc, {
      token: 'tok-qari', params: { day: '2026-07-12', i }, bot: BOT,
    });
    assert.equal(r.status, 404, `i=${i}`);
  }
});

test('catalogue photo: served for a design the customer was supplied', async () => {
  const r = await call(apiController.getExtDesignPhoto, {
    token: 'tok-qari', params: { code: '8802-A' }, bot: BOT,
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers['Content-Type'], 'image/jpeg');
  assert.equal(r.body.toString(), 'bytes:TG-FILE-8802');
});

test('catalogue photo: 404 for a design this customer never received', async () => {
  // 7777-Z is real and has been supplied — to Bello, not to Qaribullah.
  // Without the supplied-to-me check this endpoint is a logged-in walk
  // through the entire design book.
  const r = await call(apiController.getExtDesignPhoto, {
    token: 'tok-qari', params: { code: '7777-Z' }, bot: BOT,
  });
  assert.equal(r.status, 404);
});

test('catalogue photo: 404 when the design has no active asset', async () => {
  const r = await call(apiController.getExtDesignPhoto, {
    token: 'tok-bello', params: { code: '7777-Z' }, bot: BOT,
  });
  assert.equal(r.status, 404);
});

test('catalogue photo: a malformed design code never reaches the lookup', async () => {
  for (const code of ['../../secret', '', 'a'.repeat(60), '<script>']) {
    const r = await call(apiController.getExtDesignPhoto, {
      token: 'tok-qari', params: { code }, bot: BOT,
    });
    assert.equal(r.status, 404, `code=${code}`);
  }
});

test('a customer with no supplies gets an empty record, not an error', async () => {
  const r = await call(apiController.getExtSupply, { token: 'tok-bello' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.days, []);
  assert.deepEqual(r.body.totals, { bales: 0, yards: 0, thans: 0 });
});
