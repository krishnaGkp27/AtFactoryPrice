/**
 * Data access for the Incentives sheet.
 *
 * Kept INTENTIONALLY SEPARATE from the Tasks sheet so that admin /
 * scrum-master views of Tasks cannot leak monetary information. Only
 * users in `config.access.financeIds` should read from this repo.
 *
 * Schema (10 columns, A..J):
 *   A  task_id
 *   B  amount               (numeric, in `currency`)
 *   C  currency             (default 'NGN')
 *   D  set_by               (user_id who attached the incentive)
 *   E  set_at               (ISO timestamp)
 *   F  doer_confirmed_at    (ISO timestamp; when doer final-acked)
 *   G  paid_status          ('' | pending | paid | cancelled)
 *   H  paid_at              (ISO timestamp; manual finance entry)
 *   I  paid_amount          (numeric; can differ from `amount`)
 *   J  notes                (free text)
 */

const sheets = require('./sheetsClient');
const config = require('../config');

const SHEET = 'Incentives';
const READ_RANGE = 'A2:J';
const NUM_COLS = 10;

function str(v) { return (v ?? '').toString().trim(); }
function floatOr(v, d) { const n = parseFloat(v); return Number.isFinite(n) ? n : d; }

function parse(r, rowIndex) {
  return {
    rowIndex,
    task_id: str(r[0]),
    amount: floatOr(r[1], 0),
    currency: str(r[2]) || (config.currency || 'NGN'),
    set_by: str(r[3]),
    set_at: str(r[4]),
    doer_confirmed_at: str(r[5]),
    paid_status: str(r[6]),
    paid_at: str(r[7]),
    paid_amount: floatOr(r[8], null),
    notes: str(r[9]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, READ_RANGE);
  return rows.map((r, i) => parse(r, i + 2)).filter((x) => x.task_id);
}

async function getByTaskId(taskId) {
  if (!taskId) return null;
  const all = await getAll();
  return all.find((x) => x.task_id === taskId) || null;
}

/**
 * Upsert (one row per task). If a row for `task_id` already exists,
 * update its amount/currency/set_by/set_at; otherwise append a fresh row.
 */
async function setAmount({ task_id, amount, currency, set_by, set_at, notes }) {
  if (!task_id) throw new Error('incentivesRepository.setAmount: task_id required');
  const existing = await getByTaskId(task_id);
  const now = set_at || new Date().toISOString();
  const cur = currency || config.currency || 'NGN';
  if (existing) {
    await sheets.updateRange(SHEET, `B${existing.rowIndex}:E${existing.rowIndex}`,
      [[String(amount ?? 0), cur, String(set_by || ''), now]]);
    if (notes !== undefined) {
      await sheets.updateRange(SHEET, `J${existing.rowIndex}`, [[String(notes || '')]]);
    }
    return { ...existing, amount: Number(amount) || 0, currency: cur, set_by, set_at: now };
  }
  const row = new Array(NUM_COLS).fill('');
  row[0] = task_id;
  row[1] = String(amount ?? 0);
  row[2] = cur;
  row[3] = String(set_by || '');
  row[4] = now;
  row[9] = notes ? String(notes) : '';
  await sheets.appendRows(SHEET, [row]);
  return { task_id, amount: Number(amount) || 0, currency: cur, set_by, set_at: now, notes };
}

async function markDoerConfirmed(taskId, ts) {
  const row = await getByTaskId(taskId);
  if (!row) return false;
  await sheets.updateRange(SHEET, `F${row.rowIndex}`, [[ts || new Date().toISOString()]]);
  return true;
}

async function markPaid({ task_id, paid_amount, paid_at, notes }) {
  const row = await getByTaskId(task_id);
  if (!row) return false;
  const when = paid_at || new Date().toISOString();
  await sheets.updateRange(SHEET, `G${row.rowIndex}:I${row.rowIndex}`,
    [['paid', when, String(paid_amount ?? row.amount)]]);
  if (notes) await sheets.updateRange(SHEET, `J${row.rowIndex}`, [[String(notes)]]);
  return true;
}

async function cancel(taskId, notes) {
  const row = await getByTaskId(taskId);
  if (!row) return false;
  await sheets.updateRange(SHEET, `G${row.rowIndex}`, [['cancelled']]);
  if (notes) await sheets.updateRange(SHEET, `J${row.rowIndex}`, [[String(notes)]]);
  return true;
}

module.exports = {
  SHEET,
  getAll,
  getByTaskId,
  setAmount,
  markDoerConfirmed,
  markPaid,
  cancel,
  _parse: parse,
};
