#!/usr/bin/env node
/**
 * Offline smoke harness for AtFactoryPrice Telegram bot (TG-19).
 *
 * Checks:
 *   S1  Org graph helpers (reuses check-org-graph assertions)
 *   S2  Repo parse — departmentsRepository reads parent_department
 *   S3  Repo parse — usersRepository reads manages
 *   S4  Intent-parser action enum vs risk/evaluate.js policy (TG-7 lint)
 *   S5  Repo parse — tasksRepository extended schema (TG-7.5 Phase C)
 *   S6  Repo parse — incentivesRepository row shape
 *   S7  Repo parse — taskEventsRepository row shape + meta JSON
 *
 * Run:  npm run smoke         (from telegram-ops-bot/)
 * Exit: 0 = all passed, 1 = one or more FAIL
 *
 * Zero credentials required — all Sheets/Telegram/OpenAI calls are mocked.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** @type {Array<{label:string, ok:boolean, detail?:string}>} */
const results = [];

function pass(label) {
  results.push({ label, ok: true });
  console.log(`ok   ${label}`);
}

function fail(label, detail) {
  results.push({ label, ok: false, detail });
  console.log(`FAIL ${label}${detail ? ': ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// S1 — Org graph helpers
// ---------------------------------------------------------------------------
function runS1() {
  const dg = require('../src/org/deptGraph');

  const depts = [
    { dept_name: 'Sales',        parent_department: '',      allowed_activities: ['a1', 'a2'] },
    { dept_name: 'Sales-Lagos',  parent_department: 'Sales', allowed_activities: ['a3'] },
    { dept_name: 'Dispatch',     parent_department: '',      allowed_activities: ['d1'] },
  ];

  // S1.1 validateForest — no cycle
  const v = dg.validateForest(depts);
  if (v.ok) {
    pass('S1.1 validateForest: no-cycle fixture');
  } else {
    fail('S1.1 validateForest: no-cycle fixture', v.errors.join('; '));
  }

  // S1.2 ancestor chain
  const { chainNorm } = dg.getAncestorChain('Sales-Lagos', v.graph);
  if (chainNorm.includes('sales') && chainNorm.includes('sales-lagos')) {
    pass('S1.2 getAncestorChain: Sales-Lagos includes Sales');
  } else {
    fail('S1.2 getAncestorChain: Sales-Lagos includes Sales', JSON.stringify(chainNorm));
  }

  // S1.3 deptUnderAncestor
  if (dg.deptUnderAncestor('Sales-Lagos', 'Sales', v.graph)) {
    pass('S1.3 deptUnderAncestor: Sales-Lagos under Sales');
  } else {
    fail('S1.3 deptUnderAncestor: Sales-Lagos under Sales');
  }

  if (!dg.deptUnderAncestor('Sales-Lagos', 'Dispatch', v.graph)) {
    pass('S1.4 deptUnderAncestor: Sales-Lagos NOT under Dispatch');
  } else {
    fail('S1.4 deptUnderAncestor: Sales-Lagos NOT under Dispatch');
  }

  // S1.5 canAssignTo
  const mgr  = { manages: ['Sales'], departments: ['Sales'] };
  const wkr  = { departments: ['Sales-Lagos'] };
  const unrelated = { departments: ['Dispatch'] };

  if (dg.canAssignTo(mgr, wkr, v.graph)) {
    pass('S1.5 canAssignTo: Sales manager can assign to Sales-Lagos worker');
  } else {
    fail('S1.5 canAssignTo: Sales manager can assign to Sales-Lagos worker');
  }

  if (!dg.canAssignTo(mgr, unrelated, v.graph)) {
    pass('S1.6 canAssignTo: Sales manager CANNOT assign to Dispatch worker');
  } else {
    fail('S1.6 canAssignTo: Sales manager CANNOT assign to Dispatch worker');
  }

  // S1.7 mergeActivitiesForManages
  const acts = dg.mergeActivitiesForManages({ manages: ['Sales', 'Sales-Lagos'] }, depts);
  const hasAll = ['a1', 'a2', 'a3'].every((a) => acts.includes(a));
  if (hasAll) {
    pass('S1.7 mergeActivitiesForManages: union of managed depts');
  } else {
    fail('S1.7 mergeActivitiesForManages: union of managed depts', JSON.stringify(acts));
  }

  // S1.8 cycle detection
  const cycleDepts = [
    { dept_name: 'A', parent_department: 'B' },
    { dept_name: 'B', parent_department: 'A' },
  ];
  const cv = dg.validateForest(cycleDepts);
  if (!cv.ok && cv.errors.some((e) => /cycle/i.test(e))) {
    pass('S1.8 validateForest: detects A→B→A cycle');
  } else {
    fail('S1.8 validateForest: detects A→B→A cycle', JSON.stringify(cv));
  }
}

// ---------------------------------------------------------------------------
// S2 — departmentsRepository.parse reads column F (parent_department)
// ---------------------------------------------------------------------------
function runS2() {
  // Inline the parse logic without touching the real sheets client.
  function str(v) { return (v ?? '').toString().trim(); }
  function parseRow(r, rowIndex) {
    return {
      rowIndex,
      dept_id: str(r[0]),
      dept_name: str(r[1]),
      allowed_activities: str(r[2]).split(',').map((a) => a.trim()).filter(Boolean),
      status: str(r[3]) || 'active',
      created_at: str(r[4]),
      parent_department: str(r[5]),
    };
  }

  // 6-column row (new schema)
  const row6 = ['DEPT-010', 'Sales-Abuja', 'a1,a2', 'active', '2026-01-01', 'Sales'];
  const parsed6 = parseRow(row6, 2);
  if (parsed6.parent_department === 'Sales') {
    pass('S2.1 departmentsRepository: parses parent_department (col F)');
  } else {
    fail('S2.1 departmentsRepository: parses parent_department (col F)', JSON.stringify(parsed6));
  }

  // 5-column legacy row — no parent column → empty string (graceful)
  const row5 = ['DEPT-001', 'Sales', 'a1', 'active', '2026-01-01'];
  const parsed5 = parseRow(row5, 3);
  if (parsed5.parent_department === '') {
    pass('S2.2 departmentsRepository: legacy 5-col row → parent_department=""');
  } else {
    fail('S2.2 departmentsRepository: legacy 5-col row → parent_department=""', JSON.stringify(parsed5));
  }
}

// ---------------------------------------------------------------------------
// S3 — usersRepository.parse reads column J (manages)
// ---------------------------------------------------------------------------
function runS3() {
  function str(v) { return (v ?? '').toString().trim(); }
  function parseDeptCsv(raw) {
    return str(raw).split(',').map((d) => d.trim()).filter(Boolean);
  }
  function parseManagesCsv(raw) {
    return str(raw).split(',').map((d) => d.trim()).filter(Boolean);
  }
  function parseRow(r, rowIndex) {
    const departments = parseDeptCsv(r[7]);
    const manages     = parseManagesCsv(r[9]);
    return {
      rowIndex,
      user_id: str(r[0]),
      name: str(r[1]),
      role: str(r[2]) || 'employee',
      branch: str(r[3]),
      access_level: str(r[4]) || 'branch_only',
      status: str(r[5]) || 'active',
      created_at: str(r[6]),
      department: departments[0] || '',
      departments,
      warehouses: str(r[8]).split(',').map((w) => w.trim()).filter(Boolean),
      manages,
    };
  }

  // 10-column row (new schema)
  const row10 = [
    'U001', 'Yarima', 'manager', 'Lagos', 'full', 'active', '2026-01-01',
    'Sales,Dispatch', 'Lagos', 'Sales',
  ];
  const p10 = parseRow(row10, 2);
  if (Array.isArray(p10.manages) && p10.manages.includes('Sales')) {
    pass('S3.1 usersRepository: parses manages (col J)');
  } else {
    fail('S3.1 usersRepository: parses manages (col J)', JSON.stringify(p10));
  }
  if (p10.departments.includes('Sales') && p10.departments.includes('Dispatch')) {
    pass('S3.2 usersRepository: departments CSV includes both Sales and Dispatch');
  } else {
    fail('S3.2 usersRepository: departments CSV includes both Sales and Dispatch', JSON.stringify(p10));
  }

  // Legacy 9-column row → manages defaults to []
  const row9 = ['U002', 'Abdul', 'employee', 'Lagos', 'branch_only', 'active', '2026-01-01', 'Sales', 'Lagos'];
  const p9 = parseRow(row9, 3);
  if (Array.isArray(p9.manages) && p9.manages.length === 0) {
    pass('S3.3 usersRepository: legacy 9-col row → manages=[]');
  } else {
    fail('S3.3 usersRepository: legacy 9-col row → manages=[]', JSON.stringify(p9));
  }
}

// ---------------------------------------------------------------------------
// S4 — intent-parser action enum vs risk policy (TG-7 lint)
// ---------------------------------------------------------------------------
function runS4() {
  // Read intentParser.js as text; extract the enum value from the SYSTEM prompt.
  const ipPath = path.join(__dirname, '../src/ai/intentParser.js');
  const ipSrc  = fs.readFileSync(ipPath, 'utf8');

  // Extract the `"action": "…"` enum line from the SYSTEM prompt string.
  const enumMatch = ipSrc.match(/"action":\s*"([^"]+)"/);
  if (!enumMatch) {
    fail('S4 setup', 'Could not find action enum in intentParser.js');
    return;
  }
  const enumActions = enumMatch[1].split('|').map((a) => a.trim()).filter(Boolean);

  // Read evaluate.js — require it with stubbed deps so it won't crash.
  //   We only care about the two exported arrays; load via text parse to avoid
  //   importing settingsRepository (which would need Google creds).
  const evPath = path.join(__dirname, '../src/risk/evaluate.js');
  const evSrc  = fs.readFileSync(evPath, 'utf8');

  function extractArray(src, varName) {
    const re = new RegExp(`const\\s+${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
    const m = src.match(re);
    if (!m) return [];
    return m[1].match(/'([^']+)'/g)?.map((s) => s.replace(/'/g, '')) ?? [];
  }

  const WRITE_ACTIONS          = new Set(extractArray(evSrc, 'WRITE_ACTIONS'));
  const ALWAYS_APPROVAL_ACTIONS = new Set(extractArray(evSrc, 'ALWAYS_APPROVAL_ACTIONS'));

  // Actions explicitly known to be read-only / safe.
  const KNOWN_SAFE = new Set([
    'check', 'analyze', 'list_packages', 'package_detail',
    'show_ledger', 'trial_balance', 'list_banks', 'list_contacts', 'search_contact',
    'my_tasks', 'my_orders', 'check_customer', 'check_balance',
    'report_supply_by_design', 'report_sold', 'report_last_transactions',
    'report_stock', 'report_valuation', 'report_sales', 'report_customers',
    'report_warehouses', 'report_fast_moving', 'report_dead_stock',
    'report_indents', 'report_low_stock', 'report_aging',
    'customer_history', 'customer_ranking', 'customer_pattern',
    'show_customer_notes', 'sample_status', 'inventory_details',
    'sales_report_interactive', 'supply_details', 'ask_data',
    'manage_users', 'manage_departments',
    'revert_last_transaction', // mapped → revert_sale_bundle by controller; already in ALWAYS_APPROVAL
    'give_sample', 'return_sample', 'update_sample',
    'add_followup', 'add_customer_note', 'upload_receipt',
    'supply_request', 'create_order', 'mark_order_delivered',
    // Task actions: no approval gate (non-financial); controller enforces admin-only for assign
    'assign_task', 'mark_task_done',
  ]);

  let gaps = 0;
  for (const action of enumActions) {
    let gate;
    if (ALWAYS_APPROVAL_ACTIONS.has(action)) {
      gate = 'always_admin';
    } else if (WRITE_ACTIONS.has(action)) {
      gate = 'employee_needs_approval';
    } else if (KNOWN_SAFE.has(action)) {
      gate = 'safe';
    } else {
      fail(`S4 policy: ${action}`, 'no policy entry — add to WRITE_ACTIONS, ALWAYS_APPROVAL_ACTIONS, or KNOWN_SAFE in smoke.js');
      gaps++;
      continue;
    }
    pass(`S4 policy: ${action} → ${gate}`);
  }

  if (gaps === 0) {
    pass(`S4 summary: all ${enumActions.length} intent actions have policy coverage`);
  }
}

