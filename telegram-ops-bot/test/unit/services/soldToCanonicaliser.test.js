'use strict';

/**
 * ISC-1 Phase 2b — the SoldTo canonicalisation planner.
 *
 * The stakes: this plans rewrites of sale history under customer names.
 * So most of these tests are about what the planner REFUSES to do — a
 * variant the register does not already tie to the canonical customer
 * blocks the whole cluster (merge first, rewrite second), a canonical that
 * is not one live customer blocks it, and a spelling nobody ruled on is
 * reported, never rewritten.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const customerEntity = require(path.join(SRC, 'services/customerEntity'));
const canon = require(path.join(SRC, 'services/soldToCanonicaliser'));

const { buildPlan, DEFAULT_CLUSTERS, REASON_MERGE_FIRST } = canon;

function cust(rowIndex, id, name, status = 'Active', aliases = []) {
  return { rowIndex, customer_id: id, name, status, aliases };
}

function inv(rowIndex, soldTo, status = 'sold') {
  return { rowIndex, soldTo, status, packageNo: String(6000 + rowIndex), design: '44200' };
}

/** The register AFTER Merge Customers has run for both clusters. */
const MERGED_REGISTER = [
  cust(2, 'CUST-A', 'Awunawu', 'Active', ['Awurawu']),
  cust(3, 'CUST-B', 'Awurawu', 'Merged'),
  cust(4, 'CUST-O', 'Alhaja Oshodi', 'Active', ['madam oshodi', 'oshodi madam', 'Oshodi alaja']),
  cust(5, 'CUST-K1', 'Ketu madam'),
  cust(6, 'CUST-K2', 'ketu police Man'),
];

const ROWS = [
  inv(10, 'Awunawu'), inv(11, 'Awunawu'), inv(12, 'Awurawu'), inv(13, 'awunawu'),
  inv(14, 'madam oshodi'), inv(15, 'oshodi madam'), inv(16, 'Oshodi alaja'), inv(17, 'Alhaja oshodi'),
  inv(18, 'Ketu madam'), inv(19, 'ketu police Man'), inv(20, 'CJE'), inv(21, '', 'available'),
];

test('happy path: both default clusters ready, only the changed cells are planned', () => {
  const { clusters, plan } = buildPlan(ROWS, DEFAULT_CLUSTERS, MERGED_REGISTER);
  assert.deepEqual(clusters.map((c) => c.status), ['ready', 'ready']);
  assert.deepEqual(plan.map((p) => `${p.rowIndex}:${p.current}>${p.next}`), [
    '12:Awurawu>Awunawu', '13:awunawu>Awunawu',
    '14:madam oshodi>Alhaja Oshodi', '15:oshodi madam>Alhaja Oshodi',
    '16:Oshodi alaja>Alhaja Oshodi', '17:Alhaja oshodi>Alhaja Oshodi',
  ]);
  assert.ok(plan.every((p) => ['Awunawu', 'Alhaja oshodi'].includes(p.cluster)), 'entries name their cluster');
  assert.ok(!plan.some((p) => /ketu|cje/i.test(p.current)), 'Ketu and CJE are never in the plan');
});

test('the value written is the REGISTRY spelling, not the map\'s', () => {
  // The map says "Alhaja oshodi" (the sheet's spelling); the register says
  // "Alhaja Oshodi". Every cell — including the map's own canonical — is
  // brought to the register's spelling; a cell already there is a no-op
  // that is COUNTED as already canonical, never reported as unruled.
  const rows = [inv(30, 'Alhaja oshodi'), inv(31, 'Alhaja Oshodi'), inv(32, 'madam oshodi')];
  const { clusters, plan } = buildPlan(rows, [DEFAULT_CLUSTERS[1]], MERGED_REGISTER);
  const c = clusters[0];
  assert.equal(c.target.name, 'Alhaja Oshodi');
  assert.deepEqual(plan.map((p) => p.rowIndex), [30, 32]);
  assert.ok(plan.every((p) => p.next === 'Alhaja Oshodi'));
  assert.equal(c.writes, 2);
  assert.equal(c.rows.length, 3, 'the register-spelled cell belongs to the cluster as a no-op');
  assert.deepEqual(c.rows.find((r) => r.rowIndex === 31), { rowIndex: 31, current: 'Alhaja Oshodi', next: 'Alhaja Oshodi' });
  assert.equal(c.counts['Alhaja Oshodi'], 1, 'tallied under the register spelling');
  assert.deepEqual(c.unruled, [], 'the register spelling is never "NOT in the ruling"');
});

