'use strict';

/**
 * BKP-2 — the offsite backup job (owner's go, 19-Nov-2026).
 *
 * Two files a day over Telegram: the workbook as an .xlsx built in this
 * process, and the database records (plus any workbook cell too long for an
 * .xlsx). Pinned here: what the files contain, what is left out and said
 * so, the split under Telegram's size cap, once-a-day across restarts, the
 * failure pacing, and the restore script's two halves.
 *
 * Sheets, Postgres, Settings and Telegram are all stubbed. No credentials.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const { createFakeBot } = require('../../helpers/fakeBot');
const offsiteBackup = require('../../../src/services/offsiteBackup');
const sheets = require('../../../src/repositories/sheetsClient');
const pool = require('../../../src/db/postgresPool');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const jobRuns = require('../../../src/repositories/jobRunsRepository');
const restore = require('../../../scripts/restore-backup-data');
const backupFlow = require('../../../src/flows/backupFlow');

const I = offsiteBackup._internals;
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');
const real = {
  getByRequestId: approvalQueueRepository.getByRequestId,
  getSheetGrid: sheets.getSheetGrid, readRangesRaw: sheets.readRangesRaw,
  isEnabled: pool.isEnabled, withTransaction: pool.withTransaction,
  getAll: settingsRepository.getAll,
  record: jobRuns.record, hasOk: jobRuns.hasOk, latest: jobRuns.latest,
};
test.after(() => {
  approvalQueueRepository.getByRequestId = real.getByRequestId;
  Object.assign(sheets, { getSheetGrid: real.getSheetGrid, readRangesRaw: real.readRangesRaw });
  Object.assign(pool, { isEnabled: real.isEnabled, withTransaction: real.withTransaction });
  settingsRepository.getAll = real.getAll;
  Object.assign(jobRuns, { record: real.record, hasOk: real.hasOk, latest: real.latest });
});

/* ── fixtures ────────────────────────────────────────────────────────── */

const LONG = `{"items":"${'x'.repeat(40000)}"}`;
let TABS;
let DB;          // { table: { columns, pk, rows } }
let pgOn;
let pgFail;
let queries;
let settings;
let runs;        // job_runs rows
let recordFails;
let reads;       // every ranges list asked of the sheet client
let queue;       // ApprovalQueue rows by request id (the backup requests)

function resetWorld() {
  I._resetForTests();
  TABS = [
    { name: 'Inventory', rows: [['PackageNo', 'Yards', 'arrival_batch'], [1201, 28.5, 'Mar26'], [1202, 30, 'Jul26']] },
    { name: 'ApprovalQueue', rows: [['RequestId', 'ActionJSON'], ['R-1', '{"a":1}'], ['R-2', LONG]] },
    { name: 'Notes: a hand-made tab with a very long title', rows: [['=1+1', true, null, '0806 256 2752']] },
    { name: 'Empty', rows: [] },
  ];
  DB = {
    payment_events: { columns: [{ name: 'id', type: 'bigint' }, { name: 'kind', type: 'text' }], pk: { name: 'id', type: 'bigint' },
      rows: [{ id: 1, kind: 'approved' }, { id: 2, kind: 'paid' }] },
    transfers: { columns: [{ name: 'request_id', type: 'text' }], pk: { name: 'request_id', type: 'text' }, rows: [{ request_id: 'T-1' }] },
    schema_migrations: { columns: [{ name: 'id', type: 'text' }], pk: null, rows: [{ id: '001_stock_events' }] },
    // must never be dumped
    web_sessions: { columns: [{ name: 'token', type: 'text' }], pk: null, rows: [{ token: 'SECRET' }] },
    agent_keys: { columns: [{ name: 'key_hash', type: 'text' }], pk: null, rows: [{ key_hash: 'HASH' }] },
    app_logs: { columns: [{ name: 'msg', type: 'text' }], pk: null, rows: [{ msg: 'a log line' }] },
    inventory_rows: { columns: [{ name: 'x', type: 'text' }], pk: null, rows: [{ x: 'copy' }] },
  };
  pgOn = true; pgFail = ''; queries = []; runs = []; recordFails = false;
  // an approved backup request raised by 888, and one still waiting
  queue = {
    'R-1': { requestId: 'R-1', user: '888', status: 'approved', actionJSON: { action: 'release_backup' } },
    'R-2': { requestId: 'R-2', user: '777', status: 'pending', actionJSON: { action: 'release_backup' } },
    'R-3': { requestId: 'R-3', user: '777', status: 'approved', actionJSON: { action: 'sale_bundle' } },
  };
  approvalQueueRepository.getByRequestId = async (id) => queue[id] || null;
  settings = { OFFSITE_BACKUP_ENABLED: 1, OFFSITE_BACKUP_HOUR: 2, OFFSITE_BACKUP_IDS: '' };

  reads = [];
  // the GRID is what Google allocates: at least the rows held, usually more
  sheets.getSheetGrid = async () => TABS.map((t) => ({ name: t.name, rows: t.grid || Math.max(1000, t.rows.length), cols: 26 }));
  sheets.readRangesRaw = async (ranges) => {
    reads.push(ranges);
    return ranges.map((range) => {
      const m = /^'((?:[^']|'')*)'(?:!(\d+):(\d+))?$/.exec(range);
      const tab = TABS.find((t) => t.name === m[1].replace(/''/g, "'"));
      if (!m[2]) return tab.rows;
      return tab.rows.slice(Number(m[2]) - 1, Number(m[3]));
    });
  };
  pool.isEnabled = () => pgOn;
  pool.withTransaction = async (fn) => fn({ query: fakeQuery });
  settingsRepository.getAll = async () => ({ ...settings });
  jobRuns.record = async (job, day, status, detail) => { if (recordFails) throw new Error('pg down'); runs.push({ job, day, status, detail, created_at: new Date() }); return runs.length; };
  jobRuns.hasOk = async (job, day) => runs.some((r) => r.job === job && r.day === day && r.status === 'ok');
  jobRuns.latest = async (job) => [...runs].reverse().find((r) => r.job === job) || null;
}

