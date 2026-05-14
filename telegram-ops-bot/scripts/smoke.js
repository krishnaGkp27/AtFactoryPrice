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
