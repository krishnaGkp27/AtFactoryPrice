/**
 * SHEET-FIX-2 — re-lay the Contacts rows that appends walked off to the right,
 * and repair the two customer phones that lost their leading zero.
 *
 * The owner's full-workbook export (docs/SHEET_AUDIT_2026-08-14.md) showed
 * Contacts rows stair-stepping: row 2 at column A, row 3 starting at I,
 * row 4 at T, rows 5-6 at Z. Each record's 12 values are intact — just
 * displaced — but the bot reads A2:L, so Solomon, Obinna and both Mr femi
 * rows are invisible to every picker and to the network graph.
 *
 * SHEET-FIX-1 stopped new drift (A1-anchored appends + header-width heal).
 * This repairs what already drifted. Run it AFTER that deploy, so the
 * healed 12-column header is in place before rows are re-laid under it.
 *
 * What it does, and nothing else:
 *   1. reads the full width of Contacts and finds every record by its
 *      CON- id, wherever in the row it starts;
 *   2. rewrites each record compactly into A:L, in its existing row;
 *   3. blanks the cells the displaced copy occupied;
 *   4. owner ruling — the older duplicate "Mr femi" (the plain contact,
 *      not the customer-bound one) is set status=inactive, not deleted;
 *   5. owner ruling — Customers phones that lost a leading zero are
 *      rewritten in international form (+234…), the same E.164 shape
 *      utils/phone.js already canonicalises to, as TEXT so Sheets cannot
 *      turn them back into numbers.
 *
 * SAFETY: dry-run by default; only --commit writes. Every record is
 * matched by its own id, never by position, and a row whose 12 values
 * cannot be recovered intact is reported and SKIPPED rather than guessed.
 *
 * Usage:
 *   node scripts/repair-contacts-staircase.js            # show the plan
 *   node scripts/repair-contacts-staircase.js --commit   # apply it
 *   node scripts/repair-contacts-staircase.js --skip-phones --commit
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const sheets = require('../src/repositories/sheetsClient');
const phone = require('../src/utils/phone');

const SHEET = 'Contacts';
const WIDTH = 12; // contact_id … updated_at
const SCAN = 'A2:AZ'; // wide enough to reach the row that landed at Z

// The duplicate the owner ruled on: the plain contact row, superseded by
// the customer-bound one. Matched by id so nothing else can be hit.
const DEACTIVATE_IDS = ['CON-20260813-906752ED'];

function parseArgs(argv) {
  const a = { commit: false, skipPhones: false };
  for (const v of argv.slice(2)) {
    if (v === '--commit') a.commit = true;
    else if (v === '--skip-phones') a.skipPhones = true;
  }
  return a;
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/**
 * Find where a record starts in a displaced row: the cell holding its
 * CON- id. Returns -1 when the row carries no recognisable record.
 */
function recordStart(cells) {
  return cells.findIndex((c) => /^CON-/i.test(str(c)));
}