async function fakeQuery(text, params = []) {
  queries.push({ text, params });
  if (pgFail) throw new Error(pgFail);
  if (/^SET TRANSACTION/.test(text)) return { rows: [] };
  if (/FROM pg_class/.test(text)) return { rows: Object.keys(DB).sort().map((name) => ({ name })) };
  if (/information_schema\.columns/.test(text)) return { rows: DB[params[0]].columns };
  if (/FROM pg_index/.test(text)) { const t = DB[String(params[0]).replace('public.', '')]; return { rows: t.pk ? [t.pk] : [] }; }
  const m = /FROM "([a-z_]+)" t/.exec(text);
  const t = DB[m[1]];
  if (!/ORDER BY/.test(text)) return { rows: t.rows.map((r) => ({ r })) };
  const key = t.pk.name;
  const sorted = [...t.rows].sort((a, b) => (a[key] > b[key] ? 1 : -1));
  const after = params.length ? sorted.filter((r) => String(r[key]).padStart(12, '0') > String(params[0]).padStart(12, '0')) : sorted;
  return { rows: after.slice(0, I.PAGE).map((r) => ({ r, k: String(r[key]) })) };
}

const NOW = new Date('2026-11-19T02:30:00+01:00'); // 02:30 Lagos
const gunzipLines = (buf) => zlib.gunzipSync(buf).toString('utf8').trim().split('\n').map((l) => JSON.parse(l));
const sheetRows = (buf, name) => XLSX.utils.sheet_to_json(XLSX.read(buf, { type: 'buffer' }).Sheets[name], { header: 1, defval: null, raw: true });
const docs = (bot) => bot.callsTo('sendDocument').map((c) => c.args);

test.beforeEach(resetWorld);

/* ── the workbook ────────────────────────────────────────────────────── */

test('tab titles become legal .xlsx names: 31 characters, no reserved marks, unique, the index name kept free', () => {
  const out = I.xlsxNames(['Inventory', 'A/B:C?', 'x'.repeat(40), 'x'.repeat(40), '_BACKUP', '']);
  assert.equal(out[0], 'Inventory');
  assert.equal(out[1], 'A_B_C_');
  assert.equal(out[2].length, 31);
  assert.equal(out[3], `${'x'.repeat(29)}~2`, 'a second tab with the same cut name is told apart');
  assert.equal(out[4], '_BACKUP~2', 'the index sheet keeps its own name');
  assert.equal(out[5], 'Sheet');
  assert.equal(new Set(out.map((s) => s.toLowerCase())).size, out.length);
});

test('a cell longer than an .xlsx allows is cut with a marker and handed over in full — never dropped', () => {
  const long = [];
  const p = I.prepareTab('ApprovalQueue', [['R-2', LONG, 7, null, undefined, true]], long);
  assert.equal(p.cut, 1);
  assert.ok(p.rows[0][1].length < I.CELL_MAX);
  assert.match(p.rows[0][1], / …\[cut: \d+ characters, the full text is in the data file\]$/);
  assert.deepEqual(p.rows[0].slice(2), [7, null, null, true], 'other cells are untouched');
  assert.deepEqual(long, [{ tab: 'ApprovalQueue', row: 1, col: 2, text: LONG }], 'addressed by 1-based row and column');
});

test('build: the workbook file holds every tab with its values as read, behind an index sheet', async () => {
  const built = await offsiteBackup.build({ now: NOW });
  assert.equal(built.day, '2026-11-19');
  const wb = built.files.find((f) => f.kind === 'workbook');
  assert.equal(wb.filename, 'afp-backup-2026-11-19-workbook.xlsx');
  const book = XLSX.read(wb.buffer, { type: 'buffer' });
  assert.deepEqual(book.SheetNames, ['_BACKUP', 'Inventory', 'ApprovalQueue', 'Notes_ a hand-made tab with a v', 'Empty']);

  // numbers stay numbers, a container label stays the text it displays
  assert.deepEqual(sheetRows(wb.buffer, 'Inventory'), [['PackageNo', 'Yards', 'arrival_batch'], [1201, 28.5, 'Mar26'], [1202, 30, 'Jul26']]);
  // formula-looking text is text; a phone number keeps its zero and spaces
  assert.deepEqual(sheetRows(wb.buffer, 'Notes_ a hand-made tab with a v'), [['=1+1', true, null, '0806 256 2752']]);
  // the index names every tab by its real title, with row counts
  const index = sheetRows(wb.buffer, '_BACKUP');
  assert.deepEqual(index.slice(4), [
    ['Tab in this file', 'Tab in the workbook', 'Rows', 'Cells cut'],
    ['Inventory', 'Inventory', 3, 0],
    ['ApprovalQueue', 'ApprovalQueue', 3, 1],
    ['Notes_ a hand-made tab with a v', 'Notes: a hand-made tab with a very long title', 1, 0],
    ['Empty', 'Empty', 0, 0],
  ]);
  assert.match(wb.caption, /^💾 Backup · 19-Nov-2026 · workbook\n4 tabs · 7 rows · \d+ KB\n⚠️ 1 long cell\(s\) are cut in this file\. Their full text is in the data file\.$/);
  assert.deepEqual(built.summary.workbook, { files: 1, tabs: 4, rows: 7, bytes: wb.buffer.length, cut: 1, inData: [] });
  assert.equal(reads.length, 1, 'the whole workbook in one request');
});