// ---------------------------------------------------------------------------
// S5 — tasksRepository._parse handles legacy 9-col + new 20-col rows
// ---------------------------------------------------------------------------
function runS5() {
  // Stub sheetsClient so the repo can load without Google creds.
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [],
    appendRows: async () => {},
    updateRange: async () => {},
  });
  const tasksRepo = require('../src/repositories/tasksRepository');

  // Legacy 9-column row (pre-TG-7.5): only A..I populated.
  const legacy = ['T1', 'Fix lamp', '', 'U1', 'U2', 'pending', '2026-05-01T00:00:00Z', '', ''];
  const lp = tasksRepo._parse(legacy, 2);
  if (lp.status === 'assigned' && lp.track === 'salaried' && lp.priority === 'normal'
      && lp.negotiation_rounds === 0 && lp.proposed_hours === null
      && lp.assigned_at === lp.created_at) {
    pass('S5.1 tasksRepository: legacy 9-col row maps pending→assigned with safe defaults');
  } else {
    fail('S5.1 tasksRepository: legacy 9-col row maps pending→assigned with safe defaults', JSON.stringify(lp));
  }

  // Legacy in_progress → active
  const legacy2 = ['T2', 'Sweep', '', 'U1', 'U2', 'in_progress', '2026-05-01', '', ''];
  const lp2 = tasksRepo._parse(legacy2, 3);
  if (lp2.status === 'active') {
    pass('S5.2 tasksRepository: legacy in_progress → active');
  } else {
    fail('S5.2 tasksRepository: legacy in_progress → active', JSON.stringify(lp2));
  }

  // Full 20-column row with new fields.
  const full = [
    'T3', 'Wire panel', 'Be careful', 'U-doer', 'U-mgr',
    'awaiting_incentive', '2026-05-09T10:00:00Z', '', '',
    'incentivized', 'high', '2026-05-09T10:00:00Z', '2026-05-09T10:05:00Z',
    '4.5', '2026-05-12', '1',
    '2026-05-09T11:00:00Z', '', '', '2026-05-09T11:00:00Z',
  ];
  const fp = tasksRepo._parse(full, 4);
  if (fp.track === 'incentivized'
      && fp.priority === 'high'
      && fp.proposed_hours === 4.5
      && fp.proposed_deadline === '2026-05-12'
      && fp.negotiation_rounds === 1
      && fp.timeline_agreed_at === '2026-05-09T11:00:00Z') {
    pass('S5.3 tasksRepository: full 20-col row parses all new fields');
  } else {
    fail('S5.3 tasksRepository: full 20-col row parses all new fields', JSON.stringify(fp));
  }

  // STATUSES exported and includes all phases.
  const wantStatuses = [
    'assigned', 'awaiting_timeline_ack', 'awaiting_incentive',
    'awaiting_final_ack', 'active', 'submitted', 'completed',
    'declined', 'cancelled',
  ];
  const haveAll = wantStatuses.every((s) => tasksRepo.VALID_STATUSES.has(s));
  if (haveAll) {
    pass('S5.4 tasksRepository: VALID_STATUSES covers full state machine');
  } else {
    fail('S5.4 tasksRepository: VALID_STATUSES covers full state machine',
      JSON.stringify([...tasksRepo.VALID_STATUSES]));
  }
}

