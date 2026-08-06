'use strict';

/**
 * customerIdRepair — CUS-ID1, a guarded one-off (owner-commissioned
 * 06-Aug-2026 after INV-2026-0016 printed "Christ" for a CJE sale).
 *
 * WHAT WENT WRONG. idGenerator's daily counter lived in memory, so every
 * deploy reset it and re-minted `-001`: four customer_ids ended up shared by
 * 14 rows. A shared id breaks entity identity everywhere id wins over name:
 * invoices print the FIRST row carrying the id, and getCustomerLedger pools
 * every same-id customer's entries into one outstanding figure.
 *
 * WHAT THIS DOES — from the owner's exported sheet, verified row by row:
 *   1. Each collision group keeps the id on its OLDEST row (the id "was
 *      born" with it) and re-keys the later rows to fresh `-RNN` ids — a
 *      suffix the generators never mint, so the new ids cannot collide.
 *   2. Ledger_Entries rows stamped with a shared id are re-filed by the
 *      customer NAME inside their narration (the CUS-2 boundary-anchored
 *      templates). A narration naming nobody in the group is left alone and
 *      reported — never guessed (owner: "no guessing").
 *   3. Invoices rows are re-stamped the same way via their customer_name.
 *
 * GUARDS (the whole value of the repair):
 *   - A target row is touched ONLY when exactly one Customers row matches
 *     its (shared id, exact name, exact created_at) triple from the export.
 *     Zero or two matches → skipped and reported.
 *   - Only the customer_id cell is written; names, balances, status,
 *     ledger amounts and narrations are never modified.
 *   - Idempotent: re-keyed rows no longer match their triple, and ledger
 *     cells are only written when the value actually changes, so later
 *     boots are no-ops.
 */

