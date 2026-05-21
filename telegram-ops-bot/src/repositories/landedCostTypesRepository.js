'use strict';

/**
 * landedCostTypesRepository — sole owner of the LandedCostTypes sheet.
 *
 * Columns: type_id | type_name | active | created_at | created_by | notes
 *
 * The catalogue is seeded by schemaMapper with 7 common types
 * (Container Clearance, Clearing Agent, Logistics, Demurrage,
 * Insurance, Customs Duty, Bank Transfer Fee). Admin / finance can
 * append more over time without a code change. The "Finalize Landed
 * Cost" flow reads the ACTIVE rows to build its picker.
 */

const sheets = require('./sheetsClient');
const idGenerator = require('../utils/idGenerator');

const SHEET = 'LandedCostTypes';

function str(v) { return (v ?? '').toString().trim(); }

function parse(r) {
  if (!r || !r[0]) return null;
  return {
    type_id:    str(r[0]),
    type_name:  str(r[1]),
    active:     String(r[2] || '').toUpperCase() === 'TRUE',
    created_at: str(r[3]),
    created_by: str(r[4]),
    notes:      str(r[5]),
  };
}

async function getAll() {
  const rows = await sheets.readRange(SHEET, 'A2:F');
  return (rows || []).map(parse).filter(Boolean);
}

async function getActive() {
  return (await getAll()).filter((t) => t.active);
}

async function getById(typeId) {
  return (await getAll()).find((t) => t.type_id === str(typeId)) || null;
}

async function append({ type_name, created_by, notes = '' }) {
  if (!type_name) throw new Error('type_name required');
  const all = await getAll();
  // Avoid duplicate names (case-insensitive).
  const dup = all.find((t) => t.type_name.toLowerCase() === String(type_name).toLowerCase());
  if (dup) return dup;
  const nextNum = all.length + 1;
  const typeId = `LCT-${String(nextNum).padStart(3, '0')}`;
  const row = [
    typeId, String(type_name).trim(), 'TRUE',
    new Date().toISOString(), String(created_by || ''), String(notes || ''),
  ];
  await sheets.appendRows(SHEET, [row]);
  return parse(row);
}

module.exports = { getAll, getActive, getById, append, SHEET };