test('a cell already equal to the canonical spelling is a no-op', () => {
  const rows = [inv(10, 'Awunawu'), inv(11, 'Awunawu')];
  const { clusters, plan } = buildPlan(rows, [DEFAULT_CLUSTERS[0]], MERGED_REGISTER);
  assert.equal(clusters[0].status, 'ready');
  assert.equal(clusters[0].rows.length, 2, 'both cells belong to the cluster');
  assert.equal(clusters[0].writes, 0);
  assert.deepEqual(plan, []);
});

test('case-only variant resolves to the canonical by name and is rewritten', () => {
  const register = [cust(2, 'CUST-A', 'Awunawu')]; // no alias for "awunawu" — name match covers it
  const { clusters, plan } = buildPlan([inv(13, 'awunawu')],
    [{ canonical: 'Awunawu', variants: ['awunawu'] }], register);
  assert.equal(clusters[0].status, 'ready');
  assert.deepEqual(plan, [{ rowIndex: 13, current: 'awunawu', next: 'Awunawu', cluster: 'Awunawu' }]);
});

test('BLOCKED: a variant that resolves to nobody blocks the whole cluster', () => {
  const register = [cust(2, 'CUST-A', 'Awunawu')]; // "Awurawu" was never merged in
  const { clusters, plan } = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], register);
  const c = clusters[0];
  assert.equal(c.status, 'blocked');
  assert.equal(c.reason, REASON_MERGE_FIRST);
  assert.ok(c.problems.some((p) => /variant "Awurawu" resolves to nobody/.test(p)), c.problems.join('\n'));
  assert.deepEqual(plan, [], 'not even the resolvable "awunawu" cell is planned — the cluster is one ruling');
  assert.equal(c.rows.length, 4, 'the affected cells are still listed for the owner');
  assert.ok(c.rows.every((r) => r.next === null));
});

test('BLOCKED: a variant that resolves to ANOTHER customer blocks the cluster', () => {
  const register = [
    cust(2, 'CUST-A', 'Awunawu', 'Active', ['awunawu']),
    cust(3, 'CUST-B', 'Awurawu', 'Active'), // its own live row — a merge decision the bot must not make
  ];
  const { clusters, plan } = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], register);
  assert.equal(clusters[0].status, 'blocked');
  assert.equal(clusters[0].reason, REASON_MERGE_FIRST);
  assert.ok(clusters[0].problems.some((p) => /"Awurawu" resolves to "Awurawu" \(CUST-B, row 3\) — a different customer/.test(p)));
  assert.deepEqual(plan, []);
});

test('BLOCKED: an inactive canonical is not a live customer', () => {
  const register = [cust(2, 'CUST-A', 'Awunawu', 'Inactive', ['Awurawu', 'awunawu'])];
  const { clusters, plan } = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], register);
  assert.equal(clusters[0].status, 'blocked');
  assert.match(clusters[0].reason, /canonical "Awunawu" is not a live customer/);
  assert.ok(clusters[0].problems.some((p) => /row 2 status "Inactive"/.test(p)));
  assert.deepEqual(plan, []);
});

