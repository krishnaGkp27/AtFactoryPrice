#!/usr/bin/env node
/**
 * Set (upsert) a single Railway service variable for the bot deployment.
 *
 *   RAILWAY_API_TOKEN=… node scripts/railway-set-var.js NAME VALUE
 *
 * Used by ops sessions to flip deploy-time toggles (e.g. OCR_PROVIDER)
 * without opening the Railway dashboard. Railway redeploys the service on
 * variable change. IDs default to the production bot service; override
 * with RAILWAY_PROJECT_ID / RAILWAY_ENVIRONMENT_ID / RAILWAY_SERVICE_ID.
 */

'use strict';

const PROJECT = process.env.RAILWAY_PROJECT_ID || '248c26c2-c0a9-4363-87d6-05ba51414290';
const ENV = process.env.RAILWAY_ENVIRONMENT_ID || 'c46748aa-51a3-419a-a561-750d1ec8c97e';
const SERVICE = process.env.RAILWAY_SERVICE_ID || 'b4ff8ed6-aa4a-416e-8ccf-065c7c1a4aeb';

async function main() {
  const [name, value] = process.argv.slice(2);
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN is not set');
  if (!name || value === undefined) throw new Error('Usage: railway-set-var.js NAME VALUE');

  const query = `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`;
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { input: { projectId: PROJECT, environmentId: ENV, serviceId: SERVICE, name, value } },
    }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  console.log(`OK: ${name} set on service ${SERVICE.slice(0, 8)}… (Railway will redeploy)`);
}

main().catch((e) => { console.error(`FAILED: ${e.message}`); process.exit(1); });
