#!/usr/bin/env node
'use strict';

/**
 * CEN-1 — feature census: what exists, what is reachable, what is used.
 *
 * The owner's question (26-Jul-2026) was two questions wearing one coat:
 *
 *   "which features are used rigorously"   → usage frequency (ANL-1 answers this)
 *   "which code is abandoned so I can      → this script, because usage data
 *    eliminate it"                            ALONE CANNOT ANSWER IT
 *
 * Why usage data alone cannot: a feature nobody touches produces NO ROWS in
 * usage_daily. It does not appear as a zero — it simply is not there. So the
 * very thing you are hunting is the thing the rollups are silent about. The
 * only way to see a zero is to enumerate what SHOULD exist from the code and
 * subtract what the data saw.
 *
 * And silence has three different causes that demand opposite responses:
 *
 *   nobody wants it        → delete
 *   never instrumented     → instrument, then wait
 *   breaks on first tap    → FIX (deleting this would be the real damage)
 *
 * This script separates the first two mechanically. The third needs a human,
 * so unused-but-reachable features are reported as QUESTIONS, never as a
 * kill list — see the caveats printed at the end of every run.
 *
 * Static analysis needs no credentials and no database: "unreachable in
 * code" is a fact you can act on today. The usage join is optional and
 * switches on when DATABASE_URL is set.
 *
 * Usage:
 *   npm run census                 # static only (no credentials needed)
 *   npm run census -- --usage      # + join against usage_daily (needs DATABASE_URL)
 *   npm run census -- --days 90    # usage window (default 30)
 *   npm run census -- --json       # machine-readable
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const args = process.argv.slice(2);
const WANT_USAGE = args.includes('--usage');
const AS_JSON = args.includes('--json');
const DAYS = (() => {
  const i = args.indexOf('--days');
  const n = i >= 0 ? parseInt(args[i + 1], 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/* ── file walking ──────────────────────────────────────────────────────── */

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const SRC_FILES = walk(SRC);
const ENTRY_FILES = [path.join(ROOT, 'server.js')].filter((f) => fs.existsSync(f));
const SCRIPT_FILES = fs.existsSync(path.join(ROOT, 'scripts'))
  ? walk(path.join(ROOT, 'scripts')) : [];
const TEST_FILES = fs.existsSync(path.join(ROOT, 'test'))
  ? walk(path.join(ROOT, 'test')) : [];

const escapeRe = (s2) => String(s2).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
// POSIX separators, always. On Windows path.relative returns
// "src\utils\thing.js", while every reader of this JSON — the orphan
// self-test included — matches on "src/utils/thing.js". The detector was
// firing correctly and being read as silent: precisely the failure mode
// this script exists to rule out, reintroduced by a path separator.
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/** Every source text that could reference a module, keyed by path. */
const ALL_TEXT = new Map();
for (const f of [...SRC_FILES, ...ENTRY_FILES, ...SCRIPT_FILES, ...TEST_FILES]) {
  ALL_TEXT.set(f, read(f));
}

/* ── signal 1: modules nothing requires ────────────────────────────────── */

/**
 * A module is referenced if any OTHER file mentions its basename in a
 * require(). Deliberately loose (basename, not resolved path): a false
 * "referenced" is harmless, a false "orphan" would send you deleting live
 * code, so the bias is toward silence.
 */
function orphanModules() {
  const orphans = [];
  for (const f of SRC_FILES) {
    const base = path.basename(f, '.js');
    // An index.js is required by its DIRECTORY name, never its basename —
    // missing this reported src/config/index.js as dead code, which it
    // emphatically is not.
    const names = base === 'index'
      ? [path.basename(path.dirname(f)), 'index']
      : [base];
    let referenced = false;
    for (const [other, text] of ALL_TEXT) {
      if (other === f) continue;
      if (names.some((n) => new RegExp(`require\\([^)]*['"\`][^'"\`]*\\b${n}(\\.js)?['"\`]`).test(text))) {
        referenced = true;
        break;
      }
    }
    if (!referenced) orphans.push(rel(f));
  }
  return orphans.sort();
}

/* ── signal 2: registry activities with no dispatch ────────────────────── */

/**
 * Every tile in the registry promises a destination. If nothing in the
 * controller (or a flow route table) handles its callback, tapping it is a
 * dead end — a user-visible bug, not merely dead code.
 */