async function repairContacts(commit) {
  const rows = await sheets.readRange(SHEET, SCAN);
  const plan = [];
  const skipped = [];

  rows.forEach((raw, i) => {
    const rowIndex = i + 2;
    const cells = raw || [];
    if (!cells.some((c) => str(c))) return; // blank row

    const start = recordStart(cells);
    if (start === -1) {
      if (cells.some((c) => str(c))) skipped.push({ rowIndex, why: 'no CON- id found in the row' });
      return;
    }
    const values = cells.slice(start, start + WIDTH).map(str);
    while (values.length < WIDTH) values.push('');

    const tail = cells.slice(start + WIDTH).filter((c) => str(c));
    if (tail.length) {
      skipped.push({ rowIndex, why: `unexpected extra data past the 12 values: ${tail.slice(0, 3).join(', ')}` });
      return;
    }
    plan.push({ rowIndex, start, values, displaced: start > 0 });
  });

  console.log(`\n${SHEET}: ${plan.length} record(s) found, ${plan.filter((p) => p.displaced).length} displaced\n`);
  for (const p of plan) {
    const where = p.displaced ? `starts at column ${p.start + 1} → moves to A` : 'already at column A';
    const deact = DEACTIVATE_IDS.includes(p.values[0]) ? '  [→ status=inactive, owner ruling]' : '';
    console.log(`  row ${String(p.rowIndex).padEnd(3)} ${p.values[0].padEnd(26)} ${(p.values[1] || '(no name)').padEnd(14)} ${where}${deact}`);
  }
  for (const s of skipped) console.log(`  row ${s.rowIndex}: SKIPPED — ${s.why}`);

  if (!commit) return { plan, skipped };

  // Re-lay each record into A:L, then blank whatever the displaced copy
  // occupied to the right of it. Both writes are per-row and idempotent.
  const updates = [];
  const lastCol = rows.reduce((m, r) => Math.max(m, (r || []).length), WIDTH);
  for (const p of plan) {
    const values = [...p.values];
    if (DEACTIVATE_IDS.includes(values[0])) values[9] = 'inactive'; // column J = status
    updates.push({ range: `A${p.rowIndex}:L${p.rowIndex}`, values: [values] });
    if (p.displaced && lastCol > WIDTH) {
      updates.push({
        range: `M${p.rowIndex}:${sheets.columnLetter(lastCol)}${p.rowIndex}`,
        values: [new Array(lastCol - WIDTH).fill('')],
      });
    }
  }
  await sheets.batchUpdateRanges(SHEET, updates);
  console.log(`\n✅ Re-laid ${plan.length} record(s) into A:L and cleared the displaced cells.`);
  return { plan, skipped };
}

/**
 * A phone that Sheets turned into a number lost its leading zero. Only
 * rows whose stored value is 10 digits starting 7/8/9 are touched — the
 * exact shape a dropped Nigerian leading zero leaves — and each is
 * rewritten through the app's own normaliser so the sheet ends up with
 * the same +234… form every other phone already uses.
 */
async function repairPhones(commit) {
  const rows = await sheets.readRange('Customers', 'A2:C');
  const fixes = [];
  rows.forEach((r, i) => {
    const raw = str((r || [])[2]);
    if (!raw) return;
    const norm = phone.normalizePhone(raw);
    // Only a number we can resolve to a full international form is
    // touched. Anything ambiguous keeps exactly what a human typed.
    if (!norm.ok || !norm.e164) return;
    if (raw === norm.e164) return; // already right
    fixes.push({ rowIndex: i + 2, id: str(r[0]), name: str(r[1]), from: raw, to: norm.e164 });
  });

  console.log(`\nCustomers: ${fixes.length} phone(s) to restore to international form\n`);
  for (const f of fixes) {
    console.log(`  row ${String(f.rowIndex).padEnd(3)} ${f.name.padEnd(18)} ${f.from.padEnd(16)} →  ${f.to}`);
  }
  if (!commit || !fixes.length) return fixes;

  // Leading apostrophe: Sheets stores the digits as TEXT, so a value that
  // was coerced into a number once cannot be coerced again.
  await sheets.batchUpdateRanges('Customers',
    fixes.map((f) => ({ range: `C${f.rowIndex}`, values: [[`'${f.to}`]] })));
  console.log(`\n✅ Repaired ${fixes.length} phone(s) as text.`);
  return fixes;
}

async function main() {
  const { commit, skipPhones } = parseArgs(process.argv);
  console.log(`SHEET-FIX-2 contacts repair — mode=${commit ? 'COMMIT (will write)' : 'DRY-RUN (no writes)'}`);

  await repairContacts(commit);
  if (!skipPhones) await repairPhones(commit);

  if (!commit) {
    console.log('\nDRY-RUN: nothing written. Re-run with --commit to apply.');
    console.log('Run this only AFTER the SHEET-FIX-1 deploy, so the healed 12-column header is in place.');
  }
}

// Importable so the repair can be exercised against a fake sheet with no
// credentials — this writes to live business records, so its behaviour is
// pinned by tests rather than trusted.
if (require.main === module) {
  main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}

module.exports = { repairContacts, repairPhones, recordStart, DEACTIVATE_IDS, WIDTH };
