'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  renderConsole,
  renderMarkdown,
  experimentRecord,
  writeExperiment,
  formatScore,
  formatDelta,
  formatRatio,
} = require('../scripts/eval/report');

function makeCellA() {
  return {
    cell: { target: 'claude', model: 'claude-sonnet-5', effort: 'medium' },
    cellId: 'claude:claude-sonnet-5:medium',
    cases: [
      {
        name: 'trigger-ssh-staging-box-restart-api',
        group: 'safety-ssh',
        tags: ['trigger:positive'],
        base: 0.5,
        candidate: 1,
        delta: 0.5,
        baseRuns: 3,
        candidateRuns: 3,
        baseInvalid: 0,
        candidateInvalid: 0,
        regression: false,
      },
      {
        name: 'trigger-unrelated-negative',
        group: 'safety-ssh',
        tags: ['trigger:negative'],
        base: 1,
        candidate: 1,
        delta: 0,
        baseRuns: 3,
        candidateRuns: 3,
        baseInvalid: 0,
        candidateInvalid: 0,
        regression: false,
      },
    ],
    n: 2,
    meanBase: 0.75,
    meanCandidate: 1,
    meanDelta: 0.25,
    ci: { lower: 0.05, upper: 0.45, level: 0.95 },
    passK: { base: 0.5, candidate: 1, k: 2 },
    invalid: { base: 0, candidate: 0, total: 0, share: 0 },
    cost: { base: 0.02, candidate: 0.03, ratio: 1.5 },
    duration: { base: 10, candidate: 12, ratio: 1.2 },
    hardRegression: false,
    triggers: { recall: { base: 0.5, candidate: 1 }, falseTrigger: { base: 0, candidate: 0 } },
  };
}

function makeCellB() {
  return {
    cell: { target: 'copilot', model: 'gpt-5.4', effort: 'medium' },
    cellId: 'copilot:gpt-5.4:medium',
    cases: [
      {
        name: 'behaviour-ado-work-item-lookup',
        group: 'qa-ado-work-item',
        tags: ['behaviour'],
        base: 0.6,
        candidate: 0.6,
        delta: 0,
        baseRuns: 3,
        candidateRuns: 3,
        baseInvalid: 0,
        candidateInvalid: 0,
        regression: false,
      },
    ],
    n: 1,
    meanBase: 0.6,
    meanCandidate: 0.6,
    meanDelta: 0,
    ci: { lower: -0.1, upper: 0.1, level: 0.95 },
    passK: { base: 1, candidate: 1, k: 3 },
    invalid: { base: 0, candidate: 0, total: 0, share: 0 },
    cost: { base: 0.01, candidate: 0.01, ratio: 1 },
    duration: { base: 8, candidate: 8, ratio: 1 },
    hardRegression: false,
    triggers: { recall: { base: 1, candidate: 1 }, falseTrigger: { base: 0, candidate: 0 } },
  };
}

const verdictA = {
  verdict: 'Better',
  reasons: ['delta 0.25 ≥ threshold 0.15'],
  guardrails: ['cost ratio 1.5 ≥ guardrail 1.2'],
};

const verdictB = { verdict: null, error: 'decideVerdict is not implemented yet' };

test('renderConsole renders both cells, the moved case, not the unmoved one, and a fired guardrail', () => {
  const summaries = [makeCellA(), makeCellB()];
  const verdicts = [verdictA, verdictB];
  const cells = [{ target: 'claude', model: 'claude-sonnet-5', effort: 'medium' }];
  const out = renderConsole({ summaries, verdicts, fingerprint: { baseSha: 'abc123', candidateSha: 'def456', cells } });

  // One line per fingerprint entry, and a structured value stays readable instead of [object Object].
  assert.ok(out.includes('  baseSha: abc123'));
  assert.ok(out.includes(`  cells: ${JSON.stringify(cells)}`));
  assert.ok(out.includes('claude:claude-sonnet-5:medium'));
  assert.ok(out.includes('copilot:gpt-5.4:medium'));
  assert.ok(out.includes('Better'));
  assert.ok(out.includes('trigger-ssh-staging-box-restart-api'));
  assert.ok(!out.includes('trigger-unrelated-negative'));
  assert.ok(out.includes('n=2'));
  assert.ok(out.includes('cost ratio 1.5 ≥ guardrail 1.2'));
});