test('build: the data file holds every business table and the long cell in full; secrets, logs and copies are left out and named', async () => {
  const built = await offsiteBackup.build({ now: NOW });
  const data = built.files.find((f) => f.kind === 'data');
  assert.equal(data.filename, 'afp-backup-2026-11-19-data.ndjson.gz');
  const lines = gunzipLines(data.buffer);

  assert.deepEqual(lines[0], { type: 'header', format: 'afp-backup-data/1', created_at: NOW.toISOString(), day: '2026-11-19' });
  assert.deepEqual(lines.filter((l) => l.type === 'table').map((l) => [l.name, l.pk]),
    [['payment_events', 'id'], ['schema_migrations', null], ['transfers', 'request_id']]);
  assert.deepEqual(lines.filter((l) => l.type === 'row').map((l) => [l.t, l.r]), [
    ['payment_events', { id: 1, kind: 'approved' }], ['payment_events', { id: 2, kind: 'paid' }],
    ['schema_migrations', { id: '001_stock_events' }], ['transfers', { request_id: 'T-1' }],
  ]);
  assert.deepEqual(lines.filter((l) => l.type === 'cell'), [{ type: 'cell', tab: 'ApprovalQueue', row: 3, col: 2, text: LONG }]);

  const footer = lines.at(-1);
  assert.equal(footer.type, 'footer');
  assert.deepEqual(footer.tables, [{ name: 'payment_events', rows: 2 }, { name: 'schema_migrations', rows: 1 }, { name: 'transfers', rows: 1 }]);
  assert.deepEqual(footer.excluded.map((e) => e.name), ['agent_keys', 'app_logs', 'inventory_rows', 'web_sessions']);
  assert.equal(footer.long_cells, 1);

  const all = zlib.gunzipSync(data.buffer).toString('utf8');
  for (const secret of ['SECRET', 'HASH', 'a log line']) assert.ok(!all.includes(secret), `${secret} is not in the file`);
  assert.match(data.caption, /^💾 Backup · 19-Nov-2026 · data\n3 database tables · 4 rows · \d+ KB\n1 long cell\(s\) from the workbook, in full\nKeep it with the workbook file of the same date\.$/);
  assert.deepEqual(built.warnings, []);
});

