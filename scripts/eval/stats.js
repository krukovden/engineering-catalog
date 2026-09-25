'use strict';
// Turns run records (one row per agent run, see phase2-contracts.md) into the per-cell
// summary the report layer renders. Pure end to end: no file, process, clock or RNG source
// reaches outside what the caller passes in, so a verdict is exactly reproducible from its
// records and config.
const CELL_ID = (cell) => `${cell.target}:${cell.model}:${cell.effort}`;

/** mulberry32 — four lines, integer state, identical output on every machine and Node version. */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A pure integer hash of a seed and a cell id, so two cells never share a resample sequence. */
function cellSeed(seed, cellId) {
  let hash = seed >>> 0;
  for (let i = 0; i < cellId.length; i += 1) {
    hash = Math.imul(hash ^ cellId.charCodeAt(i), 16777619) >>> 0;
  }
  return hash >>> 0;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const isValid = (r) => r.invalid === null;
const byArm = (records, arm) => records.filter((r) => r.arm === arm);

/** Records for one case, grouped and split into the valid runs each arm actually scored. */
function armScores(records, caseName, arm) {
  return byArm(records, arm).filter((r) => r.caseName === caseName && isValid(r));
}

/**
 * One row per case name seen in `records` — the `cases` array of a `CellSummary`.
 * `cases` (the loaded suite definitions) is consulted only for the canonical group/tags of a
 * case; when absent, the row falls back to what its own runs recorded.
 */
function caseRows({ records, cases = [] }) {
  const defByName = new Map(cases.map((c) => [c.name, c]));
  const names = new Set(records.map((r) => r.caseName));
  const rows = [];
  for (const name of names) {
    const runs = records.filter((r) => r.caseName === name);
    const def = defByName.get(name);
    const group = def ? def.group : runs[0].group;
    const tags = def ? def.tags : runs[0].tags;
    const baseValid = armScores(records, name, 'base');
    const candidateValid = armScores(records, name, 'candidate');
    const base = baseValid.length ? mean(baseValid.map((r) => r.score)) : null;
    const candidate = candidateValid.length ? mean(candidateValid.map((r) => r.score)) : null;
    const regression = tags.includes('regression')
      && baseValid.length > 0 && baseValid.every((r) => r.score === 1)
      && candidateValid.length > 0 && candidateValid.every((r) => r.score === 0);
    rows.push({
      name, group, tags,
      base, candidate,
      delta: base === null || candidate === null ? null : candidate - base,
      baseRuns: baseValid.length,
      candidateRuns: candidateValid.length,
      baseInvalid: byArm(records, 'base').filter((r) => r.caseName === name).length - baseValid.length,
      candidateInvalid: byArm(records, 'candidate').filter((r) => r.caseName === name).length - candidateValid.length,
      regression,
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * A paired bootstrap over cases: each of `resamples` draws `deltas.length` case deltas with
 * replacement and takes their mean, then the CI is the percentile interval at `level`. `rng`
 * is injected — the caller seeds it (see `cellSeed`) so the result is pinned exactly.
 */
function bootstrapCI(deltas, { resamples, level, rng }) {
  if (deltas.length < 2) return { lower: null, upper: null, level };
  const n = deltas.length;
  const resampleMeans = new Array(resamples);
  for (let i = 0; i < resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < n; j += 1) sum += deltas[Math.floor(rng() * n)];
    resampleMeans[i] = sum / n;
  }
  resampleMeans.sort((a, b) => a - b);
  const alpha = 1 - level;
  const at = (p) => resampleMeans[Math.min(resamples - 1, Math.max(0, Math.floor(p * resamples)))];
  return { lower: at(alpha / 2), upper: at(1 - alpha / 2), level };
}

/** Bonferroni across the cells of one compare, so four cells do not manufacture a finding. */
function ciLevel(cellCount, alpha = 0.05) {
  return 1 - alpha / cellCount;
}

/** Share of cases whose every valid run in `arm` passed, plus the run count that backs it. */
function armPassShare(records, arm) {
  const byCase = new Map();
  for (const r of byArm(records, arm)) {
    if (!isValid(r)) continue;
    if (!byCase.has(r.caseName)) byCase.set(r.caseName, []);
    byCase.get(r.caseName).push(r);
  }
  let passingCases = 0;
  let minRuns = Infinity;
  for (const runs of byCase.values()) {
    minRuns = Math.min(minRuns, runs.length);
    if (runs.every((r) => r.passed)) passingCases += 1;
  }
  const consideredCases = byCase.size;
  return {
    share: consideredCases ? passingCases / consideredCases : null,
    minRuns: consideredCases ? minRuns : null,
  };
}

/** The median of an arm's per-case median for one numeric field (`costUsd`, `durationSeconds`). */
function armMedianMetric(records, arm, field) {
  const byCase = new Map();
  for (const r of byArm(records, arm)) {
    if (!isValid(r)) continue;
    if (!byCase.has(r.caseName)) byCase.set(r.caseName, []);
    byCase.get(r.caseName).push(r[field]);
  }
  return median([...byCase.values()].map((values) => median(values)));
}

const ratioOf = (base, candidate) => (base === null || candidate === null || base === 0 ? null : candidate / base);

function tagMean(rows, tag, field) {
  const values = rows.filter((r) => r.tags.includes(tag)).map((r) => r[field]).filter((v) => v !== null);
  return values.length ? mean(values) : null;
}

/** The full `CellSummary` of the contract for one cell's records. */
function summariseCell({ cell, records, cases, config, cellCount }) {
  const cellIdStr = CELL_ID(cell);
  const cellRecords = records.filter((r) => CELL_ID(r.cell) === cellIdStr);
  const rows = caseRows({ records: cellRecords, cases });

  const baseVals = rows.map((r) => r.base).filter((v) => v !== null);
  const candidateVals = rows.map((r) => r.candidate).filter((v) => v !== null);
  const deltaVals = rows.map((r) => r.delta).filter((v) => v !== null);

  const level = ciLevel(cellCount);
  const rng = makeRng(cellSeed(config.verdict.seed, cellIdStr));
  const ci = bootstrapCI(deltaVals, { resamples: config.verdict.bootstrapResamples, level, rng });

  const basePass = armPassShare(cellRecords, 'base');
  const candidatePass = armPassShare(cellRecords, 'candidate');
  const k = Math.min(...[basePass.minRuns, candidatePass.minRuns].filter((v) => v !== null));

  const costBase = armMedianMetric(cellRecords, 'base', 'costUsd');
  const costCandidate = armMedianMetric(cellRecords, 'candidate', 'costUsd');
  const durationBase = armMedianMetric(cellRecords, 'base', 'durationSeconds');
  const durationCandidate = armMedianMetric(cellRecords, 'candidate', 'durationSeconds');

  const baseAll = byArm(cellRecords, 'base');
  const candidateAll = byArm(cellRecords, 'candidate');
  const baseInvalid = baseAll.filter((r) => !isValid(r)).length;
  const candidateInvalid = candidateAll.filter((r) => !isValid(r)).length;
  const totalRuns = baseAll.length + candidateAll.length;
  const totalInvalid = baseInvalid + candidateInvalid;

  return {
    cell, cellId: cellIdStr,
    cases: rows,
    n: rows.filter((r) => r.delta !== null).length,
    meanBase: mean(baseVals),
    meanCandidate: mean(candidateVals),
    meanDelta: mean(deltaVals),
    ci,
    passK: { base: basePass.share, candidate: candidatePass.share, k: Number.isFinite(k) ? k : null },
    invalid: {
      base: baseInvalid, candidate: candidateInvalid, total: totalInvalid,
      share: totalRuns ? totalInvalid / totalRuns : 0,
    },
    cost: { base: costBase, candidate: costCandidate, ratio: ratioOf(costBase, costCandidate) },
    duration: { base: durationBase, candidate: durationCandidate, ratio: ratioOf(durationBase, durationCandidate) },
    hardRegression: rows.some((r) => r.regression === true),
    triggers: {
      recall: { base: tagMean(rows, 'trigger:positive', 'base'), candidate: tagMean(rows, 'trigger:positive', 'candidate') },
      falseTrigger: {
        base: tagMean(rows, 'trigger:negative', 'base') === null ? null : 1 - tagMean(rows, 'trigger:negative', 'base'),
        candidate: tagMean(rows, 'trigger:negative', 'candidate') === null ? null : 1 - tagMean(rows, 'trigger:negative', 'candidate'),
      },
    },
  };
}

/**
 * Turns one cell's `CellSummary` into the verdict the harness reports — the one function in
 * this codebase that turns numbers into a claim, so every branch below is a deliberate,
 * reviewed choice, not an implementation detail.
 *
 * Input:  `summary` — a `CellSummary` as returned by `summariseCell`. A cell that produced no
 *                      case rows at all despite an `n` below `minCases` is read as cut short
 *                      (a cost-ceiling abort mid-cell) rather than as a small real sample.
 *         `config`  — `evals/eval.config.json`, in particular `config.verdict` (`delta`,
 *                      `minCases`, `maxInvalidShare`) and `config.guardrails`
 *                      (`costRatio`, `durationRatio`).
 * Output: `{ verdict, reasons, guardrails }` —
 *           `verdict`: one of 'Better' | 'Worse' | 'Not worse' | 'Not proven' | 'Invalid'
 *           `reasons`: string[] explaining the verdict (e.g. which per-case drops triggered it)
 *           `guardrails`: string[], reported alongside any verdict rather than changing it
 *
 * The rule table (first match wins):
 *
 * | Verdict      | Rule                                                                     |
 * |--------------|---------------------------------------------------------------------------|
 * | Invalid    | `invalid.share > config.verdict.maxInvalidShare`, or fewer than            |
 * |              | `config.verdict.minCases` cases with zero case rows (cut short)           |
 * | Worse         | `hardRegression`, or `ci.upper < 0`                                        |
 * | Better        | `ci.lower > 0`                                                             |
 * | Not worse      | `ci.lower > -config.verdict.delta`                                         |
 * | Not proven  | otherwise; below `minCases` only the hard-regression rule applies, and     |
 * |              | per-case drops >= 0.67 are flagged in `reasons`                            |
 *
 * Guardrails, reported beside any verdict rather than changing it:
 *   - `cost.ratio > config.guardrails.costRatio`
 *   - `duration.ratio > config.guardrails.durationRatio`
 *   - `triggers.falseTrigger.candidate > triggers.falseTrigger.base`
 */
// A case's fractional drop from its base score — the trigger for the >= 0.67 flag below
// minCases. Guarded against base === 0, where "drop" is meaningless.
const dropFraction = (c) => (c.base && c.delta != null ? -c.delta / c.base : null);

function decideVerdict(summary, config) {
  const { verdict: v, guardrails: g } = config;
  const guardrails = [];
  if (summary.cost.ratio != null && summary.cost.ratio > g.costRatio) {
    guardrails.push(`cost ratio ${summary.cost.ratio.toFixed(2)}× exceeds guardrail ${g.costRatio}×`);
  }
  if (summary.duration.ratio != null && summary.duration.ratio > g.durationRatio) {
    guardrails.push(`duration ratio ${summary.duration.ratio.toFixed(2)}× exceeds guardrail ${g.durationRatio}×`);
  }
  const ft = summary.triggers.falseTrigger;
  if (ft.base != null && ft.candidate != null && ft.candidate > ft.base) {
    guardrails.push(`false-trigger rate rose from ${ft.base.toFixed(2)} to ${ft.candidate.toFixed(2)}`);
  }

  if (summary.invalid.share > v.maxInvalidShare) {
    return {
      verdict: 'Invalid',
      reasons: [`invalid run share ${Math.round(summary.invalid.share * 100)}% exceeds the ${Math.round(v.maxInvalidShare * 100)}% ceiling`],
      guardrails,
    };
  }
  // A cell that produced zero case rows despite claiming `n` cases was cut short before it ran
  // anything real (a cost-ceiling abort mid-cell) — distinct from a small but real sample,
  // which is a `minCases` question below, not an invalid one.
  if (summary.n < v.minCases && summary.cases.length === 0) {
    return {
      verdict: 'Invalid',
      reasons: [`only ${summary.n} case(s) and no case data — the run was cut short before it produced anything`],
      guardrails,
    };
  }

  if (summary.hardRegression) {
    return {
      verdict: 'Worse',
      reasons: ['a regression-tagged case went from a perfect base score to a total candidate failure'],
      guardrails,
    };
  }

  if (summary.n < v.minCases) {
    const reasons = [`only ${summary.n} case(s), below the ${v.minCases}-case minimum — only a hard regression could decide this cell`];
    for (const c of summary.cases) {
      const drop = dropFraction(c);
      if (drop !== null && drop >= 0.67) reasons.push(`case "${c.name}" dropped ${Math.round(drop * 100)}% (${c.base.toFixed(2)} → ${c.candidate.toFixed(2)})`);
    }
    return { verdict: 'Not proven', reasons, guardrails };
  }

  const { lower, upper } = summary.ci;
  if (upper < 0) return { verdict: 'Worse', reasons: [`the confidence interval [${lower.toFixed(2)}, ${upper.toFixed(2)}] is entirely below zero`], guardrails };
  if (lower > 0) return { verdict: 'Better', reasons: [`the confidence interval [${lower.toFixed(2)}, ${upper.toFixed(2)}] is entirely above zero`], guardrails };
  if (lower > -v.delta) return { verdict: 'Not worse', reasons: [`the lower bound ${lower.toFixed(2)} clears -δ (${(-v.delta).toFixed(2)})`], guardrails };
  return { verdict: 'Not proven', reasons: [`the confidence interval [${lower.toFixed(2)}, ${upper.toFixed(2)}] neither clears -δ nor rules out zero`], guardrails };
}

module.exports = { makeRng, cellSeed, mean, median, caseRows, bootstrapCI, ciLevel, summariseCell, decideVerdict };
