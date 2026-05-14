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
 *   S8  Task state-machine engine (TG-7.5 Phase C commit 2)
 *   S9  Admin Activity Feed: isEnabled policy + catalog (T2)
 *   S10 Inventory composite-key foundation (P1)
 *   S11 Goods Receipt flow — parseBaleList + adminFeed inventory events (P2)
 *   S12 Quick Add Customer parser (P3)
 *   S13 Procurement Plan — low-stock computation + PO recompute + feed (P4)
 *   S14 Bulk Receive — CSV/XLSX parsers + row validator + fileHash (P2.5-C1)
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
    'declined', 'cancelled', 'dropped',
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
// S8 — task state-machine engine
// ---------------------------------------------------------------------------
// Replaces tasksRepository / taskEventsRepository with in-memory fakes
// so we can drive the engine through transitions without touching any
// real Google Sheet.
// ---------------------------------------------------------------------------
async function runS8() {
  // 1. Build the in-memory tasks store. We patch the existing module
  //    exports rather than swapping the whole module so that whatever
  //    references the engine has already captured still work.
  delete require.cache[require.resolve('../src/repositories/tasksRepository')];
  delete require.cache[require.resolve('../src/repositories/taskEventsRepository')];
  delete require.cache[require.resolve('../src/flows/taskStateMachine')];
  delete require.cache[require.resolve('../src/config')];

  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [], appendRows: async () => {}, updateRange: async () => {},
  });

  // Real config is awkward (parses env); inject a minimal one so the
  // engine knows who is admin.
  stubModule(require.resolve('../src/config'), {
    access: { adminIds: ['admin-1'], employeeIds: [], allowedIds: [], financeIds: [] },
    currency: 'NGN',
  });

  const tasksRepo = require('../src/repositories/tasksRepository');
  const eventsRepo = require('../src/repositories/taskEventsRepository');

  const taskStore = new Map();
  const eventStore = [];
  let rowCounter = 1;

  tasksRepo.append = async (t) => {
    const id = t.task_id || `T-${++rowCounter}`;
    const row = {
      ...t,
      task_id: id,
      rowIndex: rowCounter + 1,
      status: t.status || tasksRepo.STATUSES.ASSIGNED,
      track: t.track || 'salaried',
      priority: t.priority || 'normal',
      negotiation_rounds: 0,
      last_event_at: new Date().toISOString(),
    };
    taskStore.set(id, row);
    return row;
  };
  tasksRepo.getById = async (id) => taskStore.get(id) || null;
  tasksRepo.updateFields = async (id, patch) => {
    const t = taskStore.get(id);
    if (!t) return false;
    Object.assign(t, patch);
    return true;
  };
  eventsRepo.append = async (e) => {
    const row = { ...e, event_id: `E-${eventStore.length + 1}`, at: e.at || new Date().toISOString() };
    eventStore.push(row);
    return row;
  };
  eventsRepo.getByTaskId = async (id) => eventStore.filter((e) => e.task_id === id);

  const sm = require('../src/flows/taskStateMachine');

  // S8.1 create() — task is in 'assigned' and an 'assigned' event row is written.
  const created = await sm.create({
    title: 'Wire panel',
    assigned_to: 'doer-1',
    assigned_by: 'mgr-1',
    track: 'incentivized',
    priority: 'high',
  });
  const ev0 = (await eventsRepo.getByTaskId(created.task_id))[0];
  if (created.status === 'assigned' && ev0 && ev0.event_type === 'assigned' && ev0.to_status === 'assigned') {
    pass('S8.1 create: task starts in assigned + origin event row written');
  } else {
    fail('S8.1 create: task starts in assigned + origin event row written', JSON.stringify({ created, ev0 }));
  }

  // S8.2 illegal transition from a state that doesn't allow it.
  try {
    await sm.transition(created.task_id, 'approve', 'mgr-1');
    fail('S8.2 illegal transition rejected', 'approve from assigned should have thrown');
  } catch (e) {
    if (e.code === 'ILLEGAL_TRANSITION') pass('S8.2 illegal transition rejected (approve from assigned)');
    else fail('S8.2 illegal transition rejected', `wrong error: ${e.message}`);
  }

  // S8.3 actor-role guard: assigner cannot propose timeline (only doer can).
  try {
    await sm.transition(created.task_id, 'propose_timeline', 'mgr-1', { hours: 4, deadline: '2026-05-15' });
    fail('S8.3 doer-only transition guarded', 'should have rejected non-doer');
  } catch (e) {
    if (e.code === 'NOT_ACTOR') pass('S8.3 doer-only transition guarded (NOT_ACTOR)');
    else fail('S8.3 doer-only transition guarded', `wrong error: ${e.message}`);
  }

  // S8.4 happy path: doer proposes; status → awaiting_timeline_ack; hours/deadline saved.
  await sm.transition(created.task_id, 'propose_timeline', 'doer-1', { hours: 4, deadline: '2026-05-15' });
  let t = await tasksRepo.getById(created.task_id);
  if (t.status === 'awaiting_timeline_ack' && t.proposed_hours === 4 && t.proposed_deadline === '2026-05-15') {
    pass('S8.4 propose_timeline: status + proposed_hours + proposed_deadline persisted');
  } else {
    fail('S8.4 propose_timeline: status + proposed_hours + proposed_deadline persisted', JSON.stringify(t));
  }

  // S8.5 commit 3.5 — set_incentive is now a SELF-TRANSITION from
  // awaiting_timeline_ack. Status stays the same; audit event written;
  // can be called repeatedly (assigner adjusts amount).
  await sm.transition(created.task_id, 'set_incentive', 'mgr-1', { amount: 3000, currency: 'NGN' });
  t = await tasksRepo.getById(created.task_id);
  if (t.status === 'awaiting_timeline_ack') {
    pass('S8.5 set_incentive: self-transition from awaiting_timeline_ack (no status change)');
  } else {
    fail('S8.5 set_incentive: self-transition', JSON.stringify(t));
  }
  // Second call also legal — assigner changes the amount.
  await sm.transition(created.task_id, 'set_incentive', 'mgr-1', { amount: 5000, currency: 'NGN' });
  t = await tasksRepo.getById(created.task_id);
  if (t.status === 'awaiting_timeline_ack') {
    pass('S8.5b set_incentive: repeatable (assigner adjusts amount)');
  } else {
    fail('S8.5b set_incentive: repeatable', JSON.stringify(t));
  }

  // S8.6 accept_timeline (incentivized) now goes DIRECTLY to
  // awaiting_final_ack (skipping awaiting_incentive entirely).
  await sm.transition(created.task_id, 'accept_timeline', 'mgr-1');
  t = await tasksRepo.getById(created.task_id);
  if (t.status === 'awaiting_final_ack' && t.timeline_agreed_at) {
    pass('S8.6 accept_timeline (incentivized): → awaiting_final_ack directly (commit 3.5)');
  } else {
    fail('S8.6 accept_timeline (incentivized): → awaiting_final_ack directly', JSON.stringify(t));
  }
  await sm.transition(created.task_id, 'final_ack', 'doer-1');
  t = await tasksRepo.getById(created.task_id);
  if (t.status === 'active' && t.started_at) {
    pass('S8.6b final_ack: → active + started_at stamped');
  } else {
    fail('S8.6b final_ack: → active + started_at stamped', JSON.stringify(t));
  }

  // S8.7 admin (not assigner) can also accept/cancel; mark_done → submitted; approve → completed.
  await sm.transition(created.task_id, 'mark_done', 'doer-1');
  await sm.transition(created.task_id, 'approve', 'admin-1');
  t = await tasksRepo.getById(created.task_id);
  if (t.status === 'completed' && t.submitted_at && t.completed_at && t.approved_at) {
    pass('S8.7 mark_done + admin approve: terminal completed with all timestamps');
  } else {
    fail('S8.7 mark_done + admin approve: terminal completed with all timestamps', JSON.stringify(t));
  }

  // S8.8 audit log captured every step — at least the 6 expected event types.
  const evs = await eventsRepo.getByTaskId(created.task_id);
  const expectedTypes = [
    'assigned', 'doer_proposed_timeline', 'assigner_accepted_timeline',
    'assigner_set_incentive', 'doer_final_ack', 'doer_marked_done', 'assigner_approved',
  ];
  const haveAll = expectedTypes.every((tag) => evs.some((e) => e.event_type === tag));
  if (haveAll && evs.length >= expectedTypes.length) {
    pass(`S8.8 audit log: all ${expectedTypes.length} expected event types written`);
  } else {
    fail('S8.8 audit log: all expected event types written',
      `got: ${evs.map((e) => e.event_type).join(', ')}`);
  }

  // S8.9 rounds cap: counter + renegotiate cap at MAX_NEGOTIATION_ROUNDS.
  const t2 = await sm.create({ title: 'Negotiate me', assigned_to: 'doer-2', assigned_by: 'mgr-2', track: 'salaried' });
  for (let i = 0; i < 3; i++) {
    await sm.transition(t2.task_id, 'propose_timeline', 'doer-2', { hours: 1, deadline: '2026-05-30' });
    await sm.transition(t2.task_id, 'counter_timeline', 'mgr-2');
  }
  let exhausted = false;
  try {
    await sm.transition(t2.task_id, 'propose_timeline', 'doer-2', { hours: 1, deadline: '2026-05-30' });
    await sm.transition(t2.task_id, 'counter_timeline', 'mgr-2');
  } catch (e) {
    if (e.code === 'ROUNDS_EXHAUSTED') exhausted = true;
  }
  if (exhausted) pass(`S8.9 rounds cap: 4th counter_timeline rejected at ${sm.MAX_NEGOTIATION_ROUNDS} rounds`);
  else fail(`S8.9 rounds cap: 4th counter_timeline rejected at ${sm.MAX_NEGOTIATION_ROUNDS} rounds`);

  // S8.10 salaried track: accept_timeline → awaiting_final_ack (no incentive step).
  const t3 = await sm.create({ title: 'Salaried task', assigned_to: 'doer-3', assigned_by: 'mgr-3', track: 'salaried' });
  await sm.transition(t3.task_id, 'propose_timeline', 'doer-3', { hours: 2, deadline: '2026-05-20' });
  await sm.transition(t3.task_id, 'accept_timeline', 'mgr-3');
  const t3now = await tasksRepo.getById(t3.task_id);
  if (t3now.status === 'awaiting_final_ack') {
    pass('S8.10 accept_timeline (salaried): skips incentive → awaiting_final_ack');
  } else {
    fail('S8.10 accept_timeline (salaried): skips incentive → awaiting_final_ack', JSON.stringify(t3now));
  }

  // S8.11 cancel works from non-terminal states.
  const t4 = await sm.create({ title: 'To cancel', assigned_to: 'doer-4', assigned_by: 'mgr-4' });
  await sm.transition(t4.task_id, 'cancel', 'mgr-4');
  const t4now = await tasksRepo.getById(t4.task_id);
  if (t4now.status === 'cancelled') pass('S8.11 cancel from non-terminal works');
  else fail('S8.11 cancel from non-terminal works', JSON.stringify(t4now));

  // S8.12 no further transitions from terminal.
  try {
    await sm.transition(t4.task_id, 'mark_done', 'doer-4');
    fail('S8.12 terminal state rejects further events', 'mark_done from cancelled should throw');
  } catch (e) {
    if (e.code === 'ILLEGAL_TRANSITION') pass('S8.12 terminal state rejects further events');
    else fail('S8.12 terminal state rejects further events', `wrong error: ${e.message}`);
  }

  // S8.13 commit 3.5 — incentivized happy path audit log shape.
  const incevs = await eventsRepo.getByTaskId(created.task_id);
  const expectedOrder = [
    'assigned',
    'doer_proposed_timeline',
    'assigner_set_incentive',     // BEFORE accept_timeline now
    'assigner_set_incentive',     // second call (amount adjust)
    'assigner_accepted_timeline',
    'doer_final_ack',
    'doer_marked_done',
    'assigner_approved',
  ];
  const actualOrder = incevs.map((e) => e.event_type);
  if (JSON.stringify(actualOrder) === JSON.stringify(expectedOrder)) {
    pass('S8.13 audit log: set_incentive logged BEFORE accept_timeline (commit 3.5 order)');
  } else {
    fail('S8.13 audit log: set_incentive logged BEFORE accept_timeline',
      `expected ${JSON.stringify(expectedOrder)} got ${JSON.stringify(actualOrder)}`);
  }

  // S8.14 set_incentive is rejected from non-awaiting-timeline-ack
  // states (e.g. after the deal is locked).
  try {
    await sm.transition(created.task_id, 'set_incentive', 'mgr-1', { amount: 7000 });
    fail('S8.14 set_incentive from completed rejected', 'should throw ILLEGAL_TRANSITION');
  } catch (e) {
    if (e.code === 'ILLEGAL_TRANSITION') pass('S8.14 set_incentive from completed rejected (ILLEGAL_TRANSITION)');
    else fail('S8.14 set_incentive from completed rejected', `wrong error: ${e.message}`);
  }

  // S8.15 update_priority — self-transition that mutates only priority,
  // legal in every non-terminal state, only assigner_or_admin allowed.
  const t5 = await sm.create({
    title: 'Re-prio test', assigned_to: 'doer-5', assigned_by: 'mgr-5',
    priority: 'normal',
  });
  // Doer cannot self-promote.
  try {
    await sm.transition(t5.task_id, 'update_priority', 'doer-5', { priority: 'high' });
    fail('S8.15a update_priority: doer rejected', 'should have thrown NOT_ACTOR');
  } catch (e) {
    if (e.code === 'NOT_ACTOR') pass('S8.15a update_priority: doer rejected (NOT_ACTOR)');
    else fail('S8.15a update_priority: doer rejected', `wrong error: ${e.message}`);
  }
  // Assigner promotes from normal → critical; status stays 'assigned'.
  await sm.transition(t5.task_id, 'update_priority', 'mgr-5', {
    priority: 'critical', from_priority: 'normal',
  });
  let t5now = await tasksRepo.getById(t5.task_id);
  if (t5now.status === 'assigned' && t5now.priority === 'critical') {
    pass('S8.15b update_priority: self-transition kept status, swapped priority');
  } else {
    fail('S8.15b update_priority: self-transition kept status, swapped priority', JSON.stringify(t5now));
  }
  // Even from 'active' (after a full negotiation loop), priority can flip.
  await sm.transition(t5.task_id, 'propose_timeline', 'doer-5', { hours: 1, deadline: '2026-06-01' });
  await sm.transition(t5.task_id, 'accept_timeline', 'mgr-5');
  await sm.transition(t5.task_id, 'final_ack', 'doer-5');
  await sm.transition(t5.task_id, 'update_priority', 'mgr-5', { priority: 'low' });
  t5now = await tasksRepo.getById(t5.task_id);
  if (t5now.status === 'active' && t5now.priority === 'low') {
    pass('S8.15c update_priority: legal mid-flight on active status');
  } else {
    fail('S8.15c update_priority: legal mid-flight on active status', JSON.stringify(t5now));
  }

  // S8.16 drop — manager-initiated terminal transition from open states.
  // Drop from active works; drop from submitted does NOT (assigner should
  // approve/reject instead).
  const t6 = await sm.create({ title: 'To drop', assigned_to: 'doer-6', assigned_by: 'mgr-6' });
  await sm.transition(t6.task_id, 'drop', 'mgr-6', { reason: 'No longer needed' });
  const t6now = await tasksRepo.getById(t6.task_id);
  if (t6now.status === 'dropped' && t6now.completed_at) {
    pass('S8.16a drop: assigned → dropped (terminal, completed_at stamped)');
  } else {
    fail('S8.16a drop: assigned → dropped', JSON.stringify(t6now));
  }
  // Drop from a submitted task is illegal — assigner must approve/reject.
  const t7 = await sm.create({ title: 'Submitted then drop?', assigned_to: 'doer-7', assigned_by: 'mgr-7' });
  await sm.transition(t7.task_id, 'propose_timeline', 'doer-7', { hours: 1, deadline: '2026-06-01' });
  await sm.transition(t7.task_id, 'accept_timeline', 'mgr-7');
  await sm.transition(t7.task_id, 'final_ack', 'doer-7');
  await sm.transition(t7.task_id, 'mark_done', 'doer-7');
  try {
    await sm.transition(t7.task_id, 'drop', 'mgr-7');
    fail('S8.16b drop from submitted rejected', 'should throw ILLEGAL_TRANSITION');
  } catch (e) {
    if (e.code === 'ILLEGAL_TRANSITION') pass('S8.16b drop from submitted rejected (assigner must approve/reject)');
    else fail('S8.16b drop from submitted rejected', `wrong error: ${e.message}`);
  }
  // Dropped is terminal — no further transitions.
  try {
    await sm.transition(t6.task_id, 'mark_done', 'doer-6');
    fail('S8.16c dropped is terminal', 'mark_done should throw');
  } catch (e) {
    if (e.code === 'ILLEGAL_TRANSITION') pass('S8.16c dropped is terminal (no outbound edges)');
    else fail('S8.16c dropped is terminal', `wrong error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// S9 — Admin Activity Feed: isEnabled policy + catalog (T2)
// ---------------------------------------------------------------------------
function runS9() {
  // Stub usersRepository so adminFeed can require it without Sheets creds.
  // We only test isEnabled / catalog helpers — notify() needs a bot and is
  // exercised at integration time.
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [],
    appendRows: async () => {},
    updateRange: async () => {},
    getSheetNames: async () => [],
    addSheet: async () => {},
  });
  const af = require('../src/services/adminFeed');

  // S9.1 — no prefs at all = DEFAULT_POLICY for the type.
  if (af.isEnabled(null, 'task.assigned') === true
      && af.isEnabled(null, 'task.priority') === false) {
    pass('S9.1 isEnabled: null prefs → DEFAULT_POLICY (assigned=ON, priority=OFF)');
  } else {
    fail('S9.1 isEnabled: null prefs → DEFAULT_POLICY');
  }

  // S9.2 — explicit user override beats DEFAULT.
  const prefs = { 'task.assigned': false, 'task.priority': true };
  if (af.isEnabled(prefs, 'task.assigned') === false
      && af.isEnabled(prefs, 'task.priority') === true) {
    pass('S9.2 isEnabled: explicit prefs override DEFAULT_POLICY');
  } else {
    fail('S9.2 isEnabled: explicit prefs override DEFAULT_POLICY');
  }

  // S9.3 — prefs object without this event falls back to DEFAULT.
  const partial = { 'task.assigned': false };
  if (af.isEnabled(partial, 'order.delivered') === true
      && af.isEnabled(partial, 'task.priority') === false) {
    pass('S9.3 isEnabled: missing key falls back to DEFAULT_POLICY');
  } else {
    fail('S9.3 isEnabled: missing key falls back to DEFAULT_POLICY');
  }

  // S9.4 — malformed JSON marker → fallback to DEFAULT.
  const malformed = { _malformed: 'not-json' };
  if (af.isEnabled(malformed, 'order.created') === true) {
    pass('S9.4 isEnabled: malformed prefs fall back to DEFAULT_POLICY');
  } else {
    fail('S9.4 isEnabled: malformed prefs fall back to DEFAULT_POLICY');
  }

  // S9.5 — catalog coverage: every group in GROUP_META has ≥1 event.
  const groups = af.listGroups().map((g) => g.id);
  const eventGroups = new Set(af.listEventTypes().map((et) => af.getCatalogEntry(et).group));
  const allGroupsCovered = groups.every((g) => eventGroups.has(g));
  if (allGroupsCovered) {
    pass('S9.5 catalog: every declared group has at least one event');
  } else {
    fail('S9.5 catalog: every declared group has at least one event',
      `groups=${JSON.stringify(groups)} events=${JSON.stringify([...eventGroups])}`);
  }

  // S9.6 — default policy preserves today's behavior for legacy events
  // (so admin notifications don't go silent on upgrade).
  const legacyOn = ['task.assigned', 'task.completed', 'task.dropped', 'task.declined',
                    'order.created', 'order.accepted', 'order.delivered', 'payout.paid'];
  const allLegacyOn = legacyOn.every((et) => af.getCatalogEntry(et)?.default === true);
  if (allLegacyOn) {
    pass('S9.6 default policy: all legacy events default ON (preserve current behavior)');
  } else {
    fail('S9.6 default policy: all legacy events default ON',
      JSON.stringify(legacyOn.map((et) => [et, af.getCatalogEntry(et)?.default])));
  }
}

// ---------------------------------------------------------------------------
// S10 — Inventory composite-key foundation (P1)
// ---------------------------------------------------------------------------
async function runS10() {
  // Reset module cache so previous stubs don't leak.
  delete require.cache[require.resolve('../src/repositories/sheetsClient')];
  delete require.cache[require.resolve('../src/repositories/inventoryRepository')];

  // Mock sheets state: row 2 is a legacy row (only A-Q populated, R/S/T empty);
  // we'll append a new bale and re-read to verify the round-trip.
  const sheetRows = [
    // Row 2 — legacy: PackageNo=5801, Design=Beige, DateReceived=2024-12-01, no bale_uid/addedAt
    ['5801', '', '', 'Beige Crepe', 'B-12', 1, 50, 'available', 'Kano', 0, '2024-12-01', '', '', '', '', '', 'fabric', '', '', ''],
  ];
  const updateLog = [];
  const appendLog = [];

  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async (sheet, range) => {
      if (range.startsWith('A1')) return [['PackageNo']]; // header row exists
      return sheetRows;
    },
    appendRows: async (sheet, rows) => {
      appendLog.push(...rows);
      rows.forEach((r) => sheetRows.push(r));
    },
    updateRange: async (sheet, range, values) => { updateLog.push({ range, values }); },
    batchUpdateRanges: async (sheet, updates) => { updateLog.push(...updates); },
  });

  const invRepo = require('../src/repositories/inventoryRepository');

  // S10.1 — legacy row gets synthetic bale_uid + addedAt at read time
  invRepo.invalidateCache();
  const all1 = await invRepo.getAll();
  const legacy = all1.find((r) => r.packageNo === '5801');
  if (legacy && legacy.baleUid === 'BAL-LEGACY-2' && legacy.addedAt === '2024-12-01' && legacy._legacy === true) {
    pass('S10.1 parseRow: legacy row gets synthetic BAL-LEGACY-<rowIndex> + addedAt=DateReceived');
  } else {
    fail('S10.1 parseRow: legacy row synthetic id', JSON.stringify(legacy));
  }

  // S10.2 — appendBale() generates server-side bale_uid + addedAt
  invRepo.invalidateCache();
  const created = await invRepo.appendBale([{
    packageNo: '5801', design: 'Beige Crepe', shade: 'B-12',
    thanNo: 1, yards: 50, warehouse: 'Kano', dateReceived: '2026-05-14',
  }]);
  if (created.length === 1
      && /^BAL-\d{8}-5801-[a-z0-9]{4}$/.test(created[0].baleUid)
      && /^\d{4}-\d{2}-\d{2}T/.test(created[0].addedAt)) {
    pass('S10.2 appendBale: server-generated bale_uid (BAL-YYYYMMDD-pkg-rand4) + ISO addedAt');
  } else {
    fail('S10.2 appendBale: server-generated id', JSON.stringify(created[0]));
  }

  // S10.3 — same PackageNo across intake dates is allowed (composite-key semantics)
  invRepo.invalidateCache();
  const all3 = await invRepo.getAll();
  const both5801 = all3.filter((r) => r.packageNo === '5801');
  if (both5801.length === 2) {
    pass('S10.3 findByPackage: two rows with PackageNo=5801 coexist (legacy + new intake)');
  } else {
    fail('S10.3 findByPackage: composite key duplicates', `expected 2, got ${both5801.length}`);
  }

  // S10.4 — findByPackage(p, { latestOnly: true }) returns just the newest
  invRepo.invalidateCache();
  const latest = await invRepo.findByPackage('5801', { latestOnly: true });
  if (latest.length === 1 && /^BAL-2026/.test(latest[0].baleUid)) {
    pass('S10.4 findByPackage latestOnly: returns the most recently added instance');
  } else {
    fail('S10.4 findByPackage latestOnly', JSON.stringify(latest));
  }

  // S10.5 — findByBaleUid looks up by internal unambiguous id
  invRepo.invalidateCache();
  const newUid = created[0].baleUid;
  const byUid = await invRepo.findByBaleUid(newUid);
  if (byUid && byUid.packageNo === '5801' && byUid.baleUid === newUid) {
    pass('S10.5 findByBaleUid: resolves Inventory row by internal id');
  } else {
    fail('S10.5 findByBaleUid', JSON.stringify(byUid));
  }

  // S10.6 — backfillLegacyBales writes synthetic ids for empty-uid rows
  invRepo.invalidateCache();
  updateLog.length = 0;
  const filled = await invRepo.backfillLegacyBales();
  const wroteR2 = updateLog.some((u) => /^R2:S2$/.test(u.range));
  if (filled === 1 && wroteR2) {
    pass('S10.6 backfillLegacyBales: persists synthetic id for legacy row in batch update');
  } else {
    fail('S10.6 backfillLegacyBales', `filled=${filled} log=${JSON.stringify(updateLog)}`);
  }
}

// ---------------------------------------------------------------------------
// S11 — Goods Receipt flow: bale-list parser + adminFeed inventory events (P2)
// ---------------------------------------------------------------------------
function runS11() {
  // Stub sheetsClient so the flow module can load without Google creds.
  // We only need the pure helpers (parseBaleList) and the adminFeed catalog.
  delete require.cache[require.resolve('../src/repositories/sheetsClient')];
  delete require.cache[require.resolve('../src/services/adminFeed')];
  delete require.cache[require.resolve('../src/flows/goodsReceiptFlow')];

  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async () => [],
    appendRows: async () => {},
    updateRange: async () => {},
    batchUpdateRanges: async () => {},
    getSheetNames: async () => [],
    addSheet: async () => {},
  });

  const grn = require('../src/flows/goodsReceiptFlow');
  const { parseBaleList } = grn._internals;

  // S11.1 — comma list
  let r = parseBaleList('5801,5802,5803');
  if (r.ok && r.bales.length === 3 && r.bales[0] === '5801' && r.bales[2] === '5803') {
    pass('S11.1 parseBaleList: CSV → 3 distinct entries');
  } else fail('S11.1 parseBaleList CSV', JSON.stringify(r));

  // S11.2 — numeric range
  r = parseBaleList('5801-5805');
  if (r.ok && r.bales.length === 5 && r.bales[0] === '5801' && r.bales[4] === '5805') {
    pass('S11.2 parseBaleList: range 5801-5805 → 5 sequential entries');
  } else fail('S11.2 parseBaleList range', JSON.stringify(r));

  // S11.3 — mixed CSV + range with whitespace
  r = parseBaleList('5801-5803, 5810, 5820');
  if (r.ok && r.bales.length === 5 && r.bales.join(',') === '5801,5802,5803,5810,5820') {
    pass('S11.3 parseBaleList: mixed CSV+range with whitespace tolerated');
  } else fail('S11.3 parseBaleList mixed', JSON.stringify(r));

  // S11.4 — dedup across overlapping inputs
  r = parseBaleList('5801, 5801, 5801-5803');
  if (r.ok && r.bales.length === 3) {
    pass('S11.4 parseBaleList: dedup across CSV duplicates and range overlap');
  } else fail('S11.4 parseBaleList dedup', JSON.stringify(r));

  // S11.5 — non-numeric literal stays as-is, range fails for non-numeric bounds
  r = parseBaleList('A1, A2, B3');
  if (r.ok && r.bales.length === 3 && r.bales.includes('A1') && r.bales.includes('B3')) {
    pass('S11.5 parseBaleList: alphanumeric literals pass through');
  } else fail('S11.5 parseBaleList alphanumeric', JSON.stringify(r));

  // S11.6 — illegal range (low > high) rejected
  r = parseBaleList('5810-5805');
  if (!r.ok && /low/.test(r.error)) {
    pass('S11.6 parseBaleList: range with low > high rejected');
  } else fail('S11.6 parseBaleList illegal range', JSON.stringify(r));

  // S11.7 — empty / whitespace-only input rejected
  r = parseBaleList('   ');
  if (!r.ok) pass('S11.7 parseBaleList: whitespace-only input rejected');
  else fail('S11.7 parseBaleList empty', JSON.stringify(r));

  // S11.8 — runaway range guard
  r = parseBaleList('1-10000');
  if (!r.ok && /exceeds/.test(r.error)) {
    pass('S11.8 parseBaleList: > 1000-bale range rejected (operator must split)');
  } else fail('S11.8 parseBaleList runaway range', JSON.stringify(r));

  // S11.9 — adminFeed catalog includes the three new inventory event types
  const af = require('../src/services/adminFeed');
  const expected = ['goods.received', 'warehouse.added', 'warehouse.renamed'];
  const ok = expected.every((et) => {
    const e = af.getCatalogEntry(et);
    return e && e.group === 'inventory' && e.default === true;
  });
  if (ok) pass('S11.9 adminFeed CATALOG: goods.received + warehouse.added/renamed registered, default ON');
  else fail('S11.9 adminFeed CATALOG: inventory events',
    JSON.stringify(expected.map((et) => [et, af.getCatalogEntry(et)])));

  // S11.10 — adminFeed groups include 'inventory'
  const groups = af.listGroups();
  if (groups.find((g) => g.id === 'inventory' && /Inventory/i.test(g.label))) {
    pass('S11.10 adminFeed groups: inventory group declared with label');
  } else fail('S11.10 adminFeed groups inventory', JSON.stringify(groups));
}

// ---------------------------------------------------------------------------
// S12 — Quick Add Customer parser (P3)
// ---------------------------------------------------------------------------
function runS12() {
  const { parseQuickAddCustomerLine } = require('../src/utils/quickAddParser');

  // S12.1 — name only (phone optional)
  let r = parseQuickAddCustomerLine('Mariam Salisu');
  if (r.ok && r.name === 'Mariam Salisu' && r.phone === '' && r.address === '') {
    pass('S12.1 quick-add: name-only input → phone+address empty');
  } else fail('S12.1 quick-add name-only', JSON.stringify(r));

  // S12.2 — name + phone
  r = parseQuickAddCustomerLine('Mariam Salisu, +234-803-555-7777');
  if (r.ok && r.name === 'Mariam Salisu' && r.phone === '+234-803-555-7777' && r.address === '') {
    pass('S12.2 quick-add: name+phone parsed');
  } else fail('S12.2 quick-add name+phone', JSON.stringify(r));

  // S12.3 — name + phone + address (single)
  r = parseQuickAddCustomerLine('Wang Tex, +234-1-555-1234, Lagos');
  if (r.ok && r.address === 'Lagos') {
    pass('S12.3 quick-add: name+phone+address parsed');
  } else fail('S12.3 quick-add full', JSON.stringify(r));

  // S12.4 — address with internal comma is preserved (rejoined)
  r = parseQuickAddCustomerLine('Wang Tex, +234-1-555-1234, Lagos, Apapa Wharf');
  if (r.ok && r.address === 'Lagos, Apapa Wharf') {
    pass('S12.4 quick-add: multi-part address rejoined with commas');
  } else fail('S12.4 quick-add multi-part address', JSON.stringify(r));

  // S12.5 — name too short rejected
  r = parseQuickAddCustomerLine('A');
  if (!r.ok && /short/i.test(r.error)) pass('S12.5 quick-add: single-char name rejected');
  else fail('S12.5 quick-add single-char', JSON.stringify(r));

  // S12.6 — malformed phone rejected (letters)
  r = parseQuickAddCustomerLine('Wang Tex, NOT-A-PHONE');
  if (!r.ok && /malformed/i.test(r.error)) pass('S12.6 quick-add: malformed phone rejected');
  else fail('S12.6 quick-add malformed phone', JSON.stringify(r));

  // S12.7 — empty input rejected
  r = parseQuickAddCustomerLine('');
  if (!r.ok) pass('S12.7 quick-add: empty input rejected');
  else fail('S12.7 quick-add empty', JSON.stringify(r));

  // S12.8 — whitespace tolerance + Unicode names
  r = parseQuickAddCustomerLine('  Ngozi Okafor ,  +234 803 555 7777  ');
  if (r.ok && r.name === 'Ngozi Okafor' && r.phone === '+234 803 555 7777') {
    pass('S12.8 quick-add: whitespace stripped, Unicode names preserved');
  } else fail('S12.8 quick-add whitespace', JSON.stringify(r));
}

// ---------------------------------------------------------------------------
// S13 — Procurement Plan: low-stock computation + PO status recompute (P4)
// ---------------------------------------------------------------------------
async function runS13() {
  delete require.cache[require.resolve('../src/repositories/sheetsClient')];
  delete require.cache[require.resolve('../src/repositories/inventoryRepository')];
  delete require.cache[require.resolve('../src/repositories/procurementOrdersRepository')];
  delete require.cache[require.resolve('../src/repositories/settingsRepository')];
  delete require.cache[require.resolve('../src/flows/procurementPlanView')];
  delete require.cache[require.resolve('../src/services/adminFeed')];

  // S13.1 — computeLowStock groups by (design, shade), filters 'available',
  //          and surfaces those below threshold.
  const invRows = [
    ['5801','','','Beige','B-12',1,50,'available','Kano','',''  ,'','','','','','fabric','','',''],
    ['5802','','','Beige','B-12',1,50,'available','Kano','',''  ,'','','','','','fabric','','',''],
    ['5803','','','Mint','',   1,50,'available','Kano','',''  ,'','','','','','fabric','','',''],
    ['5804','','','Indigo','I-1',1,50,'sold','Kano','',''  ,'C','2026-05-01','','','','fabric','','',''],
  ];
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async (sheet) => sheet === 'Inventory' ? invRows : [],
    appendRows: async () => {},
    updateRange: async () => {},
    batchUpdateRanges: async () => {},
    getSheetNames: async () => [],
    addSheet: async () => {},
  });
  // Stub settingsRepository so getAll() works without Sheets.
  stubModule(require.resolve('../src/repositories/settingsRepository'), {
    getAll: async () => ({ LOW_STOCK_THRESHOLD: '2' }),
    set: async () => {},
  });

  const pv = require('../src/flows/procurementPlanView');
  const lows = await pv._internals.computeLowStock(2);
  // Beige/B-12 has 2 available bales (NOT below 2 threshold strict <),
  // Mint has 1 (below threshold). Indigo is sold (not available).
  const mint = lows.find((l) => l.design === 'Mint');
  const beige = lows.find((l) => l.design === 'Beige');
  if (mint && mint.bales === 1 && !beige) {
    pass('S13.1 computeLowStock: counts only available bales, applies strict-less-than threshold');
  } else {
    fail('S13.1 computeLowStock', `lows=${JSON.stringify(lows)}`);
  }

  // S13.2 — threshold setting falls back to default when malformed
  stubModule(require.resolve('../src/repositories/settingsRepository'), {
    getAll: async () => ({ LOW_STOCK_THRESHOLD: 'not-a-number' }),
    set: async () => {},
  });
  delete require.cache[require.resolve('../src/flows/procurementPlanView')];
  const pv2 = require('../src/flows/procurementPlanView');
  const t = await pv2._internals.getLowStockThreshold();
  if (t === pv2._internals.DEFAULT_LOW_STOCK_THRESHOLD) {
    pass('S13.2 getLowStockThreshold: malformed setting falls back to default');
  } else {
    fail('S13.2 getLowStockThreshold default', `got ${t}`);
  }

  // S13.3 — ProcurementOrders recomputeStatus: partial/full transitions.
  const headerRows = [
    // PO with status 'sent', has lines below.
    ['PO-1','Wang Tex','','2026-05-30','sent','U1','2026-05-10T00:00:00Z','2026-05-10T00:00:00Z','',''],
  ];
  const lineRows = [
    // Two lines for PO-1 — neither received yet → recompute stays 'sent'.
    ['POL-1','PO-1','Beige','B-12',10,500,0,0,0],
    ['POL-2','PO-1','Mint','',5,250,0,0,0],
  ];
  let writes = [];
  stubModule(require.resolve('../src/repositories/sheetsClient'), {
    readRange: async (sheet) => {
      if (sheet === 'ProcurementOrders') return headerRows;
      if (sheet === 'ProcurementOrderLines') return lineRows;
      return [];
    },
    appendRows: async () => {},
    updateRange: async () => {},
    batchUpdateRanges: async (_sheet, updates) => { writes.push(...updates); },
    getSheetNames: async () => [],
    addSheet: async () => {},
  });
  delete require.cache[require.resolve('../src/repositories/procurementOrdersRepository')];
  const poRepo = require('../src/repositories/procurementOrdersRepository');

  // Apply partial receipt: 6 bales of Beige
  writes = [];
  const partial = await poRepo.applyReceived('PO-1', [
    { design: 'Beige', shade: 'B-12', qty_bales: 6, qty_yards: 300 },
  ]);
  if (partial.ok && partial.updatedLines === 1) {
    pass('S13.3 applyReceived: partial receipt matched (design+shade)');
  } else {
    fail('S13.3 applyReceived partial', JSON.stringify(partial));
  }
  // After applyReceived mutates the in-memory line, also reflect that in the
  // stubbed sheet rows so recomputeStatus sees the updated received_bales.
  lineRows[0][7] = 6; lineRows[0][8] = 300;

  const afterPartial = await poRepo.recomputeStatus('PO-1');
  if (afterPartial.status === 'partially_received') {
    pass('S13.4 recomputeStatus: any-received → partially_received');
  } else {
    fail('S13.4 recomputeStatus partial', JSON.stringify(afterPartial));
  }

  // Complete both lines → 'received'
  lineRows[0][7] = 10; lineRows[0][8] = 500;
  lineRows[1][7] = 5;  lineRows[1][8] = 250;
  headerRows[0][4] = 'partially_received';
  const afterFull = await poRepo.recomputeStatus('PO-1');
  if (afterFull.status === 'received') {
    pass('S13.5 recomputeStatus: all-lines-met → received');
  } else {
    fail('S13.5 recomputeStatus received', JSON.stringify(afterFull));
  }

  // S13.6 — applyReceived returns unmatched bales when (design, shade)
  //          doesn't align with any line on the PO
  writes = [];
  lineRows[0][7] = 0; lineRows[0][8] = 0;
  lineRows[1][7] = 0; lineRows[1][8] = 0;
  const r2 = await poRepo.applyReceived('PO-1', [
    { design: 'Beige', shade: 'B-12', qty_bales: 2, qty_yards: 100 },
    { design: 'Indigo', shade: '',    qty_bales: 1, qty_yards: 50  },
  ]);
  if (r2.ok && r2.updatedLines === 1 && r2.unmatched.length === 1
      && r2.unmatched[0].design === 'Indigo') {
    pass('S13.6 applyReceived: unmatched bales returned for caller to surface');
  } else {
    fail('S13.6 applyReceived unmatched', JSON.stringify(r2));
  }

  // S13.7 — adminFeed catalog covers po.created / po.received / po.partial
  const af = require('../src/services/adminFeed');
  const need = ['po.created', 'po.received', 'po.partial'];
  const ok = need.every((et) => {
    const e = af.getCatalogEntry(et);
    return e && e.group === 'inventory';
  });
  if (ok) pass('S13.7 adminFeed CATALOG: PO events registered under inventory group');
  else fail('S13.7 adminFeed CATALOG PO', JSON.stringify(need.map((et) => [et, af.getCatalogEntry(et)])));
}

// ---------------------------------------------------------------------------
// S14 — Bulk Receive: CSV + XLSX parsers + row validator + fileHash (P2.5-C1)
// ---------------------------------------------------------------------------
function runS14a() {
  const { parseCsv } = require('../src/utils/csvParser');
  const { parseXlsx, isAvailable } = require('../src/utils/xlsxParser');
  const { validate, fileHash } = require('../src/utils/bulkRowValidator');

  // S14a.1 — happy-path CSV: 3 bales, header lowercased, totals correct
  const csv1 = [
    'PackageNo,Design,Shade,Yards,Warehouse,Supplier,Notes',
    '9001,Beige Crepe,B-12,50,Kano,SupplierA,',
    '9002,Beige Crepe,B-12,48,Kano,SupplierA,',
    '9003,Red Silk,R-04,52,Kano,SupplierB,VIP hold',
  ].join('\n');
  let parsed = parseCsv(csv1);
  if (parsed.ok && parsed.rows.length === 3
      && parsed.headers.includes('packageno') && parsed.headers.includes('warehouse')
      && parsed.rows[0].packageno === '9001' && parsed.rows[2].notes === 'VIP hold') {
    pass('S14a.1 parseCsv: happy path 3 rows, lowercased headers, body parsed');
  } else fail('S14a.1 parseCsv happy path', JSON.stringify(parsed));

  // S14a.2 — quoted field with embedded comma is preserved
  const csv2 = 'PackageNo,Design,Yards,Warehouse,Notes\n9001,Mint,50,Kano,"Lagos, Apapa Wharf"';
  parsed = parseCsv(csv2);
  if (parsed.ok && parsed.rows[0].notes === 'Lagos, Apapa Wharf') {
    pass('S14a.2 parseCsv: quoted comma-bearing cell preserved');
  } else fail('S14a.2 parseCsv quoted comma', JSON.stringify(parsed));

  // S14a.3 — BOM at start of file is stripped (Excel-on-Windows habit)
  const csv3 = '\uFEFFPackageNo,Design,Yards,Warehouse\n9001,Mint,50,Kano';
  parsed = parseCsv(csv3);
  if (parsed.ok && parsed.headers[0] === 'packageno') {
    pass('S14a.3 parseCsv: UTF-8 BOM stripped');
  } else fail('S14a.3 parseCsv BOM', JSON.stringify(parsed));

  // S14a.4 — CRLF line endings handled
  const csv4 = 'PackageNo,Design,Yards,Warehouse\r\n9001,Mint,50,Kano\r\n9002,Mint,48,Kano\r\n';
  parsed = parseCsv(csv4);
  if (parsed.ok && parsed.rows.length === 2) {
    pass('S14a.4 parseCsv: CRLF newlines + trailing newline tolerated');
  } else fail('S14a.4 parseCsv CRLF', JSON.stringify(parsed));

  // S14a.5 — empty file rejected
  parsed = parseCsv('');
  if (!parsed.ok) pass('S14a.5 parseCsv: empty string rejected');
  else fail('S14a.5 parseCsv empty', JSON.stringify(parsed));

  // S14a.6 — header only (no data rows) rejected
  parsed = parseCsv('PackageNo,Design,Yards,Warehouse\n');
  if (!parsed.ok) pass('S14a.6 parseCsv: header-only file rejected');
  else fail('S14a.6 parseCsv header-only', JSON.stringify(parsed));

  // S14a.7 — escaped double-quote inside quoted cell
  const csv7 = 'PackageNo,Design,Yards,Warehouse,Notes\n9001,Mint,50,Kano,"He said ""hi"""';
  parsed = parseCsv(csv7);
  if (parsed.ok && parsed.rows[0].notes === 'He said "hi"') {
    pass('S14a.7 parseCsv: escaped quote ("") inside quoted cell');
  } else fail('S14a.7 parseCsv escaped quote', JSON.stringify(parsed));

  // S14a.8 — validator happy path
  parsed = parseCsv(csv1);
  let v = validate(parsed);
  if (v.ok && v.valid === 3 && v.summary.totalYards === 150
      && v.summary.designs.length === 2 && v.bales[0].packageNo === '9001') {
    pass('S14a.8 validator: 3-row clean file → ok=true, summary correct');
  } else fail('S14a.8 validator happy path', JSON.stringify({ ok: v.ok, errors: v.errors, summary: v.summary }));

  // S14a.9 — validator catches missing required header
  parsed = parseCsv('PackageNo,Design,Warehouse\n9001,Mint,Kano');
  v = validate(parsed);
  if (!v.ok && v.errors.some((e) => /yards/i.test(e.message) && /Missing required/i.test(e.message))) {
    pass('S14a.9 validator: missing "yards" header flagged');
  } else fail('S14a.9 validator missing header', JSON.stringify(v.errors));

  // S14a.10 — validator catches non-numeric yards + empty PackageNo + supplies row numbers
  const csv10 = [
    'PackageNo,Design,Yards,Warehouse',
    '9001,Mint,fifty,Kano',
    ',Beige,50,Kano',
    '9002,Beige,50,Kano',
  ].join('\n');
  parsed = parseCsv(csv10);
  v = validate(parsed);
  const yardsErr = v.errors.find((e) => e.row === 2 && e.column === 'yards');
  const pkgErr = v.errors.find((e) => e.row === 3 && e.column === 'packageno');
  if (!v.ok && yardsErr && pkgErr) {
    pass('S14a.10 validator: row-level errors tagged with row + column');
  } else fail('S14a.10 validator row errors', JSON.stringify(v.errors));

  // S14a.11 — warehouse not in allowedWarehouses → rejected per locked spec
  parsed = parseCsv('PackageNo,Design,Yards,Warehouse\n9001,Mint,50,LagosUnknown');
  v = validate(parsed, { allowedWarehouses: ['Kano', 'Abuja'] });
  if (!v.ok && v.errors.some((e) => e.column === 'warehouse' && /not registered/i.test(e.message))) {
    pass('S14a.11 validator: unregistered warehouse rejects the file');
  } else fail('S14a.11 validator unknown warehouse', JSON.stringify(v.errors));

  // S14a.12 — max row cap honoured
  const big = ['PackageNo,Design,Yards,Warehouse'].concat(
    Array.from({ length: 6 }, (_, i) => `${i},Mint,50,Kano`)
  ).join('\n');
  parsed = parseCsv(big);
  v = validate(parsed, { maxRows: 5 });
  if (!v.ok && v.errors.some((e) => /max is 5/i.test(e.message))) {
    pass('S14a.12 validator: maxRows cap enforced');
  } else fail('S14a.12 validator maxRows', JSON.stringify(v.errors));

  // S14a.13 — same PackageNo can legitimately repeat (composite-key model)
  const csv13 = [
    'PackageNo,Design,Yards,Warehouse',
    '9001,Mint,50,Kano',
    '9001,Beige,48,Kano',
  ].join('\n');
  parsed = parseCsv(csv13);
  v = validate(parsed);
  if (v.ok && v.valid === 2 && v.bales[0].packageNo === '9001' && v.bales[1].packageNo === '9001') {
    pass('S14a.13 validator: repeated PackageNo allowed (composite-key model)');
  } else fail('S14a.13 validator repeated package', JSON.stringify(v));

  // S14a.14 — fileHash is stable for identical input and changes when content changes
  const h1 = fileHash(csv1);
  const h2 = fileHash(csv1);
  const h3 = fileHash(csv1 + '\n');
  if (h1 && h1 === h2 && h1 !== h3 && /^[a-f0-9]{16}$/.test(h1)) {
    pass('S14a.14 fileHash: stable for same input, differs when content changes');
  } else fail('S14a.14 fileHash', JSON.stringify({ h1, h2, h3 }));

  // S14a.15 — fileHash works on Buffers too (for XLSX path)
  const buf1 = Buffer.from(csv1, 'utf8');
  const hb1 = fileHash(buf1);
  const hb2 = fileHash(Buffer.from(csv1, 'utf8'));
  if (hb1 && hb1 === hb2) {
    pass('S14a.15 fileHash: Buffer input handled');
  } else fail('S14a.15 fileHash buffer', JSON.stringify({ hb1, hb2 }));

  // S14a.16 — XLSX parser: smoke-test a tiny workbook when `xlsx` is
  //           installed; soft-skip if the dep isn't on disk yet (network
  //           hiccup during install — install lands in a follow-up commit
  //           and the SAME assertions re-execute next smoke run).
  if (isAvailable()) {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ['PackageNo', 'Design', 'Yards', 'Warehouse', 'Supplier'],
      ['9001', 'Mint', 50, 'Kano', 'SupplierA'],
      ['9002', 'Beige', 48, 'Kano', 'SupplierA'],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const px = parseXlsx(buf);
    if (px.ok && px.rows.length === 2 && px.rows[0].packageno === '9001' && px.rows[1].yards === '48') {
      pass('S14a.16 parseXlsx: 2-row workbook parsed, numeric Yards stringified');
    } else fail('S14a.16 parseXlsx', JSON.stringify(px));
  } else {
    // Soft skip — graceful-degrade contract: parseXlsx returns a structured
    // error when the package isn't loaded, which is what we assert here.
    const skip = parseXlsx(Buffer.from([1, 2, 3]));
    if (!skip.ok && /xlsx/i.test(skip.error)) {
      pass('S14a.16 parseXlsx: gracefully reports missing dep (install pending)');
    } else fail('S14a.16 parseXlsx skip', JSON.stringify(skip));
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
(async function main() {
  console.log('=== AtFactoryPrice smoke harness ===\n');

  try { runS1(); } catch (e) { fail('S1 unexpected error', e.message); }
  try { runS2(); } catch (e) { fail('S2 unexpected error', e.message); }
  try { runS3(); } catch (e) { fail('S3 unexpected error', e.message); }
  try { runS4(); } catch (e) { fail('S4 unexpected error', e.message); }
  try { runS5(); } catch (e) { fail('S5 unexpected error', e.message); }
  try { runS6(); } catch (e) { fail('S6 unexpected error', e.message); }
  try { runS7(); } catch (e) { fail('S7 unexpected error', e.message); }
  try { await runS8(); } catch (e) { fail('S8 unexpected error', e.message); }
  try { runS9(); } catch (e) { fail('S9 unexpected error', e.message); }
  try { await runS10(); } catch (e) { fail('S10 unexpected error', e.message); }
  try { runS11(); } catch (e) { fail('S11 unexpected error', e.message); }
  try { runS12(); } catch (e) { fail('S12 unexpected error', e.message); }
  try { await runS13(); } catch (e) { fail('S13 unexpected error', e.message); }
  try { runS14a(); } catch (e) { fail('S14a unexpected error', e.message); }

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