function unreachableActivities() {
  const registry = require(path.join(SRC, 'services/activityRegistry'));
  const controller = read(path.join(SRC, 'controllers/telegramController.js'));
  const flowText = SRC_FILES
    .filter((f) => f.includes(`${path.sep}flows${path.sep}`))
    .map((f) => ALL_TEXT.get(f) || '').join('\n');
  const haystack = `${controller}\n${flowText}`;

  const rows = [];
  for (const a of registry.getAll()) {
    const cb = a.callback || '';
    const code = a.code;
    // act:<suffix> is dispatched by `switch (actCode)` on the SUFFIX, which
    // is often NOT the activity code (act:manage_wh -> code
    // manage_warehouses). Matching the code here produced false alarms.
    const suffix = cb.startsWith('act:') ? cb.slice(4) : '';
    // Non-act callbacks (e.g. umg:start:promote) are routed by their
    // namespace prefix into a flow module.
    const nsPrefix = !suffix && cb.includes(':') ? `${cb.split(':')[0]}:` : '';

    const hit = (suffix && new RegExp(`case\\s*['"\`]${escapeRe(suffix)}['"\`]`).test(haystack))
      || haystack.includes(`'${cb}'`)
      || haystack.includes(`"${cb}"`)
      || (nsPrefix && haystack.includes(`'${nsPrefix}'`))
      || new RegExp(`case\\s*['"\`]${escapeRe(code)}['"\`]`).test(haystack);
    if (!hit) rows.push({ code, label: a.label, hub: a.hub || '(top level)', callback: cb });
  }
  return rows;
}

/* ── signal 3: analytics blind spots ───────────────────────────────────── */

/**
 * Callback namespaces the controller dispatches but the usage tracker does
 * not name. These are not dead — they are INVISIBLE, which is worse for this
 * exercise: they look unused in the data while being used daily.
 */
