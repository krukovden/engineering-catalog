'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeRng, cellSeed, mean, median, caseRows, bootstrapCI, ciLevel, summariseCell, decideVerdict,
} = require('../scripts/eval/stats');

const CELL = { target: 'claude', model: 'claude-haiku-4-5', effort: 'low' };

/** A minimal RunRecord — only the fields a given test cares about need overriding. */
const rec = (over) => ({
  cell: CELL, arm: 'base', caseName: 'c', group: 'g', tags: [], run: 0,
  score: 1, passed: true, graders: [], turns: 1, costUsd: 0.1, durationSeconds: 10,
  startedAt: '2026-09-16T00:00:00.000Z', error: null, invalid: null,
  ...over,
});

test('makeRng: the same seed gives an identical first-ten sequence', () => {
  const draw = (seed) => {
    const rng = makeRng(seed);
    return Array.from({ length: 10 }, () => rng());
  };
  assert.deepEqual(draw(1), draw(1));
});

test('makeRng: two different seeds diverge', () => {
  const rngA = makeRng(1);
  const rngB = makeRng(2);
  const seqA = Array.from({ length: 10 }, () => rngA());
  const seqB = Array.from({ length: 10 }, () => rngB());
  assert.notDeepEqual(seqA, seqB);
});

test('makeRng: every value lands in [0, 1)', () => {
  const rng = makeRng(12345);
  for (let i = 0; i < 1000; i += 1) {
    const v = rng();
    assert.ok(v >= 0 && v < 1, `value ${v} out of range`);
  }
});

test('mean and median are null on an empty list', () => {
  assert.equal(mean([]), null);
  assert.equal(median([]), null);
});