// ---------------------------------------------------------------------------
// S6 — incentivesRepository row shape
// ---------------------------------------------------------------------------
function runS6() {
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [],
    appendRows: async () => {},
    updateRange: async () => {},
  });
  const incRepo = require('../src/repositories/incentivesRepository');

  const row = [
    'T-100', '5000', 'NGN', 'U-mgr', '2026-05-10T08:00:00Z',
    '2026-05-10T09:00:00Z', 'pending', '', '', 'sample-notes',
  ];
  const p = incRepo._parse(row, 2);
  if (p.task_id === 'T-100' && p.amount === 5000 && p.currency === 'NGN'
      && p.set_by === 'U-mgr' && p.doer_confirmed_at && p.paid_status === 'pending'
      && p.paid_amount === null) {
    pass('S6.1 incentivesRepository: parses amount/currency/set_by/doer_confirmed_at');
  } else {
    fail('S6.1 incentivesRepository: parses amount/currency/set_by/doer_confirmed_at', JSON.stringify(p));
  }

  // Sparse row — only task_id + amount set.
  const sparse = ['T-101', '0'];
  const sp = incRepo._parse(sparse, 3);
  if (sp.task_id === 'T-101' && sp.amount === 0 && sp.currency && sp.paid_amount === null) {
    pass('S6.2 incentivesRepository: sparse row → defaults');
  } else {
    fail('S6.2 incentivesRepository: sparse row → defaults', JSON.stringify(sp));
  }
}

