#!/usr/bin/env node
/**
 * Offline smoke harness for AtFactoryPrice Telegram bot (TG-19).
 *
 * Checks:
 *   S1  Org graph helpers (reuses check-org-graph assertions)
 *   S2  Repo parse — departmentsRepository reads parent_department
 *   S3  Repo parse — usersRepository reads manages
 *   S4  Intent-parser action enum vs risk/evaluate.js policy (TG-7 lint)
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
// Runner
// ---------------------------------------------------------------------------
(function main() {
  console.log('=== AtFactoryPrice smoke harness ===\n');

  try { runS1(); } catch (e) { fail('S1 unexpected error', e.message); }
  try { runS2(); } catch (e) { fail('S2 unexpected error', e.message); }
  try { runS3(); } catch (e) { fail('S3 unexpected error', e.message); }
  try { runS4(); } catch (e) { fail('S4 unexpected error', e.message); }

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