test('mean and median compute the ordinary values', () => {
  assert.equal(mean([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('caseRows: averages only the valid runs of each arm', () => {
  const records = [
    rec({ arm: 'base', caseName: 'x', score: 1, invalid: null, run: 0 }),
    rec({ arm: 'base', caseName: 'x', score: 0.5, invalid: null, run: 1 }),
    rec({ arm: 'base', caseName: 'x', score: 0, invalid: { kind: 'rate-limit', reason: 'r' }, run: 2 }),
    rec({ arm: 'candidate', caseName: 'x', score: 1, invalid: null, run: 0 }),
  ];
  const [row] = caseRows({ records });
  assert.equal(row.base, 0.75); // mean of the two valid runs [1, 0.5]; the invalid run is excluded
  assert.equal(row.candidate, 1);
  assert.equal(row.delta, 0.25);
  assert.equal(row.baseRuns, 2);
  assert.equal(row.baseInvalid, 1);
  assert.equal(row.candidateRuns, 1);
  assert.equal(row.candidateInvalid, 0);
});

test('caseRows: an arm with no valid run reports null, not zero', () => {
  const records = [
    rec({ arm: 'base', caseName: 'x', score: 0, invalid: { kind: 'crash', reason: 'r' }, run: 0 }),
    rec({ arm: 'candidate', caseName: 'x', score: 1, invalid: null, run: 0 }),
  ];
  const [row] = caseRows({ records });
  assert.equal(row.base, null);
  assert.equal(row.candidate, 1);
  assert.equal(row.delta, null, 'delta is null when either side is null');
  assert.equal(row.baseInvalid, 1);
  assert.equal(row.baseRuns, 0);
});

test('caseRows: rows come back sorted by case name', () => {
  const records = [
    rec({ caseName: 'zebra', arm: 'base' }), rec({ caseName: 'zebra', arm: 'candidate' }),
    rec({ caseName: 'apple', arm: 'base' }), rec({ caseName: 'apple', arm: 'candidate' }),
  ];
  const rows = caseRows({ records });
  assert.deepEqual(rows.map((r) => r.name), ['apple', 'zebra']);
});

test('caseRows: regression fires only for a regression-tagged case that went all-1.0 base to all-0 candidate', () => {
  const allOneAllZero = (tags, caseName) => [
    rec({ caseName, arm: 'base', tags, score: 1, run: 0 }),
    rec({ caseName, arm: 'base', tags, score: 1, run: 1 }),
    rec({ caseName, arm: 'candidate', tags, score: 0, run: 0 }),
    rec({ caseName, arm: 'candidate', tags, score: 0, run: 1 }),
  ];

  const tagged = caseRows({ records: allOneAllZero(['regression'], 'tagged') })[0];
  assert.equal(tagged.regression, true, 'the actual case: regression-tagged, all-1 base, all-0 candidate');

  const untagged = caseRows({ records: allOneAllZero([], 'untagged') })[0];
  assert.equal(untagged.regression, false, 'near-miss: same score pattern, but no regression tag');

  const baseNotAllOne = caseRows({
    records: [
      rec({ caseName: 'c', arm: 'base', tags: ['regression'], score: 1, run: 0 }),
      rec({ caseName: 'c', arm: 'base', tags: ['regression'], score: 0.5, run: 1 }),
      rec({ caseName: 'c', arm: 'candidate', tags: ['regression'], score: 0, run: 0 }),
      rec({ caseName: 'c', arm: 'candidate', tags: ['regression'], score: 0, run: 1 }),
    ],
  })[0];
  assert.equal(baseNotAllOne.regression, false, 'near-miss: regression tag, all-0 candidate, but base is not all-1');

  const candidateNotAllZero = caseRows({
    records: [
      rec({ caseName: 'c', arm: 'base', tags: ['regression'], score: 1, run: 0 }),
      rec({ caseName: 'c', arm: 'base', tags: ['regression'], score: 1, run: 1 }),
      rec({ caseName: 'c', arm: 'candidate', tags: ['regression'], score: 0, run: 0 }),
      rec({ caseName: 'c', arm: 'candidate', tags: ['regression'], score: 1, run: 1 }),
    ],
  })[0];
  assert.equal(candidateNotAllZero.regression, false, 'near-miss: regression tag, all-1 base, but candidate is not all-0');
});

test('bootstrapCI: fewer than two deltas returns nulls', () => {
  assert.deepEqual(bootstrapCI([], { resamples: 100, level: 0.95, rng: makeRng(1) }), { lower: null, upper: null, level: 0.95 });
  assert.deepEqual(bootstrapCI([0.3], { resamples: 100, level: 0.95, rng: makeRng(1) }), { lower: null, upper: null, level: 0.95 });
});

test('bootstrapCI: a fixed delta list and seed produce exact, pinned bounds', () => {
  // Computed once by running bootstrapCI(deltas, { resamples: 2000, level: 0.95, rng: makeRng(42) })
  // and hard-coded here — this equality IS the reproducibility guarantee.
  const deltas = [0.2, -0.1, 0.5, 0.0, 0.3, -0.2, 0.4, 0.1];
  const ci = bootstrapCI(deltas, { resamples: 2000, level: 0.95, rng: makeRng(42) });
  assert.deepEqual(ci, { lower: -0.012499999999999997, upper: 0.31249999999999994, level: 0.95 });
});

test('bootstrapCI: the interval brackets the sample mean', () => {
  const deltas = [0.2, -0.1, 0.5, 0.0, 0.3, -0.2, 0.4, 0.1];
  const ci = bootstrapCI(deltas, { resamples: 5000, level: 0.95, rng: makeRng(99) });
  const m = mean(deltas);
  assert.ok(ci.lower <= m && m <= ci.upper, `[${ci.lower}, ${ci.upper}] should bracket ${m}`);
});

test('bootstrapCI: reordering the input changes the result under a fixed rng — order is not commutative', () => {
  // The rng draws a fixed sequence of *positions*; reordering the array puts different values
  // at those positions, so the resampled means differ. This is the actual, documented behavior —
  // not a property ("order-independence") the function does not have.
  const deltas = [0.2, -0.1, 0.5, 0.0, 0.3, -0.2, 0.4, 0.1];
  const reversed = [...deltas].reverse();
  const original = bootstrapCI(deltas, { resamples: 5, level: 0.95, rng: makeRng(7) });
  const shuffled = bootstrapCI(reversed, { resamples: 5, level: 0.95, rng: makeRng(7) });
  assert.deepEqual(original, { lower: 0.0625, upper: 0.25, level: 0.95 });
  assert.deepEqual(shuffled, { lower: 0.05, upper: 0.2375, level: 0.95 });
  assert.notDeepEqual(original, shuffled);
});

test('ciLevel: Bonferroni-corrects across the cells of one compare', () => {
  assert.equal(ciLevel(1), 0.95);
  assert.equal(ciLevel(4), 0.9875);
});

test('cellSeed: pure, stable, and differs between cell ids', () => {
  const a1 = cellSeed(123, 'claude:m:low');
  const a2 = cellSeed(123, 'claude:m:low');
  const b = cellSeed(123, 'copilot:m:low');
  assert.equal(a1, a2, 'same inputs -> same output every time (pure)');
  assert.notEqual(a1, b, 'different cell ids -> different seeds');
  assert.equal(typeof a1, 'number');
  assert.ok(Number.isInteger(a1));
});

test('summariseCell: produces every contract field with the expected numbers', () => {
  const mk = ({ arm, caseName, group, tags, run, score, passed, cost, duration, invalid = null }) => ({
    cell: CELL, arm, caseName, group, tags, run, score, passed,
    graders: [], turns: 1, costUsd: cost, durationSeconds: duration,
    startedAt: '2026-09-16T00:00:00.000Z', error: null, invalid,
  });

  const records = [
    // case-a: trigger:positive. base perfect, candidate half.
    mk({ arm: 'base', caseName: 'case-a', group: 'grp', tags: ['trigger:positive'], run: 0, score: 1, passed: true, cost: 0.10, duration: 10 }),
    mk({ arm: 'base', caseName: 'case-a', group: 'grp', tags: ['trigger:positive'], run: 1, score: 1, passed: true, cost: 0.20, duration: 20 }),
    mk({ arm: 'candidate', caseName: 'case-a', group: 'grp', tags: ['trigger:positive'], run: 0, score: 0, passed: false, cost: 0.15, duration: 12 }),
    mk({ arm: 'candidate', caseName: 'case-a', group: 'grp', tags: ['trigger:positive'], run: 1, score: 1, passed: true, cost: 0.25, duration: 22 }),

    // case-b: trigger:negative. base correctly silent, candidate half false-triggers.
    mk({ arm: 'base', caseName: 'case-b', group: 'grp', tags: ['trigger:negative'], run: 0, score: 1, passed: true, cost: 0.05, duration: 5 }),
    mk({ arm: 'base', caseName: 'case-b', group: 'grp', tags: ['trigger:negative'], run: 1, score: 1, passed: true, cost: 0.07, duration: 6 }),
    mk({ arm: 'candidate', caseName: 'case-b', group: 'grp', tags: ['trigger:negative'], run: 0, score: 0, passed: false, cost: 0.09, duration: 9 }),
    mk({ arm: 'candidate', caseName: 'case-b', group: 'grp', tags: ['trigger:negative'], run: 1, score: 1, passed: true, cost: 0.11, duration: 10 }),

    // case-c: regression tag, base all-1, candidate all-0 -> the one unambiguous drop.
    mk({ arm: 'base', caseName: 'case-c', group: 'grp2', tags: ['regression'], run: 0, score: 1, passed: true, cost: 0.30, duration: 30 }),
    mk({ arm: 'base', caseName: 'case-c', group: 'grp2', tags: ['regression'], run: 1, score: 1, passed: true, cost: 0.32, duration: 31 }),
    mk({ arm: 'candidate', caseName: 'case-c', group: 'grp2', tags: ['regression'], run: 0, score: 0, passed: false, cost: 0.40, duration: 40 }),
    mk({ arm: 'candidate', caseName: 'case-c', group: 'grp2', tags: ['regression'], run: 1, score: 0, passed: false, cost: 0.42, duration: 41 }),

    // case-d: untagged, one invalid base run that must not count toward the base mean.
    mk({ arm: 'base', caseName: 'case-d', group: 'grp2', tags: [], run: 0, score: 0.5, passed: false, cost: 0.50, duration: 50 }),
    mk({ arm: 'base', caseName: 'case-d', group: 'grp2', tags: [], run: 1, score: 0.5, passed: false, cost: 0.52, duration: 51 }),
    mk({
      arm: 'base', caseName: 'case-d', group: 'grp2', tags: [], run: 2, score: 0, passed: false, cost: 0.99, duration: 99,
      invalid: { kind: 'rate-limit', reason: 'x' },
    }),
    mk({ arm: 'candidate', caseName: 'case-d', group: 'grp2', tags: [], run: 0, score: 1, passed: true, cost: 0.60, duration: 60 }),
    mk({ arm: 'candidate', caseName: 'case-d', group: 'grp2', tags: [], run: 1, score: 1, passed: true, cost: 0.62, duration: 61 }),
  ];

  const config = {
    verdict: { seed: 20260916, bootstrapResamples: 2000, delta: 0.15, minCases: 10, maxInvalidShare: 0.1 },
    guardrails: { costRatio: 1.2, durationRatio: 1.2 },
  };

  const summary = summariseCell({ cell: CELL, records, cases: [], config, cellCount: 1 });

  assert.equal(summary.cellId, 'claude:claude-haiku-4-5:low');
  assert.equal(summary.cases.length, 4);
  assert.equal(summary.n, 4);
  assert.equal(summary.meanBase, 0.875);
  assert.equal(summary.meanCandidate, 0.5);
  assert.equal(summary.meanDelta, -0.375);

  // Pinned: computed once from summariseCell with this exact record set, config and cellCount.
  assert.deepEqual(summary.ci, { lower: -0.875, upper: 0.25, level: 0.95 });

  // passK: k is the minimum valid-run count backing the share (every case here has 2 valid runs).
  assert.deepEqual(summary.passK, { base: 0.75, candidate: 0.25, k: 2 });

  // invalid: one invalid run out of 9 base + 8 candidate = 17 total.
  assert.deepEqual(summary.invalid, { base: 1, candidate: 0, total: 1, share: 1 / 17 });

  // cost/duration: median of each arm's per-case median.
  assert.equal(summary.cost.base, 0.23);
  assert.ok(Math.abs(summary.cost.candidate - 0.305) < 1e-9);
  assert.ok(Math.abs(summary.cost.ratio - 1.3260869565217392) < 1e-9);
  assert.equal(summary.duration.base, 22.75);
  assert.equal(summary.duration.candidate, 28.75);
  assert.ok(Math.abs(summary.duration.ratio - 1.2637362637362637) < 1e-9);

  assert.equal(summary.hardRegression, true);
  assert.deepEqual(summary.triggers.recall, { base: 1, candidate: 0.5 });
  assert.deepEqual(summary.triggers.falseTrigger, { base: 0, candidate: 0.5 });
});

// --- The rule table decideVerdict satisfies -------------------------------------------------
// Each test pins a CellSummary shape to the verdict the table in stats.js's JSDoc says it
// should get. `cases: []` with `n` below minCases is the "cut short" signal for Invalid — a
// cell that produced zero case rows despite claiming `n` cases never ran anything real, which
// is different from a small but real sample (a `minCases` question, handled further down).

const VERDICT_CONFIG = {
  verdict: { delta: 0.15, minCases: 10, maxInvalidShare: 0.1, bootstrapResamples: 2000, seed: 1 },
  guardrails: { costRatio: 1.2, durationRatio: 1.2 },
};

const buildSummary = (over = {}) => ({
  cell: CELL, cellId: 'claude:claude-haiku-4-5:low', cases: [],
  n: 12, meanBase: 0.8, meanCandidate: 0.8, meanDelta: 0,
  ci: { lower: 0, upper: 0, level: 0.95 },
  passK: { base: 1, candidate: 1, k: 3 },
  invalid: { base: 0, candidate: 0, total: 0, share: 0 },
  cost: { base: 0.1, candidate: 0.1, ratio: 1 },
  duration: { base: 10, candidate: 10, ratio: 1 },
  hardRegression: false,
  triggers: { recall: { base: null, candidate: null }, falseTrigger: { base: null, candidate: null } },
  ...over,
});

test('decideVerdict: invalid share above the ceiling is Invalid', () => {
  const summary = buildSummary({ invalid: { base: 3, candidate: 2, total: 5, share: 0.4 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Invalid');
});

test('decideVerdict: a run cut short below minCases is Invalid', () => {
  const summary = buildSummary({ n: 4 });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Invalid');
});

test('decideVerdict: a hard regression is Worse even with an otherwise favorable CI', () => {
  const summary = buildSummary({ hardRegression: true, ci: { lower: 0.05, upper: 0.3, level: 0.95 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Worse');
});

test('decideVerdict: a CI entirely below zero is Worse', () => {
  const summary = buildSummary({ ci: { lower: -0.4, upper: -0.1, level: 0.95 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Worse');
});

test('decideVerdict: a CI entirely above zero is Better', () => {
  const summary = buildSummary({ ci: { lower: 0.05, upper: 0.4, level: 0.95 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Better');
});

test('decideVerdict: a CI whose lower bound clears -delta is Not worse', () => {
  // delta is 0.15; -0.1 > -0.15
  const summary = buildSummary({ ci: { lower: -0.1, upper: 0.2, level: 0.95 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Not worse');
});

test('decideVerdict: an inconclusive CI is Not proven', () => {
  const summary = buildSummary({ ci: { lower: -0.3, upper: 0.1, level: 0.95 } });
  assert.equal(decideVerdict(summary, VERDICT_CONFIG).verdict, 'Not proven');
});

test('decideVerdict: below minCases only the hard-regression rule applies; a big per-case drop is flagged in reasons', () => {
  const summary = buildSummary({
    n: 3,
    hardRegression: false,
    // ci.upper < 0 would normally mean Worse, but below minCases only hardRegression may — it's
    // false here, so the CI rules must NOT fire and this falls through to Not proven.
    ci: { lower: -0.9, upper: -0.1, level: 0.95 },
    cases: [{
      name: 'case-x', group: 'g', tags: [], base: 1, candidate: 0.2, delta: -0.8,
      baseRuns: 3, candidateRuns: 3, baseInvalid: 0, candidateInvalid: 0, regression: false,
    }],
  });
  const verdict = decideVerdict(summary, VERDICT_CONFIG);
  assert.equal(verdict.verdict, 'Not proven');
  assert.ok(verdict.reasons.some((r) => r.includes('case-x')), 'the >=0.67 per-case drop should be named in reasons');
});

test('decideVerdict: guardrail breaches are reported without changing the verdict', () => {
  const summary = buildSummary({
    ci: { lower: 0.05, upper: 0.3, level: 0.95 }, // -> Better
    cost: { base: 0.1, candidate: 0.2, ratio: 2 }, // exceeds guardrails.costRatio of 1.2
  });
  const verdict = decideVerdict(summary, VERDICT_CONFIG);
  assert.equal(verdict.verdict, 'Better', 'a guardrail breach reports alongside the verdict, it does not change it');
  assert.ok(verdict.guardrails.some((g) => g.includes('cost')));
});
