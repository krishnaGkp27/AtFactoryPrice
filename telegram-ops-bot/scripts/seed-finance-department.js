#!/usr/bin/env node
'use strict';
/**
 * FIN-V2 (owner, 07-Oct-2026) — add the `Finance` department to the
 * Departments sheet with `payments` as its only allowed activity, so the
 * person in Railway FINANCE_IDS gets a payment-only menu: the 💰 Finance hub
 * with 💳 Payments (and its "Waiting for me to pay" queue) — nothing else
 * from this department. A person who ALSO belongs to another department
 * keeps that department's tiles (the menu is the union; owner: "if the
 * person has some more allowed activities, let it be like that").
 *
 * The same row is the PAY-1 fallback seat (the single Users row in
 * department Finance receives the finance card when FINANCE_IDS is blank).
 *
 * SAFETY: dry-run by default; only --commit writes. Idempotent — an existing
 * Finance row is reported and left exactly as it is (edit it in-bot via
 * 👥 Human Resources → 🏢 Manage Departments if its CSV should change).
 *
 *   node scripts/seed-finance-department.js             # show what would happen
 *   node scripts/seed-finance-department.js --commit    # append the row
 *
 * Then: Users sheet → the finance person's `department` cell = Finance.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const departmentsRepo = require('../src/repositories/departmentsRepository');

const NAME = 'Finance';
const ACTIVITIES = ['payments'];

async function main() {
  const commit = process.argv.includes('--commit');
  const existing = await departmentsRepo.findByName(NAME);
  if (existing) {
    console.log(`Departments already has "${existing.dept_name}" (${existing.dept_id}, row ${existing.rowIndex}) — allowed_activities: [${existing.allowed_activities.join(', ')}]. Nothing to do.`);
    return;
  }
  console.log(`Would append: dept_id D-FINANCE · dept_name ${NAME} · allowed_activities ${ACTIVITIES.join(',')} · status active`);
  if (!commit) { console.log('Dry run — re-run with --commit to write it.'); return; }
  const row = await departmentsRepo.ensureDept({ dept_name: NAME, allowed_activities: ACTIVITIES });
  console.log(`Appended ${row.dept_name} (${row.dept_id}) at row ${row.rowIndex}. Now set the finance person's Users.department to ${NAME}.`);
}

main().catch((e) => { console.error(`seed-finance-department failed: ${e.message}`); process.exit(1); });
