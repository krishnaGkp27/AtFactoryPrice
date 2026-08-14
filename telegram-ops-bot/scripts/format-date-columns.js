/**
 * SDN-2 — set a consistent DISPLAY format on the Inventory date columns.
 *
 * The owner's screenshot: column M (SoldDate) showed `28-February-2026` on
 * some rows and `2026-08-06` on others. Both cells hold a real date; they
 * only LOOK different because each carries its own number format. This
 * script gives the whole column one format, so every row — past and future
 * — reads the same on screen.
 *
 * It changes FORMATTING ONLY. No cell value is written, so no record is
 * altered and nothing here can lose data.
 *
 *   K  DateReceived    ─┐  both, because a mixed pair is the same trap
 *   M  SoldDate        ─┘  and the bot now normalises both on read (SDN-2)
 *
 * ORDER MATTERS. Run this only AFTER the SDN-2 read-side normalisation is
 * deployed. The bot reads cells as DISPLAYED text, so re-formatting a
 * column changes what every reader parses; the normaliser is what makes
 * that safe. Before it, formatting the column would have hidden the
 * February rows from date-windowed reports rather than fixing them.
 *
 * SAFETY: dry-run by default — it only writes when you pass --commit.
 *
 * Usage:
 *   node scripts/format-date-columns.js                    # dry-run, shows the plan
 *   node scripts/format-date-columns.js --commit           # applies the format
 *   node scripts/format-date-columns.js --pattern dd-mmm-yyyy --commit
 *   node scripts/format-date-columns.js --sheet Inventory --columns K,M --commit
 *
 * Requires the same .env (Google Sheets credentials) as the bot.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sheetsClient = require('../src/repositories/sheetsClient');

// The owner's chosen look: 28-February-2026.
const DEFAULT_PATTERN = 'dd-mmmm-yyyy';
const DEFAULT_SHEET = 'Inventory';
const DEFAULT_COLUMNS = ['K', 'M'];

function colIndex(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) {
    if (ch < 'A' || ch > 'Z') return -1;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1; // 0-based, as the Sheets API wants
}

function parseArgs(argv) {
  const args = {
    commit: false, pattern: DEFAULT_PATTERN, sheet: DEFAULT_SHEET, columns: [...DEFAULT_COLUMNS],
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--commit') args.commit = true;
    else if (a === '--pattern') { args.pattern = argv[i + 1] || args.pattern; i += 1; }
    else if (a.startsWith('--pattern=')) args.pattern = a.slice('--pattern='.length);
    else if (a === '--sheet') { args.sheet = argv[i + 1] || args.sheet; i += 1; }
    else if (a.startsWith('--sheet=')) args.sheet = a.slice('--sheet='.length);
    else if (a === '--columns') { args.columns = String(argv[i + 1] || '').split(','); i += 1; }
    else if (a.startsWith('--columns=')) args.columns = a.slice('--columns='.length).split(',');
  }
  args.columns = args.columns.map((c) => c.trim()).filter(Boolean);
  return args;
}

async function main() {
  const { commit, pattern, sheet, columns } = parseArgs(process.argv);

  if (!pattern.trim()) { console.error('FAIL: --pattern must be a non-empty date pattern'); process.exit(1); }
  const cols = columns.map((c) => ({ letter: c.toUpperCase(), index: colIndex(c) }));
  const bad = cols.filter((c) => c.index < 0);
  if (!cols.length || bad.length) {
    console.error(`FAIL: --columns must be sheet letters (got: ${columns.join(',') || '(none)'})`);
    process.exit(1);
  }

  console.log(`SDN-2 date-column format — sheet="${sheet}" columns=${cols.map((c) => c.letter).join(',')} `
    + `pattern="${pattern}" mode=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  const api = await sheetsClient.getSheets();
  const spreadsheetId = sheetsClient.spreadsheetId();

  // Resolve the tab's numeric id — repeatCell addresses sheets by gid.
  const meta = await api.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title,gridProperties))' });
  const tab = (meta.data.sheets || []).find((s) => s.properties.title === sheet);
  if (!tab) {
    console.error(`FAIL: no tab named "${sheet}" in this spreadsheet.`);
    process.exit(1);
  }
  const sheetId = tab.properties.sheetId;
  const rowCount = (tab.properties.gridProperties || {}).rowCount || 0;

  // Row 1 is the header TEXT — formatting it as a date would be harmless but
  // meaningless, so the range starts at row 2.
  const requests = cols.map((c) => ({
    repeatCell: {
      range: {
        sheetId, startRowIndex: 1, startColumnIndex: c.index, endColumnIndex: c.index + 1,
      },
      cell: { userEnteredFormat: { numberFormat: { type: 'DATE', pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  }));

  for (const c of cols) {
    console.log(`  ${sheet}!${c.letter}2:${c.letter} → DATE "${pattern}"  (${rowCount - 1} rows)`);
  }

  if (!commit) {
    console.log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
    console.log('Reminder: only run this once the SDN-2 read-side normalisation is deployed.');
    return;
  }

  await api.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  console.log(`\n✅ Applied "${pattern}" to ${cols.length} column(s) on ${sheet}.`);
  console.log('Cell VALUES were not touched — this changed display formatting only.');
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
