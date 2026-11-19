'use strict';

/**
 * BKP-2 — the offsite backup job.
 *
 * Owner, 01-Sep-2026 (the idea) and 19-Nov-2026 (the go): one scheduled
 * job, two attachments, delivered over Telegram. Until this shipped NO
 * automated backup ran at all: BKP-1 copied the spreadsheet inside Google
 * Drive, and a service account has no Drive storage to copy into.
 *
 * What goes out, once a day:
 *
 *   1. the WORKBOOK as an .xlsx built in this process — every tab, values
 *      only, read in one request (sheetsClient.readAllSheets). No Drive, no
 *      storage quota. A human can open it on a phone.
 *   2. the DATA file (.ndjson.gz) — every Postgres table that holds a record
 *      found nowhere else, one JSON row per line, plus the full text of any
 *      cell too long for an .xlsx (the format caps a cell at 32,767
 *      characters; an approval's JSON can be longer). scripts/
 *      restore-backup-data.js puts both back.
 *
 * A Telegram document may be 50 MB. A workbook over the cap is split by tab
 * into several files; nothing is dropped silently.
 *
 * MEMORY IS BOUNDED. Building an .xlsx holds the whole file in memory
 * (measured: 200,000 rows × 8 columns took about 700 MB), which would take
 * the bot down with it. So: tabs are read in batches, a workbook file
 * carries at most `config.offsiteBackup.cellsPerFile` cells, and a tab too
 * large for a file — a long log — is STREAMED row by row into the data file
 * instead (the captions say which). The restore script writes it back.
 *
 * "Did today's backup already go out?" is answered by Postgres `job_runs`
 * (the bot redeploys on every push — memory alone would re-send on each
 * restart). Without Postgres the day is kept in memory.
 *
 * Settings: OFFSITE_BACKUP_ENABLED (1) · OFFSITE_BACKUP_HOUR (2, Lagos) ·
 * OFFSITE_BACKUP_IDS (blank = every admin in ADMIN_IDS; it may only NARROW
 * the list among those admins).
 *
 * Never throws out of the scheduler; a failure DMs the admins once a day
 * and is retried hourly, three times.
 *
 * BKP-3 — TWO ADMINS. Owner, 19-Nov-2026: "This backup job should never be
 * happening alone to a single admin. It may cause risk to the company
 * data, so make it available only through two admins." The files are the
 * whole company record, so the rule lives HERE, in the one function that
 * sends them (`run`), and every caller passes through it:
 *
 *   · an "admin" is an id in the Railway ADMIN_IDS list — never a Users-
 *     sheet role and never an id typed into a Settings cell, because both
 *     can be edited by anyone who can edit the workbook;
 *   · the DAILY backup goes to two or more admins or it does not go
 *     (a group, a channel or any other chat is never a recipient);
 *   · a backup ON DEMAND is a request one admin raises and a DIFFERENT
 *     admin approves (`release_backup`, the ordinary approval queue); the
 *     files go to those two and to nobody else, and every admin is told;
 *   · a run on demand is only ever the execution of ONE approved request,
 *     once (`approvedRelease`) — there is no parameter that names a chat;
 *   · before anything is built, every recipient is checked to be reachable
 *     — a backup that could reach only one of them is not sent.
 */

const zlib = require('zlib');
const { once } = require('events');
const XLSX = require('xlsx');
const config = require('../config');
const logger = require('../utils/logger');
const pool = require('../db/postgresPool');
const sheets = require('../repositories/sheetsClient');
const settingsRepository = require('../repositories/settingsRepository');
const jobRuns = require('../repositories/jobRunsRepository');
const fmtDate = require('../utils/formatDate');

const JOB = 'offsite_backup';
const TZ = 'Africa/Lagos';
const FORMAT = 'afp-backup-data/1';
/** Telegram's bot API takes a document up to 50 MB; leave room for the form. */
const CAP_BYTES = 45 * 1024 * 1024;
/** The .xlsx format's own limit on one cell's text. */
const CELL_MAX = 32767;
const CELL_KEEP = 32000;
const SHEET_NAME_MAX = 31;
const INDEX_SHEET = '_BACKUP';
const PAGE = 5000;
/** A tab whose GRID is taller than this is never loaded whole: it is read in windows and streamed. */
const BIG_TAB_ROWS = 40000;
const WINDOW_ROWS = 10000;
/** Grid cells asked for in one request (the grid over-states what a tab holds). */
const BATCH_GRID_CELLS = 1500000;
const TICK_MS = 10 * 60 * 1000;
const RETRY_MS = 60 * 60 * 1000;
const MAX_TRIES = 3;

