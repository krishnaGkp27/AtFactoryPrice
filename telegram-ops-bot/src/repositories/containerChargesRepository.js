'use strict';

/**
 * containerChargesRepository — sole owner of the ContainerCharges sheet.
 *
 * Columns:
 *   charge_id | grn_id | type_id | type_name
 * | amount_usd | entered_by | entered_at | notes
 *
 * Append-only during the "Finalize Landed Cost" flow. Once the flow's
 * dual-admin approval lands, the rows are SEALED (no edits) — any
 * correction is a new flow / new approval. This keeps the audit
 * trail intact.
 */

const sheets = require('./sheetsClient');

const SHEET = 'ContainerCharges';

function str(v) { return (v ?? '').toString().trim(); }
function num(v) { return parseFloat(v) || 0; }

let _seq = 0;
function _chargeId() {
  _seq = (_seq + 1) % 1000;
  return `LCC-${Date.now()}-${String(_seq).padStart(3, '0')}`;
}

function parse(r) {
  if (!r || !r[0]) return null;
  return {
    charge_id:   str(r[0]),
    grn_id:      str(r[1]),
    type_id:     str(r[2]),
    type_name:   str(r[3]),
    amount_usd:  num(r[4]),
    entered_by:  str(r[5]),
    entered_at:  str(r[6]),
    notes:       str(r[7]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:H');
  return (rows || []).map(parse).filter(Boolean);
}

async function findByGrn(grnId) {
  const target = str(grnId);
  if (!target) return [];
  return (await getAll()).filter((c) => c.grn_id === target);
}

async function append({ grn_id, type_id, type_name, amount_usd, entered_by, notes = '' }) {
  if (!grn_id) throw new Error('grn_id required');
  if (!type_name) throw new Error('type_name required');
  if (!(Number(amount_usd) > 0)) throw new Error('amount_usd must be > 0');
  const row = [
    _chargeId(), String(grn_id), String(type_id || ''), String(type_name),
    Number(amount_usd), String(entered_by || ''), new Date().toISOString(),
    String(notes || ''),
  ];
  await sheets.appendRows(SHEET, [row]);
  return parse(row);
}

async function appendMany(rows) {
  if (!rows || !rows.length) return [];
  const out = [];
  const sheetRows = rows.map((r) => {
    const parsed = [
      _chargeId(), String(r.grn_id), String(r.type_id || ''), String(r.type_name),
      Number(r.amount_usd), String(r.entered_by || ''), new Date().toISOString(),
      String(r.notes || ''),
    ];
    out.push(parse(parsed));
    return parsed;
  });
  await sheets.appendRows(SHEET, sheetRows);
  return out;
}

module.exports = { getAll, findByGrn, append, appendMany, SHEET };