test('BLOCKED: a canonical that names no Customers row, or two live ones', () => {
  const none = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], [cust(2, 'CUST-K1', 'Ketu madam')]);
  assert.equal(none.clusters[0].status, 'blocked');
  assert.match(none.clusters[0].reason, /matches no Customers row by name/);

  const two = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], [
    cust(2, 'CUST-A', 'Awunawu', 'Active', ['Awurawu']),
    cust(9, 'CUST-A2', 'awunawu', 'Active'),
  ]);
  assert.equal(two.clusters[0].status, 'blocked');
  assert.match(two.clusters[0].reason, /matches 2 live Customers rows — ambiguous/);
  assert.deepEqual(two.plan, []);
});

test('BLOCKED: a dead row of the same name ABOVE the live one shadows the canonical', async () => {
  // customerEntity.resolve excludes only Merged rows and takes the first
  // name hit in sheet order. Rule (i) alone would pick the one live row and
  // report READY — and every rewritten cell would then resolve to the husk.
  for (const status of ['Inactive', 'Pending', 'Rejected']) {
    const register = [
      cust(2, 'CUST-OLD', 'Alhaja Oshodi', status),
      cust(4, 'CUST-O', 'Alhaja Oshodi', 'Active', ['madam oshodi', 'oshodi madam', 'Oshodi alaja']),
    ];
    const { clusters, plan } = buildPlan(ROWS, [DEFAULT_CLUSTERS[1]], register);
    const c = clusters[0];
    assert.equal(c.status, 'blocked', status);
    assert.equal(c.target, null, status);
    assert.match(c.reason, /canonical "Alhaja oshodi" is shadowed by Customers row 2 \(status "(Inactive|Pending|Rejected)"\)/);
    assert.ok(c.problems.some((p) => /resolves "Alhaja oshodi" to "Alhaja Oshodi" \(CUST-OLD, row 2\), not to row 4/.test(p)), c.problems.join('\n'));
    assert.deepEqual(plan, [], status);
    assert.equal(c.rows.length, 4, 'the waiting cells are still listed');

    // Why: the real resolver would attribute the rewritten spelling to the husk.
    const original = customersRepository.getAll;
    customersRepository.getAll = async () => register.map((r) => ({ ...r }));
    try {
      assert.equal((await customerEntity.resolve({ name: 'madam oshodi' })).customer_id, 'CUST-O', 'before the rewrite');
      assert.equal((await customerEntity.resolve({ name: 'Alhaja Oshodi' })).customer_id, 'CUST-OLD', 'after it — the trap');
    } finally {
      customersRepository.getAll = original;
    }
  }
});

test('a dead row of the same name BELOW the live one does not shadow it', () => {
  // Sheet order decides: the live row wins the name match, so the bot
  // already attributes the spelling correctly and the rewrite is safe.
  const register = [
    cust(4, 'CUST-O', 'Alhaja Oshodi', 'Active', ['madam oshodi', 'oshodi madam', 'Oshodi alaja']),
    cust(9, 'CUST-OLD', 'Alhaja Oshodi', 'Inactive'),
  ];
  const { clusters, plan } = buildPlan(ROWS, [DEFAULT_CLUSTERS[1]], register);
  assert.equal(clusters[0].status, 'ready');
  assert.equal(clusters[0].target.customer_id, 'CUST-O');
  assert.equal(plan.length, 4);
});

test('a merged husk carrying the canonical name does not make it ambiguous', () => {
  // After a merge the typo row keeps its old name with status Merged — the
  // live row is still exactly one.
  const register = [
    cust(2, 'CUST-A', 'Awunawu', 'Active', ['Awurawu', 'awunawu']),
    cust(7, 'CUST-A0', 'awunawu', 'Merged'),
  ];
  const { clusters } = buildPlan(ROWS, [DEFAULT_CLUSTERS[0]], register);
  assert.equal(clusters[0].status, 'ready');
  assert.equal(clusters[0].target.customer_id, 'CUST-A');
});