test('renderConsole renders a cell whose verdict could not be decided, without throwing', () => {
  const summaries = [makeCellB()];
  const verdicts = [verdictB];
  const out = renderConsole({ summaries, verdicts, fingerprint: {} });

  assert.ok(out.includes('not decided'));
  assert.ok(out.includes('decideVerdict is not implemented yet'));
  assert.ok(out.includes('n=1'));
});

test('renderMarkdown contains the hypothesis, delta, fingerprint and a table row per moved case', () => {
  const summaries = [makeCellA(), makeCellB()];
  const verdicts = [verdictA, verdictB];
  const now = new Date('2026-09-16T12:00:00Z');
  const record = experimentRecord({
    slug: 'trial-run',
    hypothesis: 'the reworded description improves trigger recall without cost regressions',
    delta: 0.15,
    fingerprint: { baseSha: 'abc123', candidateSha: 'def456' },
    summaries,
    verdicts,
    now,
  });
  const out = renderMarkdown({ experiment: record });

  assert.ok(out.includes('the reworded description improves trigger recall without cost regressions'));
  assert.ok(out.includes('0.15'));
  assert.ok(out.includes('baseSha: abc123'));
  assert.ok(out.includes('| trigger-ssh-staging-box-restart-api | 0.50 | 1.00 | +0.50 |'));
  assert.ok(!out.includes('trigger-unrelated-negative'));
  // no transcripts: never a prompt, a trace path, or raw run output
  assert.ok(!out.includes('promptMarkdown'));
  assert.ok(!out.includes('tracePath'));
  assert.ok(!/i need to ssh/i.test(out));
});

test('experimentRecord is deterministic regardless of input order', () => {
  const now = new Date('2026-09-16T12:00:00Z');
  const base = {
    slug: 'trial-run',
    hypothesis: 'h',
    delta: 0.15,
    fingerprint: { a: 1, b: 2 },
    now,
  };
  const recordAB = experimentRecord({ ...base, summaries: [makeCellA(), makeCellB()], verdicts: [verdictA, verdictB] });
  const recordBA = experimentRecord({ ...base, summaries: [makeCellB(), makeCellA()], verdicts: [verdictB, verdictA] });

  assert.equal(JSON.stringify(recordAB), JSON.stringify(recordBA));
  assert.equal(recordAB.date, '2026-09-16');
});

test('experimentRecord case rows carry exactly the five documented fields', () => {
  const record = experimentRecord({
    slug: 'trial-run',
    hypothesis: 'h',
    delta: 0.15,
    fingerprint: {},
    summaries: [makeCellA()],
    verdicts: [verdictA],
    now: new Date('2026-09-16T12:00:00Z'),
  });
  for (const cell of record.cells) {
    for (const c of cell.cases) {
      assert.deepEqual(Object.keys(c).sort(), ['base', 'candidate', 'delta', 'name', 'regression']);
    }
  }
});

test('experimentRecord records a null verdict for an undecided cell', () => {
  const record = experimentRecord({
    slug: 'trial-run',
    hypothesis: 'h',
    delta: 0.15,
    fingerprint: {},
    summaries: [makeCellB()],
    verdicts: [verdictB],
    now: new Date('2026-09-16T12:00:00Z'),
  });
  assert.equal(record.cells[0].verdict, null);
  assert.ok(record.cells[0].reasons.includes('decideVerdict is not implemented yet'));
});

test('writeExperiment writes to the expected path, round-trips, and refuses to overwrite', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-report-test-'));
  try {
    const record = experimentRecord({
      slug: 'trial-run',
      hypothesis: 'h',
      delta: 0.15,
      fingerprint: { a: 1 },
      summaries: [makeCellA()],
      verdicts: [verdictA],
      now: new Date('2026-09-16T12:00:00Z'),
    });
    const relPath = writeExperiment({ root: tmpRoot, record });
    assert.equal(relPath, path.join('evals', 'experiments', '2026-09-16-trial-run.json'));

    const written = fs.readFileSync(path.join(tmpRoot, relPath), 'utf8');
    assert.ok(written.endsWith('\n'));
    const parsed = JSON.parse(written);
    assert.deepEqual(parsed, record);

    assert.throws(
      () => writeExperiment({ root: tmpRoot, record }),
      (err) => err.message.includes(relPath),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('formatters', () => {
  assert.equal(formatScore(null), '—');
  assert.equal(formatScore(0.5), '0.50');
  assert.equal(formatDelta(null), '—');
  assert.equal(formatDelta(0.2), '+0.20');
  assert.equal(formatDelta(-0.2), '-0.20');
  assert.equal(formatRatio(null), '—');
  assert.equal(formatRatio(1.2), '1.2×');
});