function analyticsBlindSpots() {
  const controller = read(path.join(SRC, 'controllers/telegramController.js'));
  const tracker = read(path.join(SRC, 'services/usageTracker.js'));
  const mapBlock = (tracker.match(/const PREFIX_FEATURES = \{[\s\S]*?\n\};/) || [''])[0];

  // Must be a CALLBACK dispatch specifically. A bare startsWith() also
  // matches session-step tests like cnStep.startsWith('add_'), which are not
  // callback namespaces at all — that produced two phantom blind spots.
  const dispatched = new Set();
  for (const m of controller.matchAll(/\bdata\.startsWith\(\s*['"`]([a-zA-Z_]{2,12}[:_])['"`]\s*\)/g)) {
    dispatched.add(m[1]);
  }
  // usageTracker matches with startsWith(), so a dispatched namespace is
  // covered when ANY mapped prefix is a prefix of it — 'acconf:' is already
  // carried by 'ac'. Without this the report drowned in false alarms.
  const mapped = [...mapBlock.matchAll(/'([^']+)':/g)].map((m) => m[1]);
  const missing = [];
  for (const p of [...dispatched].sort()) {
    if (p.startsWith('act:') || p.startsWith('__')) continue; // classified generically
    if (!mapped.some((m) => p.startsWith(m))) missing.push(p);
  }
  return missing;
}

/* ── signal 4: Settings defaults nothing reads ─────────────────────────── */

function unreadSettings() {
  const settingsRepo = require(path.join(SRC, 'repositories/settingsRepository'));
  const keys = Object.keys(settingsRepo.DEFAULTS || {});
  const haystack = [...ALL_TEXT.entries()]
    .filter(([f]) => !f.endsWith(`repositories${path.sep}settingsRepository.js`))
    .map(([, t]) => t).join('\n');
  return keys.filter((k) => !haystack.includes(k)).sort();
}

/* ── the usage join (optional) ─────────────────────────────────────────── */

/**
 * Join the code-derived inventory against measured usage. Features present
 * in the registry but absent from usage_daily are the ones the rollups can
 * never show you on their own.
 */
async function usageByFeature() {
  if (!process.env.DATABASE_URL) {
    return { ok: false, reason: 'DATABASE_URL is not set' };
  }
  let pool;
  try {
    pool = require(path.join(SRC, 'db/postgresPool'));
    const res = await pool.query(
      `SELECT feature, SUM(starts) AS starts, SUM(completions) AS completions,
              MAX(unique_users) AS peak_users
         FROM usage_daily
        WHERE day >= CURRENT_DATE - $1::int AND role = '*'
        GROUP BY feature`,
      [DAYS],
    );
    const map = new Map();
    for (const r of res.rows || []) {
      map.set(String(r.feature), {
        starts: Number(r.starts) || 0,
        completions: Number(r.completions) || 0,
        peakUsers: Number(r.peak_users) || 0,
      });
    }
    return { ok: true, map };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/* ── report ────────────────────────────────────────────────────────────── */

function bar(n, max) {
  if (!max) return '';
  const w = Math.max(1, Math.round((n / max) * 24));
  return '█'.repeat(w);
}

async function main() {
  const registry = require(path.join(SRC, 'services/activityRegistry'));
  const activities = registry.getAll();

  const result = {
    generatedFor: `${DAYS} days`,
    totals: { activities: activities.length, sourceFiles: SRC_FILES.length },
    orphanModules: orphanModules(),
    unreachableActivities: unreachableActivities(),
    analyticsBlindSpots: analyticsBlindSpots(),
    unreadSettings: unreadSettings(),
    usage: null,
  };

  if (WANT_USAGE) {
    const u = await usageByFeature();
    if (u.ok) {
      const used = [];
      const unused = [];
      for (const a of activities) {
        const hit = u.map.get(a.code);
        if (hit && hit.starts > 0) used.push({ code: a.code, label: a.label, ...hit });
        else unused.push({ code: a.code, label: a.label, hub: a.hub || '(top level)' });
      }
      used.sort((x, y) => y.starts - x.starts);
      result.usage = { ok: true, used, unused };
    } else {
      result.usage = { ok: false, reason: u.reason };
    }
  }

  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const L = (s = '') => process.stdout.write(`${s}\n`);
  L();
  L('═══ FEATURE CENSUS ═══');
  L(`${result.totals.activities} registered activities · ${result.totals.sourceFiles} source files`);
  L();

  L('── 1. Unreachable tiles (ACT NOW — a user can tap these and get nothing) ──');
  if (!result.unreachableActivities.length) L('   none — every registered tile has a handler.');
  for (const r of result.unreachableActivities) L(`   ✗ ${r.code}  "${r.label}"  [${r.hub}]  → ${r.callback}`);
  L();

  L('── 2. Modules nothing requires (delete candidates) ──');
  if (!result.orphanModules.length) L('   none — every module is referenced.');
  for (const f of result.orphanModules) L(`   ✗ ${f}`);
  L();

  L('── 3. Analytics blind spots (used daily, but invisible in the data) ──');
  if (!result.analyticsBlindSpots.length) L('   none — every dispatched namespace is named in usageTracker.');
  for (const p of result.analyticsBlindSpots) L(`   ? ${p}   → add to PREFIX_FEATURES or it reads as "other"`);
  L();

  L('── 4. Settings keys nothing reads ──');
  if (!result.unreadSettings.length) L('   none — every default is read somewhere.');
  for (const k of result.unreadSettings) L(`   ✗ ${k}`);
  L();

  if (!WANT_USAGE) {
    L('── 5. Measured usage ── (skipped; pass --usage with DATABASE_URL set)');
    L();
  } else if (!result.usage.ok) {
    L(`── 5. Measured usage ── UNAVAILABLE: ${result.usage.reason}`);
    L('   Static findings above are still valid — they need no database.');
    L();
  } else {
    const { used, unused } = result.usage;
    const max = used.length ? used[0].starts : 0;
    L(`── 5. Most used (last ${DAYS} days) ──`);
    if (!used.length) L('   no usage rows yet — is ANALYTICS_ENABLED=1?');
    for (const u of used.slice(0, 20)) {
      L(`   ${String(u.starts).padStart(6)}  ${bar(u.starts, max).padEnd(24)}  ${u.code}`);
    }
    L();
    L(`── 6. ZERO usage in ${DAYS} days (questions, NOT a kill list) ──`);
    for (const u of unused) L(`   · ${u.code}  "${u.label}"  [${u.hub}]`);
    L();
  }

  L('── How to read this ──');
  L('  Sections 1-2 are FACTS about the code: safe to act on today, no waiting.');
  L('  Section 3 must be fixed BEFORE trusting any zero — an unnamed namespace');
  L('  looks unused while being used daily.');
  if (WANT_USAGE && result.usage && result.usage.ok) {
    L('  Section 6 is the dangerous one. A zero means one of three things:');
    L('    nobody wants it (delete) · never instrumented (fix 3 first) ·');
    L('    it BREAKS on first tap (fix it — deleting would be the real loss).');
    L('  Rare-but-critical paths (reverts, backups, audits, year-end) live here');
    L('  legitimately. Confirm intent before deleting anything from section 6.');
  }
  L();
}

main().then(
  () => process.exit(0),
  (e) => { process.stderr.write(`census failed: ${e.stack || e.message}\n`); process.exit(1); },
);