const sheets = require('../repositories/sheetsClient');
const customersRepository = require('../repositories/customersRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * The repair table — copied from the owner's 06-Aug-2026 export, keyed by
 * the exact (sharedId, name, created_at) triples seen there. KEEPERS are
 * the oldest row of each group and are listed only so the ledger re-stamp
 * knows every name in the group; their id is never rewritten.
 */
const GROUPS = [
  {
    sharedId: 'CUST-20260301-001',
    keeper: { name: 'testcustomer', createdAt: '2026-03-01T11:12:08.625Z' },
    rekey: [
      { name: 'Alhaji Karimullah', createdAt: '2026-03-01T15:14:08.876Z', newId: 'CUST-20260301-R01' },
      { name: 'Alhaji Ahmad', createdAt: '2026-03-01T22:18:12.150Z', newId: 'CUST-20260301-R02' },
    ],
  },
  {
    sharedId: 'CUST-20260302-001',
    keeper: { name: 'Christ', createdAt: '2026-03-02T12:10:22.759Z' },
    rekey: [
      { name: 'oshodi madam', createdAt: '2026-03-02T20:08:15.561Z', newId: 'CUST-20260302-R01' },
      { name: 'madam oshodi cashmere', createdAt: '2026-03-02T20:54:44.646Z', newId: 'CUST-20260302-R02' },
      { name: 'CJE', createdAt: '2026-03-02T21:36:18.685Z', newId: 'CUST-20260302-R03' },
      { name: 'Karimullah', createdAt: '2026-03-02T23:07:31.676Z', newId: 'CUST-20260302-R04' },
    ],
  },
  {
    sharedId: 'CUST-20260302-002',
    keeper: { name: 'mama kafaya', createdAt: '2026-03-02T12:13:05.318Z' },
    rekey: [
      { name: 'keyus', createdAt: '2026-03-02T20:27:26.211Z', newId: 'CUST-20260302-R05' },
    ],
  },
  {
    sharedId: 'CUST-20260312-001',
    keeper: { name: 'soldier madam', createdAt: '2026-03-12T15:09:59.019Z' },
    rekey: [
      { name: 'testC', createdAt: '2026-03-12T18:27:30.532Z', newId: 'CUST-20260312-R01' },
      { name: 'testD', createdAt: '2026-03-12T18:45:04.772Z', newId: 'CUST-20260312-R02' },
      { name: 'custE', createdAt: '2026-03-12T18:56:45.438Z', newId: 'CUST-20260312-R03' },
    ],
  },
];

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * Customer name inside a Ledger_Entries narration — the same two
 * boundary-anchored templates CUS-2 locked (see extLedgerService):
 *   "Sale: … to <customer> | …"  ·  "Payment received from <customer>: …"
 * Anything else returns null and is never re-filed.
 */
function narrationCustomer(narration) {
  const s = String(narration || '');
  if (/^Sale:/i.test(s)) {
    let m = s.match(/\sto\s+(.+?)\s*\|/i);
    if (m) return m[1].trim();
    m = s.match(/\sto\s+(.+)$/i);
    if (m) return m[1].trim();
    return null;
  }
  if (/^Payment received from/i.test(s)) {
    const m = s.match(/^Payment received from\s+(.+?):/i);
    if (m) return m[1].trim();
  }
  return null;
}

/** Re-key the Customers rows. @returns {{rekeyed:string[], skipped:string[]}} */
async function rekeyCustomers() {
  const all = await customersRepository.getAll();
  const rekeyed = [];
  const skipped = [];
  for (const g of GROUPS) {
    for (const t of g.rekey) {
      const already = all.filter((c) => c.customer_id === t.newId);
      if (already.length) continue; // done on an earlier boot
      const matches = all.filter((c) => c.customer_id === g.sharedId
        && String(c.name).trim() === t.name
        && String(c.created_at).trim() === t.createdAt);
      if (matches.length !== 1) {
        skipped.push(`${t.name}: ${matches.length} rows matched the export triple — hands off`);
        continue;
      }
      await sheets.updateRange('Customers', `A${matches[0].rowIndex}`, [[t.newId]]);
      rekeyed.push(`${t.name}: ${g.sharedId} → ${t.newId}`);
    }
  }
  return { rekeyed, skipped };
}

/** name(lower) → correct id, per shared id. */
function nameMapFor(g) {
  const m = new Map([[norm(g.keeper.name), g.sharedId]]);
  for (const t of g.rekey) m.set(norm(t.name), t.newId);
  return m;
}

/** Re-file Ledger_Entries column K by narration name. */
async function restampLedger() {
  const rows = await sheets.readRange('Ledger_Entries', 'A2:K');
  const byShared = new Map(GROUPS.map((g) => [g.sharedId, nameMapFor(g)]));
  let restamped = 0;
  const unattributed = [];
  for (let i = 0; i < (rows || []).length; i += 1) {
    const r = rows[i];
    const stamped = String(r[10] || '').trim();
    const map = byShared.get(stamped);
    if (!map) continue; // not one of the shared ids
    const who = narrationCustomer(r[7]);
    const correct = who ? map.get(norm(who)) : null;
    if (!correct) {
      unattributed.push(`row ${i + 2}: "${String(r[7] || '').slice(0, 60)}"`);
      continue;
    }
    if (correct === stamped) continue; // the keeper's entries are already right
    await sheets.updateRange('Ledger_Entries', `K${i + 2}`, [[correct]]);
    restamped += 1;
  }
  return { restamped, unattributed };
}

/** Re-stamp Invoices.customer_id (col D) by the row's own customer_name (col E). */
async function restampInvoices() {
  let rows = [];
  try { rows = await sheets.readRange('Invoices', 'A2:E'); } catch (_) { return { restamped: 0 }; }
  const byShared = new Map(GROUPS.map((g) => [g.sharedId, nameMapFor(g)]));
  let restamped = 0;
  for (let i = 0; i < (rows || []).length; i += 1) {
    const stamped = String(rows[i][3] || '').trim();
    const map = byShared.get(stamped);
    if (!map) continue;
    const correct = map.get(norm(rows[i][4]));
    if (!correct || correct === stamped) continue;
    await sheets.updateRange('Invoices', `D${i + 2}`, [[correct]]);
    restamped += 1;
  }
  return { restamped };
}

/** Run the whole repair. Never throws. */
async function repair(bot) {
  let out;
  try {
    const customers = await rekeyCustomers();
    const ledger = await restampLedger();
    const invoices = await restampInvoices();
    out = { ...customers, ledger, invoices };
  } catch (e) {
    logger.warn(`customerIdRepair failed: ${e.message}`);
    return { error: e.message };
  }
  const acted = out.rekeyed.length || out.ledger.restamped || out.invoices.restamped
    || out.skipped.length || out.ledger.unattributed.length;
  if (!acted) return out; // quiet no-op on every later boot
  try {
    await auditLogRepository.append('customer.id_repaired', out, 'system');
  } catch (_) { /* best-effort */ }
  if (bot) {
    let text = '🧬 *Customer id repair (CUS-ID1)*\n';
    if (out.rekeyed.length) text += `\nRe-keyed:\n${out.rekeyed.map((x) => `• ${x}`).join('\n')}`;
    if (out.ledger.restamped) text += `\n\nLedger entries re-filed: ${out.ledger.restamped}`;
    if (out.invoices.restamped) text += `\nInvoices re-stamped: ${out.invoices.restamped}`;
    if (out.skipped.length) text += `\n\n⚠️ Skipped (sheet no longer matches the export):\n${out.skipped.map((x) => `• ${x}`).join('\n')}`;
    if (out.ledger.unattributed.length) {
      text += `\n\n⚠️ ${out.ledger.unattributed.length} ledger entr${out.ledger.unattributed.length === 1 ? 'y' : 'ies'} on a shared id could not be attributed by narration — left untouched:\n`
        + out.ledger.unattributed.slice(0, 5).map((x) => `• ${x}`).join('\n');
    }
    for (const adminId of config.access.adminIds) {
      try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
    }
  }
  return out;
}

module.exports = { repair, _internals: { GROUPS, narrationCustomer, rekeyCustomers, restampLedger, restampInvoices, nameMapFor } };