test('a casing nobody ruled on is reported under unruled and never planned', () => {
  const rows = [inv(40, 'AWURAWU'), inv(41, 'Awurawu'), inv(42, ' Awurawu ')];
  const { clusters, plan } = buildPlan(rows, [DEFAULT_CLUSTERS[0]], MERGED_REGISTER);
  assert.deepEqual(clusters[0].unruled, [{ rowIndex: 40, current: 'AWURAWU' }]);
  assert.deepEqual(plan.map((p) => p.rowIndex), [41, 42], 'trimmed exact matches are planned; the unruled casing is not');
});

test('the default map is R1 + R2 only — no Ketu cluster', () => {
  const spellings = DEFAULT_CLUSTERS.flatMap((c) => [c.canonical, ...c.variants]).map((s) => s.toLowerCase());
  assert.ok(!spellings.some((s) => s.includes('ketu')), 'R3 is ruled TWO people');
  assert.deepEqual(DEFAULT_CLUSTERS.map((c) => c.canonical), ['Awunawu', 'Alhaja oshodi']);
  assert.deepEqual(DEFAULT_CLUSTERS[0].variants, ['Awurawu', 'awunawu']);
  assert.deepEqual(DEFAULT_CLUSTERS[1].variants, ['madam oshodi', 'oshodi madam', 'Oshodi alaja']);
  const { plan } = buildPlan(ROWS, DEFAULT_CLUSTERS, MERGED_REGISTER);
  assert.ok(!plan.some((p) => /ketu/i.test(p.current)));
});

test('a custom map containing Ketu is honoured exactly as given', () => {
  // The planner hard-codes no exclusions: an explicit ruling later needs
  // no code change. Here the register already ties the two spellings
  // together, so the cluster is ready.
  const register = [cust(5, 'CUST-K1', 'Ketu madam', 'Active', ['ketu police Man'])];
  const { clusters, plan } = buildPlan(ROWS,
    [{ canonical: 'Ketu madam', variants: ['ketu police Man'] }], register);
  assert.equal(clusters[0].status, 'ready');
  assert.deepEqual(plan, [{ rowIndex: 19, current: 'ketu police Man', next: 'Ketu madam', cluster: 'Ketu madam' }]);
});

test('a malformed map is refused, not guessed at', () => {
  assert.throws(() => buildPlan(ROWS, [], MERGED_REGISTER), /non-empty array/);
  assert.throws(() => buildPlan(ROWS, [{ canonical: '', variants: ['x'] }], MERGED_REGISTER), /canonical must be/);
  assert.throws(() => buildPlan(ROWS, [{ canonical: 'A', variants: [] }], MERGED_REGISTER), /variants must be/);
  assert.throws(() => buildPlan(ROWS, [
    { canonical: 'Awunawu', variants: ['Awurawu'] },
    { canonical: 'Alhaja oshodi', variants: ['awurawu'] },
  ], MERGED_REGISTER), /appears in two clusters/);
});

test('the planner\'s name resolution mirrors customerEntity.resolve exactly', async () => {
  // Pinned so the two rules can never drift apart silently: the same
  // register, every spelling in play, identical answers.
  const register = [
    cust(2, 'CUST-A', 'Awunawu', 'Active', ['Awurawu']),
    cust(3, 'CUST-B', 'Awurawu', 'Merged'),
    cust(4, 'CUST-O', 'Alhaja Oshodi', 'Active', ['madam oshodi']),
    cust(5, 'CUST-K1', 'Ketu madam', 'Inactive'),
    cust(6, 'CUST-X', 'oshodi madam', 'Active'),
  ];
  const original = customersRepository.getAll;
  customersRepository.getAll = async () => register.map((r) => ({ ...r }));
  try {
    for (const name of ['Awunawu', 'awurawu', 'Alhaja oshodi', 'MADAM OSHODI', 'oshodi madam',
      'Oshodi alaja', 'ketu madam', 'nobody', '']) {
      const mine = canon._internals.resolveName(register, name);
      const theirs = await customerEntity.resolve({ name });
      assert.equal(mine ? mine.customer_id : null, theirs ? theirs.customer_id : null, `"${name}"`);
    }
  } finally {
    customersRepository.getAll = original;
  }
});