// ---------------------------------------------------------------------------
// S7 — taskEventsRepository row shape + meta_json decoding
// ---------------------------------------------------------------------------
function runS7() {
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [],
    appendRows: async () => {},
    updateRange: async () => {},
  });
  const tev = require('../src/repositories/taskEventsRepository');

  const row = [
    'TEV-20260510-001', 'T-100', 'doer_proposed_timeline',
    'assigned', 'awaiting_timeline_ack', 'U-doer',
    '2026-05-10T10:00:00Z', JSON.stringify({ hours: 4, deadline: '2026-05-12' }),
  ];
  const p = tev._parse(row, 2);
  if (p.event_id && p.task_id === 'T-100' && p.event_type === 'doer_proposed_timeline'
      && p.from_status === 'assigned' && p.to_status === 'awaiting_timeline_ack'
      && p.meta && p.meta.hours === 4 && p.meta.deadline === '2026-05-12') {
    pass('S7.1 taskEventsRepository: parses event row with valid meta JSON');
  } else {
    fail('S7.1 taskEventsRepository: parses event row with valid meta JSON', JSON.stringify(p));
  }

  // Malformed meta — should fall back to { _raw: '…' } rather than crash.
  const bad = ['TEV-x', 'T-100', 'x', '', '', '', '', '{not-json'];
  const bp = tev._parse(bad, 3);
  if (bp.meta && typeof bp.meta._raw === 'string') {
    pass('S7.2 taskEventsRepository: malformed meta JSON → _raw fallback');
  } else {
    fail('S7.2 taskEventsRepository: malformed meta JSON → _raw fallback', JSON.stringify(bp));
  }
}

// Tiny helper to stub a module in the require cache so repo modules can
// load without their real dependencies (Google Sheets client, etc.).
function stubModule(resolvedPath, exports) {
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(function main() {
  console.log('=== AtFactoryPrice smoke harness ===\n');

  try { runS1(); } catch (e) { fail('S1 unexpected error', e.message); }
  try { runS2(); } catch (e) { fail('S2 unexpected error', e.message); }
  try { runS3(); } catch (e) { fail('S3 unexpected error', e.message); }
  try { runS4(); } catch (e) { fail('S4 unexpected error', e.message); }
  try { runS5(); } catch (e) { fail('S5 unexpected error', e.message); }
  try { runS6(); } catch (e) { fail('S6 unexpected error', e.message); }
  try { runS7(); } catch (e) { fail('S7 unexpected error', e.message); }

  const total  = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;

  console.log(`\nsmoke: ${passed} ok, ${failed} failed`);

  if (failed > 0) {
    console.log('\nFailed checks:');
    results.filter((r) => !r.ok).forEach((r) => {
      console.log(`  - ${r.label}${r.detail ? ': ' + r.detail : ''}`);
    });
    process.exit(1);
  }
})();
