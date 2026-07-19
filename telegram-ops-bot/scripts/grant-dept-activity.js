#!/usr/bin/env node
/**
 * Ops helper — append an activity code to a department's allowed_activities
 * in the PRODUCTION Departments sheet (idempotent; audit-logged).
 *
 *   RAILWAY_API_TOKEN=… node scripts/grant-dept-activity.js <deptNameMatch> <activityCode>
 *   e.g. node scripts/grant-dept-activity.js warehouse warehouse_audit
 *
 * Pulls GOOGLE_SHEET_ID + GOOGLE_CREDENTIALS_JSON from the Railway service
 * variables (same pattern as onboard-employee.js sessions) so no secrets
 * live on disk.
 */

'use strict';

const PROJECT = process.env.RAILWAY_PROJECT_ID || '248c26c2-c0a9-4363-87d6-05ba51414290';
const ENV = process.env.RAILWAY_ENVIRONMENT_ID || 'c46748aa-51a3-419a-a561-750d1ec8c97e';
const SERVICE = process.env.RAILWAY_SERVICE_ID || 'b4ff8ed6-aa4a-416e-8ccf-065c7c1a4aeb';

async function main() {
  const [match, activity] = process.argv.slice(2);
  if (!match || !activity) throw new Error('Usage: grant-dept-activity.js <deptNameMatch> <activityCode>');
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN is not set');

  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query { variables(projectId: "${PROJECT}", environmentId: "${ENV}", serviceId: "${SERVICE}") }`,
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  process.env.GOOGLE_SHEET_ID = body.data.variables.GOOGLE_SHEET_ID;
  process.env.GOOGLE_CREDENTIALS_JSON = body.data.variables.GOOGLE_CREDENTIALS_JSON;

  const departmentsRepository = require('../src/repositories/departmentsRepository');
  const auditLogRepository = require('../src/repositories/auditLogRepository');
  const all = await departmentsRepository.getAll();
  console.log('Departments:', all.map((d) => `${d.dept_id}:${d.dept_name}[${d.allowed_activities.join(',')}]`).join('\n  '));
  const dept = all.find((d) => d.dept_name.toLowerCase().includes(match.toLowerCase()));
  if (!dept) throw new Error(`No department name contains "${match}"`);
  if (dept.allowed_activities.includes(activity)) {
    console.log(`OK (no-op): ${dept.dept_name} already has ${activity}`);
    return;
  }
  const next = [...dept.allowed_activities, activity];
  await departmentsRepository.updateActivities(dept.dept_id, next);
  await auditLogRepository.append('dept_activity_granted',
    { dept_id: dept.dept_id, dept_name: dept.dept_name, activity }, 'ops-script');
  console.log(`OK: ${dept.dept_name} allowed_activities → ${next.join(',')}`);
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