test('the database is read in one read-only snapshot, and every query is a read', async () => {
  await offsiteBackup.build({ now: NOW });
  assert.equal(queries[0].text, 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  for (const q of queries.slice(1)) assert.match(q.text, /^SELECT /, q.text.slice(0, 60));
  assert.ok(!queries.some((q) => /web_sessions|agent_keys|app_logs|inventory_rows/.test(q.text) && /to_jsonb/.test(q.text)));
});

test('a long table is read in key pages: every row once, the next page asked after the last key', async () => {
  DB.payment_events.rows = Array.from({ length: I.PAGE + 3 }, (_, i) => ({ id: i + 1, kind: 'k' }));
  const built = await offsiteBackup.build({ now: NOW });
  const rows = gunzipLines(built.files.find((f) => f.kind === 'data').buffer).filter((l) => l.type === 'row' && l.t === 'payment_events');
  assert.equal(rows.length, I.PAGE + 3);
  assert.equal(new Set(rows.map((l) => l.r.id)).size, I.PAGE + 3, 'no row twice');
  const paged = queries.filter((q) => /FROM "payment_events" t/.test(q.text));
  assert.equal(paged.length, 2);
  assert.match(paged[1].text, /WHERE t\."id" > \$1::bigint ORDER BY t\."id" LIMIT 5000$/);
  assert.deepEqual(paged[1].params, [String(I.PAGE)]);
});

test('over the size cap the workbook is split by tab: every tab in exactly one file, nothing dropped', async () => {
  TABS = Array.from({ length: 6 }, (_, i) => ({
    name: `Tab${i + 1}`,
    // incompressible-ish content so each tab has real weight
    rows: Array.from({ length: 300 }, (_, r) => [`${i}-${r}-${Math.sin(i * 1000 + r).toString(36)}`, r * 1.37]),
  }));
  const whole = (await offsiteBackup.build({ now: NOW })).files.filter((f) => f.kind === 'workbook');
  assert.equal(whole.length, 1);
  const cap = Math.ceil(whole[0].buffer.length / 2);
  const split = (await offsiteBackup.build({ now: NOW, cap })).files.filter((f) => f.kind === 'workbook');
  assert.ok(split.length >= 2);
  assert.match(split[0].filename, /-workbook-part1of\d+\.xlsx$/);
  assert.match(split[0].caption, /· workbook · part 1 of \d+\n/);
  const seen = split.flatMap((f) => XLSX.read(f.buffer, { type: 'buffer' }).SheetNames.filter((s) => s !== '_BACKUP'));
  assert.deepEqual(seen.sort(), TABS.map((t) => t.name).sort());
  for (const f of split) assert.ok(f.buffer.length <= cap, 'each part fits');
});

test('a single tab over the cap is sent anyway and SAID — never silently missing', async () => {
  const built = await offsiteBackup.build({ now: NOW, cap: 10 });
  assert.equal(built.files.filter((f) => f.kind === 'workbook').length, 4, 'one file per tab');
  assert.ok(built.warnings.some((w) => /The tab Inventory is over Telegram's 50 MB limit/.test(w)));
});

test('an empty workbook read is a failure, not a backup', async () => {
  TABS = [{ name: 'Inventory', rows: [] }];
  await assert.rejects(() => offsiteBackup.build({ now: NOW }), /the workbook read back empty/);
  sheets.getSheetGrid = async () => [];
  await assert.rejects(() => offsiteBackup.build({ now: NOW }), /the workbook returned no tabs/);
});

test('without a database: only the workbook — unless a cell was cut, then the data file carries just that', async () => {
  pgOn = false;
  let built = await offsiteBackup.build({ now: NOW });
  const data = built.files.find((f) => f.kind === 'data');
  assert.deepEqual(gunzipLines(data.buffer).map((l) => l.type), ['header', 'cell', 'footer']);
  assert.ok(!/database tables/.test(data.caption));

  TABS[1].rows[2][1] = '{"short":1}';
  built = await offsiteBackup.build({ now: NOW });
  assert.deepEqual(built.files.map((f) => f.kind), ['workbook']);
  assert.equal(built.summary.data, null);
});

test('a database that cannot be read does not stop the workbook: the gap is written on the file', async () => {
  pgFail = 'connection refused';
  const built = await offsiteBackup.build({ now: NOW });
  assert.equal(built.files.filter((f) => f.kind === 'workbook').length, 1);
  const data = built.files.find((f) => f.kind === 'data');
  assert.match(data.caption, /⚠️ The database could not be read: connection refused/);
  assert.equal(gunzipLines(data.buffer).at(-1).database_error, 'connection refused');
  assert.equal(built.summary.data.error, 'connection refused');
  assert.deepEqual(built.warnings, ['The database could not be read: connection refused']);
});

/* ── bounded memory ──────────────────────────────────────────────────── */

test('a tab with a very tall grid is never loaded whole: read in windows, streamed into the data file, and said', async () => {
  const log = Array.from({ length: 25000 }, (_, i) => [`2026-11-19T00:00:${i % 60}Z`, 'event', i]);
  TABS.push({ name: 'AuditLog', rows: log, grid: 60000 });
  const built = await offsiteBackup.build({ now: NOW });

  const wb = built.files.find((f) => f.kind === 'workbook');
  assert.ok(!XLSX.read(wb.buffer, { type: 'buffer' }).SheetNames.includes('AuditLog'), 'not built as a spreadsheet');
  assert.match(wb.caption, /\nToo large for a workbook file, kept whole in the data file: AuditLog$/);

  const lines = gunzipLines(built.files.find((f) => f.kind === 'data').buffer);
  const srows = lines.filter((l) => l.type === 'srow' && l.tab === 'AuditLog');
  assert.equal(srows.length, 25000, 'every row is there');
  assert.deepEqual([srows[0].n, srows[0].r], [1, log[0]]);
  assert.deepEqual([srows.at(-1).n, srows.at(-1).r], [25000, log[24999]], 'each row keeps its row number');
  assert.deepEqual(lines.at(-1).sheets, ['AuditLog']);
  assert.match(built.files.find((f) => f.kind === 'data').caption, /\n1 large workbook tab\(s\), whole: AuditLog\n/);

  const windows = reads.filter((r) => r.length === 1 && r[0].startsWith("'AuditLog'!")).map((r) => r[0]);
  assert.deepEqual(windows, ["'AuditLog'!1:10000", "'AuditLog'!10001:20000", "'AuditLog'!20001:30000", "'AuditLog'!30001:40000", "'AuditLog'!40001:50000", "'AuditLog'!50001:60000"],
    'the whole grid is walked in 10,000-row windows — no early stop on a quiet stretch');
  assert.equal(built.summary.workbook.rows, 7 + 25000);
  assert.deepEqual(built.summary.workbook.inData, ['AuditLog']);
});

test('a workbook file carries a cell budget: more cells means more files, and a tab over the budget is streamed', async () => {
  TABS = [
    { name: 'A', rows: Array.from({ length: 30 }, (_, r) => [r, 'a', 'b', 'c']) },   // 120 cells
    { name: 'B', rows: Array.from({ length: 30 }, (_, r) => [r, 'a', 'b', 'c']) },   // 120
    { name: 'C', rows: Array.from({ length: 30 }, (_, r) => [r, 'a', 'b', 'c']) },   // 120
    { name: 'Huge', rows: Array.from({ length: 100 }, (_, r) => [r, 'a', 'b', 'c']) }, // 400 — over the budget alone
  ];
  pgOn = false;
  const built = await offsiteBackup.build({ now: NOW, cellsPerFile: 250 });
  const books = built.files.filter((f) => f.kind === 'workbook');
  assert.deepEqual(books.map((f) => XLSX.read(f.buffer, { type: 'buffer' }).SheetNames), [['_BACKUP', 'A', 'B'], ['_BACKUP', 'C']]);
  assert.deepEqual(books.map((f) => f.filename), ['afp-backup-2026-11-19-workbook-part1of2.xlsx', 'afp-backup-2026-11-19-workbook-part2of2.xlsx']);
  const lines = gunzipLines(built.files.find((f) => f.kind === 'data').buffer);
  assert.deepEqual(lines.filter((l) => l.type === 'sheet'), [{ type: 'sheet', tab: 'Huge', rows: 100 }]);
  assert.equal(lines.filter((l) => l.type === 'srow').length, 100);
  assert.deepEqual(built.summary.workbook.inData, ['Huge']);
});

test('when every tab is too large the data file is the whole backup, and says so', async () => {
  TABS = [{ name: 'Only', rows: Array.from({ length: 50 }, (_, r) => [r, 'x']) }];
  pgOn = false;
  const built = await offsiteBackup.build({ now: NOW, cellsPerFile: 10 });
  assert.deepEqual(built.files.map((f) => f.kind), ['data']);
  assert.match(built.files[0].caption, /\nThis is the whole backup of that date\.$/);
});

test('reads are planned by grid size: one request asks for a bounded number of grid cells', () => {
  const plan = I.batchesByGrid([{ name: 'a', rows: 1000, cols: 26 }, { name: 'b', rows: 30000, cols: 26 }, { name: 'c', rows: 30000, cols: 26 }, { name: 'd', rows: 10, cols: 5 }], 1000000);
  assert.deepEqual(plan.map((b) => b.map((t) => t.name)), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(I.batchesByGrid([{ name: 'x', rows: 39000, cols: 100 }], 1000), [[{ name: 'x', rows: 39000, cols: 100 }]], 'a tab alone over the limit still gets its own request');
  assert.deepEqual(I.batchesByGrid([], 10), []);
});

/* ── delivery ────────────────────────────────────────────────────────── */

/* BKP-3 — "This backup job should never be happening alone to a single
 * admin … make it available only through two admins." */

/** Run `fn` with a different Railway admin list, then put the real one back. */
async function withAdmins(ids, fn) {
  const config = require('../../../src/config');
  const keep = config.access.adminIds;
  config.access.adminIds = ids;
  try { return await fn(); } finally { config.access.adminIds = keep; }
}

test('who receives the daily backup: every admin; the Settings cell may only narrow among admins', () => {
  const d = (cell) => offsiteBackup.dailyRecipients({ OFFSITE_BACKUP_IDS: cell });
  assert.deepEqual(d(''), { ids: ['777', '888'], ignored: [], widened: false, blocked: '' });
  assert.deepEqual(offsiteBackup.dailyRecipients(null).ids, ['777', '888']);
  // a group, a channel, an employee: never a recipient, and named
  assert.deepEqual(d(' -1001234567890, 555 ; 555 abc '), { ids: ['777', '888'], ignored: ['-1001234567890', '555'], widened: true, blocked: '' });
  // ONE admin named: not honoured — every admin receives it, never one alone
  assert.deepEqual(d('888'), { ids: ['777', '888'], ignored: [], widened: true, blocked: '' });
  // two admins named: honoured, in the cell's order
  assert.deepEqual(d('888, 777, 4242'), { ids: ['888', '777'], ignored: ['4242'], widened: false, blocked: '' });
  assert.deepEqual(offsiteBackup.recipients({ OFFSITE_BACKUP_IDS: '888' }), ['777', '888']);
});

test('fewer than two admins: nobody receives the daily backup, whatever the cell says', async () => {
  await withAdmins(['777'], async () => {
    const r = offsiteBackup.dailyRecipients({ OFFSITE_BACKUP_IDS: '777, -100123, 888' });
    assert.deepEqual(r.ids, []);
    assert.equal(r.blocked, 'a backup goes to at least 2 admins and only 1 is set up (Railway ADMIN_IDS)');
    const bot = createFakeBot();
    const res = await offsiteBackup.run(bot, { now: NOW });
    assert.deepEqual([res.ok, res.blocked], [false, true]);
    assert.equal(docs(bot).length, 0);
    assert.equal(reads.length, 0, 'nothing was even read');
  });
  await withAdmins([], async () => {
    assert.match(offsiteBackup.dailyRecipients({}).blocked, /only 0 are set up/);
  });
});

test('the pair behind a backup on demand: two DIFFERENT admins from ADMIN_IDS', () => {
  const pair = (a, b) => offsiteBackup.releasePair({ requestedBy: a, approvedBy: b });
  assert.deepEqual(pair('777', '888'), { ok: true, ids: ['777', '888'] });
  assert.deepEqual(pair(888, 777), { ok: true, ids: ['888', '777'] });
  assert.match(pair('777', '777').message, /two different admins/);
  assert.match(pair('777', '4242').message, /Railway ADMIN_IDS/);
  assert.match(pair('4242', '888').message, /Railway ADMIN_IDS/);
  assert.match(pair('777', '').message, /who asked and the admin who approved/);
  assert.equal(offsiteBackup.releasePair(null).ok, false);
  assert.equal(offsiteBackup.releasePair({}).ok, false);
});

test('run: each file goes up once and is forwarded by its file id; the run is recorded', async () => {
  const bot = createFakeBot();
  const res = await offsiteBackup.run(bot, { now: NOW });
  assert.equal(res.ok, true);
  const d = docs(bot);
  assert.equal(d.length, 4, 'two files × two admins');
  assert.deepEqual(d.map((x) => String(x.chatId)), ['777', '888', '777', '888']);
  assert.ok(Buffer.isBuffer(d[0].doc) && d[0].fileOptions.filename.endsWith('-workbook.xlsx'));
  assert.equal(typeof d[1].doc, 'string', 'the second admin gets the file id, not a second upload');
  assert.match(d[1].doc, /^doc_/);
  assert.ok(Buffer.isBuffer(d[2].doc) && d[2].fileOptions.filename.endsWith('-data.ndjson.gz'));
  assert.equal(d[0].opts.disable_notification, true, 'the nightly run does not ring a phone at 02:00');
  assert.equal(d[0].opts.caption, d[1].opts.caption);

  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0].job, runs[0].day, runs[0].status], ['offsite_backup', '2026-11-19', 'ok']);
  assert.equal(runs[0].detail.workbook.tabs, 4);
  assert.equal(runs[0].detail.recipients, 2);
});

test('an admin the bot cannot reach is found BEFORE anything is built: one reachable admin = nothing sent', async () => {
  const bot = createFakeBot();
  const act = bot.sendChatAction.bind(bot);
  bot.sendChatAction = async (chatId, ...rest) => { if (String(chatId) === '777') throw new Error('bot was blocked by the user'); return act(chatId, ...rest); };
  const res = await offsiteBackup.run(bot, { now: NOW });
  assert.equal(res.ok, false);
  assert.deepEqual(res.unreachable, ['777']);
  assert.match(res.message, /cannot reach 1 of the 2 admins .* nothing was sent, because a backup never goes to one admin alone/);
  assert.equal(docs(bot).length, 0, '888 does not receive it alone');
  assert.equal(reads.length, 0, 'nothing was built');
  assert.equal(runs.length, 0);
});

test('three admins, one unreachable: the two who can be reached receive it', async () => {
  await withAdmins(['777', '888', '999'], async () => {
    const bot = createFakeBot();
    const act = bot.sendChatAction.bind(bot);
    bot.sendChatAction = async (chatId, ...rest) => { if (String(chatId) === '888') throw new Error('chat not found'); return act(chatId, ...rest); };
    const res = await offsiteBackup.run(bot, { now: NOW });
    assert.equal(res.ok, true);
    assert.deepEqual([...new Set(docs(bot).map((x) => String(x.chatId)))], ['777', '999']);
    assert.deepEqual([res.recipients, res.alone], [2, false]);
  });
});

test('run: a send that fails AFTER the check leaves one holder — recorded, and every admin is told; a file that reaches NOBODY fails the run', async () => {
  const bot = createFakeBot();
  const send = bot.sendDocument.bind(bot);
  bot.sendDocument = async (chatId, ...rest) => { if (String(chatId) === '777') throw new Error('bot was blocked'); return send(chatId, ...rest); };
  let res = await offsiteBackup.run(bot, { now: NOW });
  assert.equal(res.ok, true);
  assert.equal(res.undelivered, 2);
  assert.ok(Buffer.isBuffer(docs(bot)[0].doc), 'the upload moved to the next chat');
  assert.deepEqual([res.alone, res.holders], [true, ['888']]);
  assert.deepEqual(runs[0].detail.holders, ['888']);
  const warned = bot.callsTo('sendMessage').map((c) => c.args);
  assert.deepEqual(warned.map((w) => String(w.chatId)), ['777', '888'], 'both admins are told');
  assert.match(warned[0].text, /^⚠️ Backup: the files reached only one admin \(id 888\)\./);

  bot.sendDocument = async () => { throw new Error('bot was blocked'); };
  res = await offsiteBackup.run(bot, { now: NOW });
  assert.equal(res.ok, false);
  assert.match(res.message, /afp-backup-2026-11-19-workbook\.xlsx.* reached nobody: bot was blocked/);
});

test('run on demand: to the two admins who asked and approved, with sound, recorded with the pair', async () => {
  const bot = createFakeBot();
  const res = await offsiteBackup.run(bot, { now: NOW, kind: 'manual', release: { requestId: 'R-1', requestedBy: '888', approvedBy: '777' } });
  assert.equal(res.ok, true);
  assert.deepEqual(docs(bot).map((x) => String(x.chatId)), ['888', '777', '888', '777'], 'two files, both admins');
  assert.equal(docs(bot)[0].opts.disable_notification, false);
  assert.equal(runs[0].status, 'manual');
  assert.deepEqual(runs[0].detail.release, { requestId: 'R-1', requestedBy: '888', approvedBy: '777' });
  assert.deepEqual([res.alone, res.holders], [false, ['888', '777']]);
  assert.equal(await jobRuns.hasOk('offsite_backup', '2026-11-19'), false, 'a copy on demand is not the day\'s scheduled run');
});

test('run on demand is refused without two different admins — there is no way to name a chat', async () => {
  const cases = [
    { kind: 'manual' },                                                        // nobody behind it
    { kind: 'manual', release: { requestedBy: '777', approvedBy: '777' } },    // one admin twice
    { kind: 'manual', release: { requestedBy: '777', approvedBy: '4242' } },   // an employee approving
    { kind: 'manual', release: { requestedBy: '-100123', approvedBy: '888' } }, // a channel asking
    { kind: 'manual', toIds: ['777'] },                                        // the retired parameter
    { kind: 'manual', toIds: ['777'], release: { requestedBy: '777' } },
    // two admins, but no approved backup request behind them
    { kind: 'manual', release: { requestedBy: '888', approvedBy: '777' } },                    // no request named
    { kind: 'manual', release: { requestId: 'R-0', requestedBy: '888', approvedBy: '777' } }, // no such request
    { kind: 'manual', release: { requestId: 'R-2', requestedBy: '777', approvedBy: '888' } }, // not approved yet
    { kind: 'manual', release: { requestId: 'R-3', requestedBy: '777', approvedBy: '888' } }, // another kind of request
    { kind: 'manual', release: { requestId: 'R-1', requestedBy: '777', approvedBy: '888' } }, // raised by someone else
  ];
  for (const o of cases) {
    const bot = createFakeBot();
    const res = await offsiteBackup.run(bot, { now: NOW, ...o });
    assert.deepEqual([res.ok, res.refused], [false, true], JSON.stringify(o));
    assert.equal(docs(bot).length, 0, JSON.stringify(o));
  }
  assert.equal(reads.length, 0, 'nothing was built for any of them');
  assert.equal(runs.length, 0);
});

test('one approved request releases ONE backup: a second run on it is refused; an unreadable request releases nothing', async () => {
  const release = { requestId: 'R-1', requestedBy: '888', approvedBy: '777' };
  const bot = createFakeBot();
  assert.equal((await offsiteBackup.run(bot, { now: NOW, kind: 'manual', release })).ok, true);
  const again = await offsiteBackup.run(bot, { now: NOW, kind: 'manual', release });
  assert.deepEqual([again.ok, again.refused, again.message], [false, true, 'That request has already released its backup. Ask again for a new one.']);
  assert.equal(docs(bot).length, 4, 'only the first run sent files');

  I._resetForTests();
  approvalQueueRepository.getByRequestId = async () => { throw new Error('quota'); };
  const bot2 = createFakeBot();
  const res = await offsiteBackup.run(bot2, { now: NOW, kind: 'manual', release });
  assert.deepEqual([res.ok, res.refused], [false, true]);
  assert.match(res.message, /could not be read \(quota\)/);
  assert.equal(docs(bot2).length, 0);
});

test('run on demand: one of the two cannot be reached — nothing is sent to the other', async () => {
  const bot = createFakeBot();
  const act = bot.sendChatAction.bind(bot);
  bot.sendChatAction = async (chatId, ...rest) => { if (String(chatId) === '888') throw new Error('bot was blocked by the user'); return act(chatId, ...rest); };
  queue['R-9'] = { requestId: 'R-9', user: '777', status: 'approved', actionJSON: { action: 'release_backup' } };
  const res = await offsiteBackup.run(bot, { now: NOW, kind: 'manual', release: { requestId: 'R-9', requestedBy: '777', approvedBy: '888' } });
  assert.equal(res.ok, false);
  assert.deepEqual(res.unreachable, ['888']);
  assert.equal(docs(bot).length, 0);
  assert.equal(reads.length, 0);
});

test('a run record that cannot be saved does not fail a backup that was delivered', async () => {
  recordFails = true;
  const res = await offsiteBackup.run(createFakeBot(), { now: NOW });
  assert.equal(res.ok, true);
});

/* ── the schedule ────────────────────────────────────────────────────── */

test('tick: off when switched off; nothing before the hour; once at or after it; never twice in a day', async () => {
  const bot = createFakeBot();
  settings.OFFSITE_BACKUP_ENABLED = 0;
  assert.equal(await offsiteBackup.tick(bot, NOW), 'disabled');
  settings.OFFSITE_BACKUP_ENABLED = 1;
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T01:50:00+01:00')), 'early');
  assert.equal(docs(bot).length, 0);

  assert.equal(await offsiteBackup.tick(bot, NOW), 'ran');
  assert.equal(docs(bot).length, 4);
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T02:40:00+01:00')), 'done');
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T23:50:00+01:00')), 'done');
  assert.equal(docs(bot).length, 4);

  // the next Lagos day
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-20T02:05:00+01:00')), 'ran');
  assert.equal(docs(bot).length, 8);
});

test('tick after a restart: the day already on record is not sent again', async () => {
  const bot = createFakeBot();
  assert.equal(await offsiteBackup.tick(bot, NOW), 'ran');
  I._resetForTests();           // a redeploy: memory gone, the record stays
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T15:00:00+01:00')), 'done');
  assert.equal(docs(bot).length, 4);
});

test('tick: a bot that was down at the hour catches up later the same day', async () => {
  const bot = createFakeBot();
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T17:20:00+01:00')), 'ran');
});

test('tick: the hour follows Settings; a nonsense hour falls back to 02:00', async () => {
  const bot = createFakeBot();
  settings.OFFSITE_BACKUP_HOUR = 21;
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T20:59:00+01:00')), 'early');
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-19T21:00:00+01:00')), 'ran');
  I._resetForTests(); runs = [];
  settings.OFFSITE_BACKUP_HOUR = 99;
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-20T01:59:00+01:00')), 'early');
  assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-20T02:00:00+01:00')), 'ran');
});

test('tick: a failure tells the admins ONCE, waits an hour, and stops after three tries', async () => {
  const bot = createFakeBot();
  sheets.getSheetGrid = async () => { throw new Error('Sheets is down'); };
  const t = (hhmm) => new Date(`2026-11-19T${hhmm}:00+01:00`);

  assert.equal(await offsiteBackup.tick(bot, t('02:00')), 'failed');
  const dms = () => bot.callsTo('sendMessage').map((c) => c.args);
  assert.equal(dms().length, 2, 'both admins, once');
  assert.match(dms()[0].text, /^⚠️ Backup failed\nSheets is down\n\nThe bot tries again in an hour, three times a day\./);

  assert.equal(await offsiteBackup.tick(bot, t('02:10')), 'waiting');
  assert.equal(await offsiteBackup.tick(bot, t('03:01')), 'failed');
  assert.equal(await offsiteBackup.tick(bot, t('04:02')), 'failed');
  assert.equal(await offsiteBackup.tick(bot, t('06:00')), 'waiting', 'three tries spent');
  assert.equal(dms().length, 2, 'no second alarm');

  // it recovers by itself on a later try the same day
  I._resetForTests();
  sheets.getSheetGrid = async () => { throw new Error('Sheets is down'); };
  assert.equal(await offsiteBackup.tick(bot, t('02:00')), 'failed');
  sheets.getSheetGrid = async () => TABS.map((x) => ({ name: x.name, rows: 1000, cols: 26 }));
  assert.equal(await offsiteBackup.tick(bot, t('03:05')), 'ran');
  assert.equal(await offsiteBackup.tick(bot, t('03:15')), 'done');
});

test('tick: with one admin the daily backup does not go out — said once a day, never retried as a failure', async () => {
  await withAdmins(['777'], async () => {
    const bot = createFakeBot();
    const t = (hhmm) => new Date(`2026-11-19T${hhmm}:00+01:00`);
    assert.equal(await offsiteBackup.tick(bot, t('02:00')), 'blocked');
    assert.equal(await offsiteBackup.tick(bot, t('02:10')), 'blocked');
    assert.equal(await offsiteBackup.tick(bot, t('09:00')), 'blocked');
    const dms = bot.callsTo('sendMessage').map((c) => c.args);
    assert.equal(dms.length, 1, 'one notice for the day');
    assert.equal(String(dms[0].chatId), '777');
    assert.match(dms[0].text, /^🔐 The daily backup was NOT sent\na backup goes to at least 2 admins and only 1 is set up \(Railway ADMIN_IDS\)\.\n\nA backup never goes to one admin alone\./);
    assert.equal(docs(bot).length, 0);
    assert.equal(await offsiteBackup.tick(bot, new Date('2026-11-20T02:00:00+01:00')), 'blocked');
    assert.equal(bot.callsTo('sendMessage').length, 2, 'said again the next day');
  });
});

test('tick: unreadable Settings sends nothing', async () => {
  settingsRepository.getAll = async () => { throw new Error('quota'); };
  const bot = createFakeBot();
  assert.equal(await offsiteBackup.tick(bot, NOW), 'settings_unreadable');
  assert.equal(docs(bot).length, 0);
});

/* ── the status card ─────────────────────────────────────────────────── */

test('status + card: the schedule, who receives it, and the last run', async () => {
  let st = await offsiteBackup.status();
  assert.deepEqual([st.enabled, st.hour, st.recipients, st.last], [true, 2, ['777', '888'], null]);
  assert.deepEqual([st.ignored, st.widened, st.blocked, st.admins], [[], false, '', 2]);
  let text = backupFlow._internals.cardText(st, ['Krishna', 'Musa']);
  assert.equal(text, [
    '💾 *Backup*', '',
    'Runs every day at 02:00 and goes to: Krishna, Musa.',
    'Two files: the workbook, and the database records.',
    '🔐 A backup never goes to one admin alone. One on demand is asked by one admin and approved by another, and both receive it.',
    '', 'Last backup: none on record yet.',
  ].join('\n'));

  // what the two-admin rule did with the Settings cell is said on the card
  settings.OFFSITE_BACKUP_IDS = '-1001234567890, 888';
  text = backupFlow._internals.cardText(await offsiteBackup.status(), ['Krishna', 'Musa']);
  assert.match(text, /⚠️ Settings `OFFSITE_BACKUP_IDS` names 1 chat that is not an admin\. Only admins receive a backup\.\n⚠️ Settings `OFFSITE_BACKUP_IDS` names fewer than two admins, so every admin receives the backup\./);
  settings.OFFSITE_BACKUP_IDS = '';
  await withAdmins(['777'], async () => {
    const one = await offsiteBackup.status();
    assert.deepEqual([one.recipients, one.admins], [[], 1]);
    assert.match(backupFlow._internals.cardText(one, []), /^💾 \*Backup\*\n\n🔐 The daily backup is NOT being sent: a backup goes to at least 2 admins and only 1 is set up \(Railway ADMIN_IDS\)\.\n/);
    assert.deepEqual(backupFlow._internals.keyboard(one, null, '777').flat().map((b) => b.callback_data), ['act:__back__'], 'nothing to ask with one admin');
  });

  // the pending request, as its asker and as the other admin see it
  const open = { who: 'Krishna', age: 'under 1h', ref: 'R-AB12', mine: true };
  assert.match(backupFlow._internals.cardText(st, ['Krishna', 'Musa'], { open }), /\n\n⏳ You asked for a backup under 1h ago · R-AB12 · waiting on another admin\.$/);
  assert.match(backupFlow._internals.cardText(st, ['Krishna', 'Musa'], { open: { ...open, mine: false } }), /\n\n⏳ Krishna asks for a backup · under 1h ago · R-AB12\. Approving sends the files to you and to Krishna\.$/);
  const row = { requestId: 'aaaa1111-2222', user: '777' };
  assert.deepEqual(backupFlow._internals.keyboard(st, row, '777').flat().map((b) => b.callback_data), ['apg:nudge:aaaa1111-2222', 'apg:st:aaaa1111-2222', 'act:__back__']);
  assert.deepEqual(backupFlow._internals.keyboard(st, row, '888').flat().map((b) => `${b.text}|${b.callback_data}`),
    ['✅ Approve and send|approve:aaaa1111-2222', '❌ Reject|reject:aaaa1111-2222', '🏠 Back to menu|act:__back__']);
  assert.deepEqual(backupFlow._internals.keyboard(st, null, '777').flat().map((b) => `${b.text}|${b.callback_data}`),
    ['📤 Ask for a backup now|bkp:ask', '🏠 Back to menu|act:__back__']);

  await offsiteBackup.run(createFakeBot(), { now: NOW });
  st = await offsiteBackup.status();
  text = backupFlow._internals.cardText(st, ['Krishna', 'Musa'], { note: '✅ note' });
  assert.match(text, /Workbook: 4 tabs · 7 rows · \d+ KB\nDatabase: 3 tables · 4 rows · \d+ KB\n\n✅ note$/);
  assert.match(text, /Last backup: \d{2}-[A-Z][a-z]{2}-\d{4} \d{2}:\d{2}\n/);

  settings.OFFSITE_BACKUP_ENABLED = 0;
  text = backupFlow._internals.cardText(await offsiteBackup.status(), []);
  assert.match(text, /⚠️ The daily backup is switched OFF \(Settings `OFFSITE_BACKUP_ENABLED`\)\./);
});

/* ── the restore script ──────────────────────────────────────────────── */

async function writeDataFile() {
  const built = await offsiteBackup.build({ now: NOW });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bkp2-')), 'data.ndjson.gz');
  fs.writeFileSync(file, built.files.find((f) => f.kind === 'data').buffer);
  return file;
}

test('restore: the file lists what it holds without touching anything', async () => {
  const sum = await restore.summarise(await writeDataFile());
  assert.equal(sum.header.day, '2026-11-19');
  assert.deepEqual([...sum.tables].map(([name, t]) => [name, t.rows]), [['payment_events', 2], ['schema_migrations', 1], ['transfers', 1]]);
  assert.deepEqual(sum.cells, [{ tab: 'ApprovalQueue', row: 3, col: 2, length: LONG.length }]);
  assert.equal(restore.colLetter(2), 'B');
  assert.equal(restore.colLetter(27), 'AA');
});

test('restore --tables: a dry run writes nothing; --commit inserts each row once-safely and moves the counters', async () => {
  const file = await writeDataFile();
  const ran = [];
  const query = async (text, params) => {
    ran.push({ text, params });
    if (/information_schema\.columns/.test(text)) return { rows: params[0] === 'payment_events' ? [{ column_name: 'id' }] : [] };
    return { rowCount: 1, rows: [] };
  };
  const dry = await restore.restoreTables(file, { commit: false, only: null, query });
  assert.equal(ran.length, 0, 'nothing ran');
  assert.deepEqual([...dry].map(([nm, c]) => [nm, c.seen, c.inserted]), [['payment_events', 2, 0], ['schema_migrations', 1, 0], ['transfers', 1, 0]]);

  const done = await restore.restoreTables(file, { commit: true, only: new Set(['payment_events']), query });
  assert.deepEqual([...done].map(([nm, c]) => [nm, c.seen, c.inserted]), [['payment_events', 2, 2]]);
  const inserts = ran.filter((q) => /^INSERT/.test(q.text));
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].text, 'INSERT INTO "payment_events" SELECT * FROM jsonb_populate_record(NULL::"payment_events", $1::jsonb) ON CONFLICT DO NOTHING');
  assert.deepEqual(JSON.parse(inserts[0].params[0]), { id: 1, kind: 'approved' });
  assert.ok(ran.some((q) => /^SELECT setval\(pg_get_serial_sequence\('public\.payment_events', 'id'\)/.test(q.text)), 'the id counter is moved past the restored rows');
});

