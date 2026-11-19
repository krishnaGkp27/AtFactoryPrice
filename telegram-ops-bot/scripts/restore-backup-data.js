'use strict';

/**
 * BKP-2 — put a backup's DATA file back (specs/BKP-2_OFFSITE_BACKUP.md §6).
 *
 * The data file (`afp-backup-<day>-data.ndjson.gz`) carries the Postgres
 * tables, the full text of the workbook cells an .xlsx had to cut, and any
 * workbook tab too large for a workbook file (kept whole, row by row).
 *
 *   node scripts/restore-backup-data.js <file>                 # LIST: what the file holds. Reads nothing else.
 *   node scripts/restore-backup-data.js <file> --tables        # dry run: what would be inserted
 *   node scripts/restore-backup-data.js <file> --tables --commit
 *   node scripts/restore-backup-data.js <file> --tables --only payment_events,transfers --commit
 *   node scripts/restore-backup-data.js <file> --cells         # dry run: the long cells
 *   node scripts/restore-backup-data.js <file> --cells --commit
 *   node scripts/restore-backup-data.js <file> --sheets        # dry run: the large tabs
 *   node scripts/restore-backup-data.js <file> --sheets --commit
 *
 * --tables needs DATABASE_URL (the database to fill; its tables must exist —
 * boot the bot once, or run the migrations). Rows are inserted with ON
 * CONFLICT DO NOTHING: a row already there is left exactly as it is, so the
 * script can be run twice. Serial counters are moved past the restored ids.
 * --cells and --sheets need the Sheets credentials and GOOGLE_SHEET_ID of
 * the workbook the .xlsx was imported into. --cells rewrites only the cut
 * cells. --sheets writes each large tab back at its own row numbers (the
 * tab is created when missing), so it too can be run twice.
 *
 * Dry run by default — only --commit writes.
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const readline = require('readline');

const SAFE_NAME = /^[a-z_][a-z0-9_]*$/;

/** @param {string[]} argv */
function parseArgs(argv) {
  const a = { file: '', tables: false, cells: false, sheets: false, commit: false, only: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const v = rest[i];
    if (v === '--tables') a.tables = true;
    else if (v === '--cells') a.cells = true;
    else if (v === '--sheets') a.sheets = true;
    else if (v === '--commit') a.commit = true;
    else if (v === '--only') { a.only = new Set(String(rest[i + 1] || '').split(',').map((s) => s.trim()).filter(Boolean)); i += 1; }
    else if (!v.startsWith('--') && !a.file) a.file = v;
  }
  return a;
}

/** Read the file line by line; `onLine(obj)` may be async. Returns the line count. */
async function readLines(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    count += 1;
    await onLine(JSON.parse(line));
  }
  return count;
}

/** What the file holds, without touching anything. */
async function summarise(file) {
  const out = { header: null, footer: null, tables: new Map(), cells: [], sheets: new Map() };
  await readLines(file, (o) => {
    if (o.type === 'header') out.header = o;
    else if (o.type === 'footer') out.footer = o;
    else if (o.type === 'table') out.tables.set(o.name, { columns: o.columns || [], rows: 0 });
    else if (o.type === 'row') { const t = out.tables.get(o.t); if (t) t.rows += 1; }
    else if (o.type === 'cell') out.cells.push({ tab: o.tab, row: o.row, col: o.col, length: String(o.text || '').length });
    else if (o.type === 'sheet') { if (!out.sheets.has(o.tab)) out.sheets.set(o.tab, 0); }
    else if (o.type === 'srow') out.sheets.set(o.tab, (out.sheets.get(o.tab) || 0) + 1);
  });
  return out;
}

