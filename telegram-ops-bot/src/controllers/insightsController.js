'use strict';

/**
 * AGT-1 — GET /api/insights and GET /api/insights/:report.
 *
 * The agent data door: read-only reports over the Railway Postgres (usage,
 * flows, typed lines, the log), for the coding agent. Gated by the agent
 * key alone (`X-Agent-Key` header, or `Authorization: Bearer`) — never the
 * settings key, never a web session, never a query-string key (a key in a
 * URL ends up in logs). There is no write route here.
 *
 * A wrong or missing key is 401 with no detail; ten refusals a minute from
 * one address and the door answers 429 until the minute is over.
 */

const agentKeyService = require('../services/agentKeyService');
const insightsService = require('../services/insightsService');
const logger = require('../utils/logger');

const WINDOW_MS = 60 * 1000;
const MAX_FAILS = 10;
const fails = new Map(); // ip → [timestamps]

function ipOf(req) {
  return String((req.headers && req.headers['x-forwarded-for']) || req.ip || 'unknown').split(',')[0].trim();
}

function tooManyFails(ip, now) {
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(ip, list); else fails.delete(ip);
  return list.length >= MAX_FAILS;
}

function noteFail(ip, now) {
  const list = (fails.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  fails.set(ip, list);
  if (fails.size > 5000) fails.clear(); // a flood never grows the process
}

function presentedKey(req) {
  const h = req.headers || {};
  if (h['x-agent-key']) return String(h['x-agent-key']);
  const m = /^Bearer\s+(.+)$/i.exec(String(h.authorization || ''));
  return m ? m[1] : '';
}

async function authorise(req, res) {
  const ip = ipOf(req);
  const now = Date.now();
  if (tooManyFails(ip, now)) {
    res.status(429).json({ ok: false, error: 'Too many refused requests. Wait a minute.' });
    return false;
  }
  const ok = await agentKeyService.verify(presentedKey(req));
  if (!ok) {
    noteFail(ip, now);
    res.status(401).json({ ok: false, error: 'A valid agent key is required.' });
    return false;
  }
  return true;
}

async function getIndex(req, res) {
  if (!(await authorise(req, res))) return;
  res.json({
    ok: true,
    reports: insightsService.REPORT_NAMES,
    tables: Object.keys(insightsService.TABLES),
    usage: 'GET /api/insights/<report>?days=30 — see specs/AGT-1_AGENT_DATA_DOOR.md',
  });
}

async function getReport(req, res) {
  if (!(await authorise(req, res))) return;
  const name = String(req.params.report || '');
  try {
    const data = await insightsService.run(name, req.query || {});
    res.json({ ok: true, report: name, generated_at: new Date().toISOString(), ...data });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) logger.error(`api GET /api/insights/${name}: ${(e && e.message) || e}`);
    res.status(status).json({ ok: false, error: status >= 500 && status !== 503 ? 'The report failed.' : e.message });
  }
}

module.exports = { getIndex, getReport, _internals: { fails } };