/**
 * Tables that are NOT a business record: secrets, short-lived state, logs,
 * and copies rebuilt from a sheet. Everything else in the public schema is
 * dumped — a table added later is included without touching this list.
 */
const EXCLUDED_TABLES = {
  web_sessions: 'sign-in sessions (secret, short-lived)',
  ext_sessions: 'customer sign-in sessions (secret, short-lived)',
  ext_otp: 'one-time codes (secret, short-lived)',
  ext_throttle: 'rate-limit counters (short-lived)',
  agent_keys: 'the agent key record (secret)',
  app_logs: 'the console log (kept 14 days, not a business record)',
  inventory_rows: 'a copy of the Inventory sheet (rebuilt from the sheet)',
  mirror_meta: 'bookkeeping of that copy (rebuilt)',
};
const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;
const KEYSET_TYPE = /^(bigint|integer|smallint|text|uuid|character varying(\(\d+\))?)$/;

let _timer = null;
let _running = false;
let _doneDay = '';
let _failDay = '';
let _tries = 0;
let _nextTryAt = 0;
let _last = null;
let _blockedDay = '';
/** BKP-3 — request ids that have released their backup in this process: each releases once. */
const _released = new Set();

/** BKP-3 — a backup is never delivered to fewer than this many admins. */
const MIN_ADMINS = 2;

