#!/usr/bin/env node
/**
 * Onboard a new employee in one go: add them to the Users sheet, attach
 * them to a department (creating it if needed), enable the activities
 * you specify, and (optionally) tie them to a warehouse.
 *
 * Usage (CLI flags — order doesn't matter; --activities is optional):
 *
 *   node scripts/onboard-employee.js \
 *     --id=123456789 \
 *     --name="Abdul Ahmed" \
 *     --department=Sales \
 *     --warehouses=Lagos \
 *     --role=employee \
 *     --activities=upload_design_photo,browse_catalog,search_design_photo
 *
 * Behaviour:
 *   1. Re-uses an existing department by case-insensitive name OR creates
 *      one with the given activities if it doesn't exist.
 *   2. If the department already exists, MERGES the requested activities
 *      onto its allowed_activities list (no removals). Idempotent — re-runs
 *      do nothing harmful.
 *   3. If the user already exists, prints what's already on file and
 *      exits without overwriting. Re-run with --force to update their
 *      department / warehouses / role.
 *
 * Requires .env with TELEGRAM_TOKEN + GOOGLE_SHEET_ID + GOOGLE_CREDENTIALS_*.
 */

'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const usersRepo = require('../src/repositories/usersRepository');
const deptsRepo = require('../src/repositories/departmentsRepository');
const sheets = require('../src/repositories/sheetsClient');

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
    else if (arg.startsWith('--')) out[arg.slice(2)] = true;
  }
  return out;
}

function csv(value) {
  if (!value) return [];
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

async function ensureDeptWithActivities(deptName, requestedActivities) {
  let dept = await deptsRepo.findByName(deptName);
  if (!dept) {
    console.log(`[dept] creating "${deptName}" with activities: ${requestedActivities.join(', ') || '(none)'}`);
    await deptsRepo.append({
      dept_id: `DEPT-${deptName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12)}`,
      dept_name: deptName,
      allowed_activities: requestedActivities,
      status: 'active',
    });
    dept = await deptsRepo.findByName(deptName);
    return { dept, didCreate: true, didExtend: false, added: requestedActivities };
  }
  // Department already exists — merge requested activities.
  const have = new Set(dept.allowed_activities || []);
  const added = [];
  for (const a of requestedActivities) {
    if (!have.has(a)) {
      have.add(a);
      added.push(a);
    }
  }
  if (added.length) {
    const newList = [...have];
    console.log(`[dept] extending "${deptName}" with activities: ${added.join(', ')}`);
    await deptsRepo.updateActivities(dept.dept_id, newList);
    return { dept, didCreate: false, didExtend: true, added };
  }
  console.log(`[dept] "${deptName}" already has every requested activity; nothing to extend`);
  return { dept, didCreate: false, didExtend: false, added: [] };
}

async function ensureUser({ id, name, role, branch, accessLevel, departmentName, warehouses, force }) {
  const existing = await usersRepo.findByUserId(id);
  if (existing && !force) {
    console.log(`[user] already on file:`);
    console.log(`         id=${existing.user_id}  name=${existing.name}`);
    console.log(`         role=${existing.role}  status=${existing.status}`);
    console.log(`         departments=[${existing.departments.join(', ') || '-'}]`);
    console.log(`         warehouses=[${existing.warehouses.join(', ') || '-'}]`);
    console.log(`         manages=[${existing.manages.join(', ') || '-'}]`);
    console.log(`         (re-run with --force to update their department / warehouses / role)`);
    return { user: existing, didCreate: false, didUpdate: false };
  }
  if (existing && force) {
    // Update department + warehouses + role in place. Manages left untouched.
    console.log(`[user] FORCE updating existing user ${existing.user_id} (${existing.name})`);
    await usersRepo.updateDepartment(id, departmentName);
    await usersRepo.updateWarehouses(id, warehouses);
    if (role && role !== existing.role) {
      await sheets.updateRange(usersRepo.SHEET, `C${existing.rowIndex}`, [[role]]);
    }
    return { user: { ...existing, role, departments: [departmentName], warehouses }, didCreate: false, didUpdate: true };
  }
  console.log(`[user] appending new row: ${id} (${name})`);
  await usersRepo.append({
    user_id: id,
    name,
    role: role || 'employee',
    branch: branch || (warehouses[0] || ''),
    access_level: accessLevel || 'branch_only',
    status: 'active',
    departments: [departmentName],
    warehouses,
    manages: [],
  });
  const created = await usersRepo.findByUserId(id);
  return { user: created, didCreate: true, didUpdate: false };
}

async function main() {
  const args = parseArgs(process.argv);

  const id = (args.id || '').trim();
  const name = (args.name || '').trim();
  const departmentName = (args.department || args.dept || '').trim();
  const warehouses = csv(args.warehouses || args.wh);
  const activities = csv(args.activities);
  const role = (args.role || 'employee').trim();
  const branch = (args.branch || warehouses[0] || '').trim();
  const accessLevel = (args.access || args.access_level || 'branch_only').trim();
  const force = !!args.force;

  if (!id || !name || !departmentName) {
    console.error('Usage:');
    console.error('  node scripts/onboard-employee.js \\');
    console.error('    --id=<telegramId> --name="<full name>" \\');
    console.error('    --department=<deptName> --warehouses=<csv> \\');
    console.error('    [--role=employee] [--access=branch_only] \\');
    console.error('    [--activities=<csv of activity codes>] [--force]');
    process.exit(2);
  }

  console.log(`\nOnboarding ${name} (id=${id}) into "${departmentName}"…\n`);

  const deptResult = await ensureDeptWithActivities(departmentName, activities);
  const userResult = await ensureUser({ id, name, role, branch, accessLevel, departmentName, warehouses, force });

  console.log('\n=== Summary ===');
  console.log(`Department: ${deptResult.dept.dept_name} (${deptResult.dept.dept_id})`);
  if (deptResult.didCreate) console.log('   created: yes');
  if (deptResult.didExtend) console.log(`   extended with: ${deptResult.added.join(', ')}`);
  console.log(`   activities now: ${(await deptsRepo.findByName(departmentName)).allowed_activities.join(', ')}`);
  console.log(`User: ${userResult.user.name} (${userResult.user.user_id})`);
  console.log(`   created: ${userResult.didCreate ? 'yes' : 'no'}`);
  console.log(`   updated: ${userResult.didUpdate ? 'yes' : 'no'}`);
  console.log(`   department: ${userResult.user.departments.join(', ') || userResult.user.department}`);
  console.log(`   warehouses: ${userResult.user.warehouses.join(', ') || '-'}`);
  console.log('\nDone.\n');
  console.log('Next steps:');
  console.log(`  1. Ask ${name} to open Telegram, find your bot, and send "hi".`);
  console.log('  2. They should see the greeting menu with the activities you enabled.');
  if (activities.includes('upload_design_photo')) {
    console.log('  3. Tap 📷 Catalog → Upload Product Photo to send a photo + design info.');
    console.log('     The upload will land in the 2-admin approval queue automatically.');
  }
}

main().catch((e) => {
  console.error('\n[onboard-employee] FAILED:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