/** 1 → A, 27 → AA. */
function colLetter(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

async function restoreTables(file, { commit, only, query }) {
  const done = new Map();
  let current = '';
  await readLines(file, async (o) => {
    if (o.type === 'table') { current = o.name; return; }
    if (o.type !== 'row') return;
    const name = o.t || current;
    if (!SAFE_NAME.test(name) || (only && !only.has(name))) return;
    const c = done.get(name) || { seen: 0, inserted: 0 };
    c.seen += 1;
    if (commit) {
      const res = await query(
        `INSERT INTO "${name}" SELECT * FROM jsonb_populate_record(NULL::"${name}", $1::jsonb) ON CONFLICT DO NOTHING`,
        [JSON.stringify(o.r)]);
      c.inserted += (res && res.rowCount) || 0;
    }
    done.set(name, c);
  });
  if (commit) {
    // move every serial counter past the ids just restored
    for (const name of done.keys()) {
      const cols = await query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_default LIKE 'nextval(%'", [name]);
      for (const { column_name: col } of (cols && cols.rows) || []) {
        if (!SAFE_NAME.test(col)) continue;
        await query(`SELECT setval(pg_get_serial_sequence('public.${name}', '${col}'), GREATEST((SELECT COALESCE(MAX("${col}"), 0) FROM "${name}"), 1))`);
      }
    }
  }
  return done;
}

/**
 * Write the large tabs back, each row at its own row number, in runs of up
 * to `chunk` consecutive rows per write.
 * @returns {Promise<Map<string, number>>} rows per tab
 */
async function restoreSheets(file, { commit, sheets, chunk = 500 }) {
  const done = new Map();
  const existing = commit ? new Set(await sheets.getSheetNames()) : new Set();
  let run = null; // { tab, from, rows }
  const flush = async () => {
    if (!run || !run.rows.length) { run = null; return; }
    if (commit) {
      if (!existing.has(run.tab)) { await sheets.addSheet(run.tab); existing.add(run.tab); }
      await sheets.updateRange(run.tab, `A${run.from}`, run.rows);
    }
    run = null;
  };
  await readLines(file, async (o) => {
    if (o.type !== 'srow') return;
    done.set(o.tab, (done.get(o.tab) || 0) + 1);
    const next = run && run.tab === o.tab && o.n === run.from + run.rows.length && run.rows.length < chunk;
    if (!next) { await flush(); run = { tab: o.tab, from: o.n, rows: [] }; }
    run.rows.push(Array.isArray(o.r) ? o.r : []);
  });
  await flush();
  return done;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.file || !fs.existsSync(args.file)) {
    console.error('Usage: node scripts/restore-backup-data.js <afp-backup-…-data.ndjson.gz> [--tables|--cells] [--only a,b] [--commit]');
    process.exit(1);
  }
  const sum = await summarise(args.file);
  if (!sum.header || !String(sum.header.format || '').startsWith('afp-backup-data/')) {
    console.error('This is not a backup data file (no afp-backup-data header).');
    process.exit(1);
  }
  console.log(`Backup data file of ${sum.header.day} (made ${sum.header.created_at})`);
  console.log(`Tables: ${sum.tables.size}`);
  for (const [name, t] of sum.tables) console.log(`  ${name.padEnd(28)} ${String(t.rows).padStart(8)} rows`);
  console.log(`Long workbook cells: ${sum.cells.length}`);
  for (const c of sum.cells) console.log(`  ${c.tab}!${colLetter(c.col)}${c.row}  ${c.length} characters`);
  console.log(`Large workbook tabs kept whole: ${sum.sheets.size}`);
  for (const [tab, rows] of sum.sheets) console.log(`  ${tab.padEnd(28)} ${String(rows).padStart(8)} rows`);
  if (sum.footer && sum.footer.database_error) console.log(`WARNING: the database could not be read when this file was made: ${sum.footer.database_error}`);
  if (!sum.footer) console.log('WARNING: the file has no footer — it may be cut short.');
  if (!args.tables && !args.cells && !args.sheets) return;

  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

  if (args.tables) {
    const pool = require('../src/db/postgresPool');
    if (!pool.isEnabled()) { console.error('DATABASE_URL is not set.'); process.exit(1); }
    const done = await restoreTables(args.file, { commit: args.commit, only: args.only, query: (t, p) => pool.query(t, p) });
    console.log(args.commit ? '\nInserted (rows already present were left alone):' : '\nDRY RUN — would insert up to:');
    for (const [name, c] of done) console.log(`  ${name.padEnd(28)} ${args.commit ? `${c.inserted} of ${c.seen}` : c.seen}`);
    if (!args.commit) console.log('\nNothing was written. Add --commit to write.');
  }

  if (args.cells) {
    const sheets = require('../src/repositories/sheetsClient');
    let written = 0;
    await readLines(args.file, async (o) => {
      if (o.type !== 'cell') return;
      const ref = `${colLetter(o.col)}${o.row}`;
      if (!args.commit) { console.log(`would write ${o.tab}!${ref} (${String(o.text).length} characters)`); return; }
      await sheets.updateRange(o.tab, `${ref}:${ref}`, [[o.text]]);
      written += 1;
    });
    console.log(args.commit ? `\nWrote ${written} cell(s).` : '\nNothing was written. Add --commit to write.');
  }

  if (args.sheets) {
    const sheets = require('../src/repositories/sheetsClient');
    const done = await restoreSheets(args.file, { commit: args.commit, sheets });
    console.log(args.commit ? '\nWrote:' : '\nDRY RUN — would write:');
    for (const [tab, rows] of done) console.log(`  ${tab.padEnd(28)} ${rows} rows`);
    if (!args.commit) console.log('\nNothing was written. Add --commit to write.');
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { parseArgs, readLines, summarise, restoreTables, restoreSheets, colLetter };