function lagosNow(now = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now)) % 24;
  return { day, hour };
}
const n = (v) => Number(v || 0).toLocaleString('en-US');
function size(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 0.1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/* ── the workbook ──────────────────────────────────────────────────── */

/** Tab titles as an .xlsx allows them: 31 characters, no : \ / ? * [ ], unique. */
function xlsxNames(names) {
  const used = new Set([INDEX_SHEET.toLowerCase()]);
  return names.map((orig) => {
    const base = (String(orig).replace(/[:\\/?*[\]]/g, '_').replace(/^'+|'+$/g, '').trim() || 'Sheet').slice(0, SHEET_NAME_MAX);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i += 1) {
      const suffix = `~${i}`;
      name = base.slice(0, SHEET_NAME_MAX - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  });
}

/**
 * Make a tab's values writable to an .xlsx. A cell longer than the format
 * allows is CUT with a visible marker, and its full text is handed to
 * `longCells` (it travels in the data file) — never dropped silently.
 */
function prepareTab(name, rows, longCells) {
  let cut = 0;
  const out = (Array.isArray(rows) ? rows : []).map((row, r) => (Array.isArray(row) ? row : []).map((cell, c) => {
    if (cell == null) return null;
    if (typeof cell === 'string' && cell.length > CELL_MAX) {
      longCells.push({ tab: name, row: r + 1, col: c + 1, text: cell });
      cut += 1;
      return `${cell.slice(0, CELL_KEEP)} …[cut: ${cell.length} characters, the full text is in the data file]`;
    }
    return (typeof cell === 'number' || typeof cell === 'boolean' || typeof cell === 'string') ? cell : String(cell);
  }));
  return { rows: out, cut };
}

/** One .xlsx holding the given tabs, with an index sheet in front. */
function buildWorkbookBuffer(tabs, createdAt) {
  const wb = XLSX.utils.book_new();
  const index = [
    ['Backup of the AtFactoryPrice workbook'],
    ['Made', createdAt],
    ['Values only. Formulas and formatting are not carried.'],
    [],
    ['Tab in this file', 'Tab in the workbook', 'Rows', 'Cells cut'],
    ...tabs.map((t) => [t.xlsxName, t.name, t.rows.length, t.cut]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(index), INDEX_SHEET);
  // dense: cells in arrays, not one object key per address — a third less memory
  for (const t of tabs) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(t.rows, { dense: true }), t.xlsxName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}

/**
 * Every tab in one file when it fits under `cap`; otherwise split by halves
 * until each file fits. A single tab that is itself over the cap comes back
 * marked `tooBig` — the caller says so, it is never dropped quietly.
 */
function packWorkbooks(tabs, cap, createdAt) {
  const buffer = buildWorkbookBuffer(tabs, createdAt);
  if (buffer.length <= cap || tabs.length <= 1) return [{ tabs, buffer, tooBig: buffer.length > cap }];
  const mid = Math.ceil(tabs.length / 2);
  return [...packWorkbooks(tabs.slice(0, mid), cap, createdAt), ...packWorkbooks(tabs.slice(mid), cap, createdAt)];
}

/** Tabs grouped so one request asks for at most `limit` grid cells (a tab alone may exceed it). */
function batchesByGrid(tabs, limit) {
  const out = [];
  let cur = [];
  let cells = 0;
  for (const t of tabs) {
    const c = Math.max(1, t.rows * Math.max(1, t.cols));
    if (cur.length && cells + c > limit) { out.push(cur); cur = []; cells = 0; }
    cur.push(t); cells += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Read the workbook with bounded memory and turn it into files.
 *
 *   · a tab whose grid is taller than BIG_TAB_ROWS is read in windows and
 *     streamed into the data file (`sheet` + `srow` lines);
 *   · the others are read in batches and packed into .xlsx files of at most
 *     `cellsPerFile` cells; one that alone exceeds the budget is streamed
 *     too.
 *
 * @returns {Promise<{books: Array<{tabs, buffer, tooBig}>, inData: string[], longCells: Array, tabs: number, rows: number}>}
 */
async function readWorkbook(writer, { cap, cellsPerFile, createdAt }) {
  const grid = await sheets.getSheetGrid();
  if (!grid || !grid.length) throw new Error('the workbook returned no tabs');
  const mapped = xlsxNames(grid.map((g) => g.name));
  grid.forEach((g, i) => { g.xlsxName = mapped[i]; });

  const books = [];
  const inData = [];
  const longCells = [];
  let rowsTotal = 0;
  let group = [];
  let groupCells = 0;
  const flush = () => {
    if (group.length) books.push(...packWorkbooks(group, cap, createdAt));
    group = []; groupCells = 0;
  };
  const stream = async (name, rows, from) => {
    for (let i = 0; i < rows.length; i += 1) await writer.line({ type: 'srow', tab: name, n: from + i, r: rows[i] });
  };

  for (const batch of batchesByGrid(grid.filter((g) => g.rows <= BIG_TAB_ROWS), BATCH_GRID_CELLS)) {
    const values = await sheets.readRangesRaw(batch.map((g) => sheets.tabRange(g.name)));
    for (let i = 0; i < batch.length; i += 1) {
      const g = batch[i];
      const rows = values[i] || [];
      const cells = rows.reduce((sum, r) => sum + (Array.isArray(r) ? r.length : 0), 0);
      rowsTotal += rows.length;
      if (cells > cellsPerFile) {
        // too large for one workbook file: streamed, never built in memory
        await writer.line({ type: 'sheet', tab: g.name, rows: rows.length });
        await stream(g.name, rows, 1);
        inData.push(g.name);
        continue;
      }
      const p = prepareTab(g.name, rows, longCells);
      if (group.length && groupCells + cells > cellsPerFile) flush();
      group.push({ name: g.name, xlsxName: g.xlsxName, rows: p.rows, cut: p.cut });
      groupCells += cells;
    }
  }
  flush();

  for (const g of grid.filter((x) => x.rows > BIG_TAB_ROWS)) {
    await writer.line({ type: 'sheet', tab: g.name });
    let last = 0;
    for (let from = 1; from <= g.rows; from += WINDOW_ROWS) {
      const [rows] = await sheets.readRangesRaw([sheets.tabRange(g.name, from, Math.min(g.rows, from + WINDOW_ROWS - 1))]);
      if (rows && rows.length) { await stream(g.name, rows, from); last = from + rows.length - 1; }
    }
    rowsTotal += last;
    inData.push(g.name);
  }

  // An empty read is a FAILED read. Sending it as "the backup" would look
  // like a good file on the day it is needed.
  if (!rowsTotal) throw new Error('the workbook read back empty');
  return { books, inData, longCells, tabs: grid.length, rows: rowsTotal };
}

/* ── the data file ─────────────────────────────────────────────────── */

/** NDJSON through gzip, held as compressed chunks (never the raw text). */
function gzipWriter() {
  const gz = zlib.createGzip({ level: 6 });
  const chunks = [];
  gz.on('data', (c) => chunks.push(c));
  const ended = new Promise((resolve, reject) => { gz.on('end', resolve); gz.on('error', reject); });
  let lines = 0;
  return {
    async line(obj) {
      lines += 1;
      if (!gz.write(`${JSON.stringify(obj)}\n`)) await once(gz, 'drain');
    },
    async finish() { gz.end(); await ended; return Buffer.concat(chunks); },
    get lines() { return lines; },
  };
}

/** Dump one table through `q`. Returns the row count. */
async function dumpTable(q, writer, name) {
  const cols = (await q(
    "SELECT column_name AS name, data_type AS type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    [name])).rows;
  const pks = (await q(
    'SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary',
    [`public.${name}`])).rows;
  const pk = pks.length === 1 && SAFE_NAME.test(pks[0].name) && KEYSET_TYPE.test(pks[0].type) ? pks[0] : null;
  await writer.line({ type: 'table', name, columns: cols, pk: pk ? pk.name : null });
  let rows = 0;
  if (!pk) {
    // no single simple key: a small table, read in one go
    for (const r of (await q(`SELECT to_jsonb(t) AS r FROM "${name}" t`)).rows) {
      await writer.line({ type: 'row', t: name, r: r.r });
      rows += 1;
    }
    return rows;
  }
  // keyset pages: memory stays at one page however long the table is
  let last = null;
  for (;;) {
    const res = last == null
      ? await q(`SELECT to_jsonb(t) AS r, t."${pk.name}"::text AS k FROM "${name}" t ORDER BY t."${pk.name}" LIMIT ${PAGE}`)
      : await q(`SELECT to_jsonb(t) AS r, t."${pk.name}"::text AS k FROM "${name}" t WHERE t."${pk.name}" > $1::${pk.type} ORDER BY t."${pk.name}" LIMIT ${PAGE}`, [last]);
    for (const r of res.rows) {
      await writer.line({ type: 'row', t: name, r: r.r });
      rows += 1;
    }
    if (res.rows.length < PAGE) break;
    last = res.rows[res.rows.length - 1].k;
  }
  return rows;
}

/**
 * Every business table, in ONE read-only snapshot (repeatable read), so a
 * payment and its event row are never caught on two sides of a write.
 * @returns {Promise<{tables: Array<{name, rows}>, excluded: Array<{name, why}>}>}
 */
async function dumpDatabase(writer) {
  return pool.withTransaction(async (client) => {
    const q = (text, params = []) => client.query(text, params);
    await q('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    const names = (await q(
      "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname")).rows.map((r) => r.name);
    const tables = [];
    const excluded = [];
    for (const name of names) {
      if (EXCLUDED_TABLES[name]) { excluded.push({ name, why: EXCLUDED_TABLES[name] }); continue; }
      if (!SAFE_NAME.test(name)) { excluded.push({ name, why: 'a table name this job does not read' }); continue; }
      tables.push({ name, rows: await dumpTable(q, writer, name) });
    }
    return { tables, excluded };
  });
}

/* ── one backup ────────────────────────────────────────────────────── */

/**
 * Build the files of one backup. Nothing is sent here.
 * @returns {Promise<{day, createdAt, files: Array, summary: object, warnings: string[]}>}
 */
async function build({ now = new Date(), cap = CAP_BYTES, cellsPerFile = config.offsiteBackup.cellsPerFile } = {}) {
  const { day } = lagosNow(now);
  const createdAt = now.toISOString();
  const title = `💾 Backup · ${fmtDate(day)}`;
  const warnings = [];

  // The data file is opened first: an oversized tab streams straight into it.
  const writer = gzipWriter();
  await writer.line({ type: 'header', format: FORMAT, created_at: createdAt, day });

  const book = await readWorkbook(writer, { cap, cellsPerFile, createdAt });
  const parts = book.books;
  const files = parts.map((p, i) => {
    const many = parts.length > 1;
    const lines = [
      `${title} · workbook${many ? ` · part ${i + 1} of ${parts.length}` : ''}`,
      `${n(p.tabs.length)} tabs · ${n(p.tabs.reduce((s, t) => s + t.rows.length, 0))} rows · ${size(p.buffer.length)}`,
    ];
    if (p.tooBig) {
      const w = `The tab ${p.tabs[0].name} is over Telegram's 50 MB limit and may not arrive.`;
      warnings.push(w); lines.push(`⚠️ ${w}`);
    }
    return {
      kind: 'workbook', buffer: p.buffer, caption: lines.join('\n'),
      filename: `afp-backup-${day}-workbook${many ? `-part${i + 1}of${parts.length}` : ''}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    };
  });
  if (files.length && book.longCells.length) {
    files[0].caption += `\n⚠️ ${n(book.longCells.length)} long cell(s) are cut in this file. Their full text is in the data file.`;
  }
  if (files.length && book.inData.length) {
    files[0].caption += `\nToo large for a workbook file, kept whole in the data file: ${book.inData.join(', ')}`.slice(0, 300);
  }

  const summary = {
    day,
    workbook: {
      files: parts.length, tabs: book.tabs, rows: book.rows, bytes: parts.reduce((s, p) => s + p.buffer.length, 0),
      cut: book.longCells.length, inData: book.inData,
    },
    data: null,
  };

  // The rest of the data file: the cells the .xlsx had to cut, then the database.
  const hasDb = pool.isEnabled();
  for (const c of book.longCells) await writer.line({ type: 'cell', ...c });
  let db = { tables: [], excluded: [] };
  let dbError = '';
  if (hasDb) {
    try { db = await dumpDatabase(writer); } catch (e) {
      // The workbook is the main record: it still goes out, and the gap is
      // said on the file itself.
      dbError = e.message;
      logger.error(`offsiteBackup: database dump failed: ${e.message}`);
    }
  }
  if (hasDb || book.longCells.length || book.inData.length) {
    await writer.line({
      type: 'footer', tables: db.tables, excluded: db.excluded, long_cells: book.longCells.length,
      sheets: book.inData, database_error: dbError || undefined,
    });
    const buffer = await writer.finish();
    const dbRows = db.tables.reduce((s, t) => s + t.rows, 0);
    const lines = [`${title} · data`];
    if (hasDb && !dbError) lines.push(`${n(db.tables.length)} database tables · ${n(dbRows)} rows · ${size(buffer.length)}`);
    if (book.inData.length) lines.push(`${n(book.inData.length)} large workbook tab(s), whole: ${book.inData.join(', ')}`.slice(0, 300));
    if (book.longCells.length) lines.push(`${n(book.longCells.length)} long cell(s) from the workbook, in full`);
    if (dbError) {
      const w = `The database could not be read: ${dbError}`;
      warnings.push(w); lines.push(`⚠️ ${w}`);
    }
    if (buffer.length > cap) {
      const w = "The data file is over Telegram's 50 MB limit and may not arrive.";
      warnings.push(w); lines.push(`⚠️ ${w}`);
    }
    lines.push(files.length ? 'Keep it with the workbook file of the same date.' : 'This is the whole backup of that date.');
    files.push({
      kind: 'data', buffer, caption: lines.join('\n'),
      filename: `afp-backup-${day}-data.ndjson.gz`, contentType: 'application/gzip',
    });
    summary.data = { tables: db.tables.length, rows: dbRows, bytes: buffer.length, sheets: book.inData.length, error: dbError || undefined };
  } else {
    await writer.finish(); // nothing but the header: no data file is sent
  }
  return { day, createdAt, files, summary, warnings };
}

/** BKP-3 — the admins the two-admin rule counts: the Railway ADMIN_IDS list, nothing else. */
function envAdmins() {
  return [...new Set((config.access.adminIds || []).map((x) => String(x).trim()).filter(Boolean))];
}

/**
 * BKP-3 — who receives the DAILY backup.
 *
 * Every admin, unless Settings OFFSITE_BACKUP_IDS names two or more of them:
 * the cell may only NARROW the list among the admins. An id in the cell that
 * is not an admin (an employee, a group, a channel) receives nothing and is
 * reported. A cell that names fewer than two admins is not honoured — every
 * admin receives the backup instead, so it still goes out and never to one
 * person. With fewer than two admins in all, nothing is sent.
 *
 * @returns {{ids: string[], ignored: string[], widened: boolean, blocked: string}}
 */
function dailyRecipients(settings) {
  const admins = envAdmins();
  const own = [...new Set(String((settings && settings.OFFSITE_BACKUP_IDS) || '')
    .split(/[,;\s]+/).map((x) => x.trim()).filter((x) => /^-?\d+$/.test(x)))];
  const named = own.filter((id) => admins.includes(id));
  const ignored = own.filter((id) => !admins.includes(id));
  const widened = own.length > 0 && named.length < MIN_ADMINS;
  const ids = named.length >= MIN_ADMINS ? named : admins;
  if (ids.length < MIN_ADMINS) {
    return {
      ids: [], ignored, widened,
      blocked: `a backup goes to at least ${MIN_ADMINS} admins and only ${admins.length} ${admins.length === 1 ? 'is' : 'are'} set up (Railway ADMIN_IDS)`,
    };
  }
  return { ids, ignored, widened, blocked: '' };
}

/** The daily recipients' ids (empty when the two-admin rule blocks the run). */
function recipients(settings) {
  return dailyRecipients(settings).ids;
}

/**
 * BKP-3 — the two admins behind a backup ON DEMAND: who asked and who
 * approved. Two DIFFERENT ids, both in ADMIN_IDS — the approval queue's own
 * self-approval guard lets a sole admin approve their own request, and a
 * backup never goes to one admin alone. Pure.
 * @param {{requestedBy?: string, approvedBy?: string}} release
 * @returns {{ok: boolean, ids?: string[], message?: string}}
 */
function releasePair(release) {
  const admins = envAdmins();
  const a = String((release && release.requestedBy) || '').trim();
  const b = String((release && release.approvedBy) || '').trim();
  if (!a || !b) return { ok: false, message: 'A backup on demand needs the admin who asked and the admin who approved.' };
  if (a === b) return { ok: false, message: 'A backup needs two different admins: the one who asked cannot be the one who approves.' };
  if (!admins.includes(a) || !admins.includes(b)) {
    return { ok: false, message: 'A backup is released only between two admins set in the bot\'s own configuration (Railway ADMIN_IDS).' };
  }
  return { ok: true, ids: [a, b] };
}

/**
 * BKP-3 — the approved request behind a backup ON DEMAND. A run on demand
 * is only ever the execution of ONE approved `release_backup` request that
 * the admin named as its asker raised; each request releases once. A
 * request that cannot be read releases nothing.
 * @returns {Promise<{ok: boolean, message?: string}>}
 */
async function approvedRelease(release) {
  const id = String((release && release.requestId) || '').trim();
  if (!id) return { ok: false, message: 'A backup on demand is released only by its approved request.' };
  if (_released.has(id)) return { ok: false, message: 'That request has already released its backup. Ask again for a new one.' };
  let row;
  try { row = await require('../repositories/approvalQueueRepository').getByRequestId(id); } catch (e) {
    return { ok: false, message: `the backup request could not be read (${e.message})` };
  }
  const aj = (row && row.actionJSON) || {};
  if (!row || aj.action !== 'release_backup') return { ok: false, message: 'No backup request with that reference exists.' };
  if (String(row.status || '').trim().toLowerCase() !== 'approved') return { ok: false, message: 'That backup request has not been approved.' };
  if (String(row.user) !== String(release.requestedBy)) return { ok: false, message: 'That backup request was raised by a different admin.' };
  return { ok: true };
}

/**
 * BKP-3 — which of these chats the bot can reach right now, asked BEFORE
 * anything is built: a backup that could land with only one of its two
 * admins is not sent at all. A bot without the call (a test double) is
 * taken as able to reach everyone.
 */
async function reachable(bot, ids) {
  if (!bot || typeof bot.sendChatAction !== 'function') return { yes: [...ids], no: [] };
  const yes = [];
  const no = [];
  for (const id of ids) {
    try { await bot.sendChatAction(id, 'upload_document'); yes.push(id); } catch (_) { no.push(id); }
  }
  return { yes, no };
}

/**
 * Send each file to each chat. The bytes go up ONCE: the first delivery's
 * Telegram file id is reused for everyone after it.
 */
async function deliver(bot, files, ids, { silent = false } = {}) {
  const sent = [];
  const failed = [];
  for (const f of files) {
    let fileId = null;
    for (const id of ids) {
      try {
        const opts = { caption: f.caption, disable_notification: silent };
        const msg = fileId
          ? await bot.sendDocument(id, fileId, opts)
          : await bot.sendDocument(id, f.buffer, opts, { filename: f.filename, contentType: f.contentType });
        if (!fileId && msg && msg.document && msg.document.file_id) fileId = msg.document.file_id;
        sent.push({ id: String(id), file: f.filename });
      } catch (e) {
        failed.push({ id: String(id), file: f.filename, error: e.message });
        logger.warn(`offsiteBackup: ${f.filename} to ${id} failed: ${e.message}`);
      }
    }
  }
  return { sent, failed };
}

/**
 * Build and send one backup. Never throws.
 *
 * BKP-3 — THE gate. Whoever calls, the files leave only under the
 * two-admin rule: the daily run to two or more admins, a run on demand to
 * the two different admins who asked and approved. There is no parameter
 * that names a chat.
 *
 * @param {object} bot
 * @param {{now?: Date, kind?: 'ok'|'manual', release?: {requestId?: string, requestedBy: string, approvedBy: string}}} [o]
 *   `kind: 'manual'` = on demand, and `release` is then required
 */
async function run(bot, { now = new Date(), kind = 'ok', release = null } = {}) {
  if (_running) return { ok: false, busy: true, message: 'a backup is already being built' };
  _running = true;
  try {
    const settings = (await settingsRepository.getAll().catch(() => null)) || {};
    let ids;
    if (kind === 'manual') {
      const pair = releasePair(release);
      if (!pair.ok) return { ok: false, refused: true, message: pair.message };
      const req = await approvedRelease(release);
      if (!req.ok) return { ok: false, refused: true, message: req.message };
      ids = pair.ids;
    } else {
      const daily = dailyRecipients(settings);
      if (daily.blocked) return { ok: false, blocked: true, message: daily.blocked };
      ids = daily.ids;
    }
    // Nothing is built for a delivery that could end with one admin alone.
    const reach = await reachable(bot, ids);
    if (kind === 'manual' ? reach.no.length > 0 : reach.yes.length < MIN_ADMINS) {
      return {
        ok: false, unreachable: reach.no,
        message: `the bot cannot reach ${reach.no.length} of the ${ids.length} admins (each must have opened the bot): nothing was sent, because a backup never goes to one admin alone`,
      };
    }
    ids = reach.yes;
    const built = await build({ now });
    const d = await deliver(bot, built.files, ids, { silent: kind === 'ok' });
    const missing = built.files.filter((f) => !d.sent.some((x) => x.file === f.filename));
    if (missing.length) {
      const why = (d.failed.find((x) => x.file === missing[0].filename) || {}).error || 'unknown error';
      throw new Error(`${missing.map((f) => f.filename).join(', ')} reached nobody: ${why}`);
    }
    // Who holds a file now. One holder means a send failed after the check
    // above: it cannot be taken back, so it is recorded and every admin is told.
    const holders = [...new Set(d.sent.map((x) => x.id))];
    const detail = {
      ...built.summary, recipients: ids.length, undelivered: d.failed.length, warnings: built.warnings,
      holders,
      ...(kind === 'manual' ? { release: { requestId: String((release && release.requestId) || ''), requestedBy: ids[0], approvedBy: ids[1] } } : {}),
    };
    try { await jobRuns.record(JOB, built.day, kind, detail); } catch (e) {
      logger.warn(`offsiteBackup: the run record could not be saved: ${e.message}`);
    }
    _last = { at: now.toISOString(), kind, ...detail };
    if (kind === 'manual') _released.add(String(release.requestId));
    logger.info(`offsiteBackup: ${kind} backup of ${built.day} sent to ${holders.length} admin(s) — ${built.summary.workbook.tabs} tabs, ${built.summary.workbook.rows} rows`);
    if (holders.length < MIN_ADMINS) await notifyAlone(bot, holders);
    return { ok: true, ...detail, alone: holders.length < MIN_ADMINS };
  } catch (e) {
    logger.error(`offsiteBackup: backup failed: ${e.message}`);
    return { ok: false, message: e.message };
  } finally {
    _running = false;
  }
}

/** BKP-3 — a delivery that ended with one holder is said to every admin. */
async function notifyAlone(bot, holders) {
  logger.error(`offsiteBackup: a backup reached only ${holders.join(', ') || 'nobody'} — the two-admin rule was not met at delivery`);
  for (const id of envAdmins()) {
    try {
      await bot.sendMessage(id,
        `⚠️ Backup: the files reached only one admin (id ${holders[0] || '?'}).\n`
        + 'A send to the other admin failed after the check. A backup is meant to reach two admins: '
        + 'please check with each other now.');
    } catch (_) { /* best-effort */ }
  }
}

async function notifyFailure(bot, message) {
  for (const id of config.access.adminIds || []) {
    try {
      await bot.sendMessage(id,
        `⚠️ Backup failed\n${message}\n\nThe bot tries again in an hour, three times a day. `
        + 'Open 📊 Reporting → 💾 Backup to ask for one (a second admin approves it).');
    } catch (_) { /* best-effort */ }
  }
}

/** BKP-3 — the daily backup cannot go out under the two-admin rule: said once a day. */
async function notifyBlocked(bot, message) {
  for (const id of envAdmins()) {
    try {
      await bot.sendMessage(id,
        `🔐 The daily backup was NOT sent\n${message}.\n\nA backup never goes to one admin alone. `
        + 'Add a second admin to the bot, and it runs again from the next day.');
    } catch (_) { /* best-effort */ }
  }
}

/**
 * One scheduler tick: the first tick at or after the hour sends the day's
 * backup, once. Returns a word for the tests and the log.
 */
async function tick(bot, now = new Date()) {
  const settings = await settingsRepository.getAll().catch(() => null);
  if (!settings) return 'settings_unreadable';
  if (!Number(settings.OFFSITE_BACKUP_ENABLED)) return 'disabled';
  const want = Number(settings.OFFSITE_BACKUP_HOUR);
  const hour = Number.isFinite(want) && want >= 0 && want <= 23 ? want : settingsRepository.DEFAULTS.OFFSITE_BACKUP_HOUR;
  const at = lagosNow(now);
  if (at.hour < hour) return 'early';
  if (_doneDay === at.day) return 'done';
  if (_failDay === at.day && (_tries >= MAX_TRIES || now.getTime() < _nextTryAt)) return 'waiting';
  let already = false;
  // An unreadable record counts as "not sent": a second copy on a bad day
  // is the cheaper mistake.
  try { already = await jobRuns.hasOk(JOB, at.day); } catch (e) {
    logger.warn(`offsiteBackup: the run record could not be read: ${e.message}`);
  }
  if (already) { _doneDay = at.day; return 'done'; }

  const res = await run(bot, { now, kind: 'ok' });
  if (res.ok) { _doneDay = at.day; _failDay = ''; _tries = 0; return 'ran'; }
  if (res.busy) return 'busy';
  // BKP-3 — fewer than two admins: not a failure to retry, a rule. Said once a day.
  if (res.blocked) {
    if (_blockedDay !== at.day) { _blockedDay = at.day; await notifyBlocked(bot, res.message); }
    return 'blocked';
  }
  if (_failDay !== at.day) { _failDay = at.day; _tries = 0; }
  _tries += 1;
  _nextTryAt = now.getTime() + RETRY_MS;
  if (_tries === 1) await notifyFailure(bot, res.message);
  return 'failed';
}

/** What the 💾 tile shows. Never throws. */
async function status() {
  const settings = (await settingsRepository.getAll().catch(() => null)) || {};
  let last = _last;
  try {
    const row = await jobRuns.latest(JOB);
    if (row) {
      const at = row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || '');
      last = { at, kind: row.status, ...(row.detail || {}) };
    }
  } catch (e) { logger.warn(`offsiteBackup: status read failed: ${e.message}`); }
  const want = Number(settings.OFFSITE_BACKUP_HOUR);
  const daily = dailyRecipients(settings);
  return {
    enabled: Boolean(Number(settings.OFFSITE_BACKUP_ENABLED)),
    hour: Number.isFinite(want) && want >= 0 && want <= 23 ? want : settingsRepository.DEFAULTS.OFFSITE_BACKUP_HOUR,
    recipients: daily.ids,
    // BKP-3 — what the two-admin rule did with the Settings cell
    ignored: daily.ignored, widened: daily.widened, blocked: daily.blocked, admins: envAdmins().length,
    ownList: Boolean(String(settings.OFFSITE_BACKUP_IDS || '').trim()),
    database: pool.isEnabled(),
    last,
  };
}

function start(bot) {
  if (_timer) return;
  const safe = () => { tick(bot).catch((e) => logger.warn(`offsiteBackup: tick failed: ${e.message}`)); };
  _timer = setInterval(safe, TICK_MS);
  if (_timer.unref) _timer.unref();
  // Two minutes after boot: a bot that was down at the hour catches up, and
  // the boot itself is not slowed by a workbook read.
  const first = setTimeout(safe, 2 * 60 * 1000);
  if (first.unref) first.unref();
  logger.info('offsiteBackup: daily scheduler armed (10-minute catch-up tick)');
}

function _resetForTests() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _running = false; _doneDay = ''; _failDay = ''; _tries = 0; _nextTryAt = 0; _last = null; _blockedDay = '';
  _released.clear();
}

module.exports = {
  JOB, FORMAT, MIN_ADMINS, start, tick, run, build, status, recipients, dailyRecipients, releasePair, envAdmins, size,
  _internals: {
    xlsxNames, prepareTab, buildWorkbookBuffer, packWorkbooks, batchesByGrid, readWorkbook, gzipWriter, dumpTable, dumpDatabase,
    deliver, lagosNow, EXCLUDED_TABLES, CAP_BYTES, CELL_MAX, INDEX_SHEET, MAX_TRIES, RETRY_MS, PAGE,
    BIG_TAB_ROWS, WINDOW_ROWS, BATCH_GRID_CELLS, reachable, approvedRelease, _resetForTests,
  },
};