test('restore --sheets: a large tab goes back at its own row numbers, in runs, and the tab is created when missing', async () => {
  TABS.push({ name: 'AuditLog', rows: Array.from({ length: 1203 }, (_, i) => [`e${i}`, i]), grid: 60000 });
  const file = await writeDataFile();
  const sum = await restore.summarise(file);
  assert.deepEqual([...sum.sheets], [['AuditLog', 1203]]);

  const writes = [];
  const added = [];
  const client = {
    getSheetNames: async () => ['Inventory'],
    addSheet: async (t) => { added.push(t); },
    updateRange: async (tab, range, values) => { writes.push({ tab, range, rows: values.length, first: values[0] }); },
  };
  const dry = await restore.restoreSheets(file, { commit: false, sheets: client });
  assert.deepEqual([...dry], [['AuditLog', 1203]]);
  assert.equal(writes.length + added.length, 0, 'a dry run writes nothing');

  await restore.restoreSheets(file, { commit: true, sheets: client });
  assert.deepEqual(added, ['AuditLog']);
  assert.deepEqual(writes.map((w) => [w.tab, w.range, w.rows]), [['AuditLog', 'A1', 500], ['AuditLog', 'A501', 500], ['AuditLog', 'A1001', 203]]);
  assert.deepEqual(writes[1].first, ['e500', 500]);
});

test('restore: argument parsing — a dry run unless --commit', () => {
  assert.deepEqual(restore.parseArgs(['node', 'x', 'f.gz']), { file: 'f.gz', tables: false, cells: false, sheets: false, commit: false, only: null });
  const a = restore.parseArgs(['node', 'x', 'f.gz', '--tables', '--only', 'a,b', '--commit']);
  assert.deepEqual([a.tables, a.commit, [...a.only]], [true, true, ['a', 'b']]);
});
