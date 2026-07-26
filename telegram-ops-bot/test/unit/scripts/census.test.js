'use strict';

/**
 * CEN-1 — the feature census.
 *
 * A census you cannot trust is worse than no census: a false "dead" sends
 * you deleting live code, and a detector that reports "none" because it is
 * broken looks identical to a healthy codebase. The first draft of this
 * script made exactly those mistakes — it called src/config/index.js dead
 * (index.js is required by DIRECTORY name) and flagged 25 analytics
 * namespaces that were already covered by a shorter mapped prefix.
 *
 * These tests exist so those two failure modes cannot come back.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/census.js');

function runCensus() {
  const out = execFileSync(process.execPath, [SCRIPT, '--json'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
  });
  return JSON.parse(out);
}

test('census runs with zero credentials and returns every signal', () => {
  const r = runCensus();
  for (const key of ['orphanModules', 'unreachableActivities', 'analyticsBlindSpots', 'unreadSettings']) {
    assert.ok(Array.isArray(r[key]), `${key} must be an array`);
  }
  assert.ok(r.totals.activities > 50, 'the registry was actually read');
  assert.ok(r.totals.sourceFiles > 100, 'the source tree was actually walked');
});

test('an index.js required by its DIRECTORY name is not called dead', () => {
  const r = runCensus();
  assert.ok(!r.orphanModules.includes('src/config/index.js'),
    'src/config/index.js is required everywhere as require("../config")');
  const indexOrphans = r.orphanModules.filter((f) => f.endsWith('index.js'));
  assert.deepEqual(indexOrphans, [],
    `index.js modules resolve by directory name, got: ${indexOrphans}`);
});

test('the orphan detector still catches a genuinely unreferenced module', () => {
  const probe = path.join(ROOT, 'src/utils/__censusSelfTest.js');
  fs.writeFileSync(probe, "'use strict';\nmodule.exports = {};\n");
  try {
    const r = runCensus();
    assert.ok(r.orphanModules.includes('src/utils/__censusSelfTest.js'),
      'a silent detector is indistinguishable from a clean codebase — it must still fire');
  } finally {
    fs.unlinkSync(probe);
  }
});

test('every registered tile is reachable — a dead tile is a user-visible bug', () => {
  const r = runCensus();
  assert.deepEqual(r.unreachableActivities, [],
    `tiles with no handler: ${JSON.stringify(r.unreachableActivities, null, 2)}`);
});

test('a namespace covered by a shorter mapped prefix is not reported blind', () => {
  const r = runCensus();
  // usageTracker matches with startsWith(), so 'ac' covers 'acconf:' etc.
  const shadowed = r.analyticsBlindSpots.filter((p) => /^(ac|oc|od|oq|rc|sm|tp|tt|up)/.test(p));
  assert.deepEqual(shadowed, [],
    `these are already carried by a shorter mapped prefix: ${shadowed}`);
});

test('the namespaces shipped in the last two days are now mapped, not "other"', () => {
  const tracker = fs.readFileSync(path.join(ROOT, 'src/services/usageTracker.js'), 'utf8');
  for (const p of ['abx:', 'sdd:', 'sdg:', 'sns:', 'sb:']) {
    assert.ok(tracker.includes(`'${p}'`), `${p} must be named in PREFIX_FEATURES`);
  }
});

test('longest-prefix-first matching means sb: cannot shadow sbl:', () => {
  const usageTracker = require(path.join(ROOT, 'src/services/usageTracker'));
  // Guard the ordering invariant directly: 'sbl:' must be tested before
  // 'sb:', or every Customer Supplies tap would be counted as Sell Bale.
  const tracker = fs.readFileSync(path.join(ROOT, 'src/services/usageTracker.js'), 'utf8');
  assert.match(tracker, /sort\(\(a, b\) => b\.length - a\.length\)/,
    'PREFIX_KEYS must stay sorted longest-first');
  assert.ok(usageTracker, 'module loads');
});
