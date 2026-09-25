'use strict';
// Turns a `CellSummary` + `Verdict` pair into the three things a compare produces: the
// terminal table an engineer reads right away, the markdown report that gets attached to a
// PR, and the plain object committed to `evals/experiments/<date>-<slug>.json`. Everything
// here is pure except `writeExperiment`, which is the one place that touches `fs`.
const fs = require('fs');
const path = require('path');

const EM_DASH = '—';
const NAME_WIDTH = 40;

const formatScore = (n) => (n == null ? EM_DASH : n.toFixed(2));
const formatDelta = (n) => (n == null ? EM_DASH : `${n >= 0 ? '+' : ''}${n.toFixed(2)}`);
const formatRatio = (n) => (n == null ? EM_DASH : `${n.toFixed(1)}×`);

const pad = (s, width) => (s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width));

/** Cases with a non-null, non-zero delta — the ones worth a table row. */
const movedCases = (cases) => cases.filter((c) => c.delta != null && c.delta !== 0);

function verdictLine({ verdict, reasons, error }) {
  if (verdict) {
    const why = reasons && reasons.length ? ` — ${reasons.join('; ')}` : '';
    return `  verdict: ${verdict}${why}`;
  }
  // decideVerdict itself threw on this cell (e.g. a malformed CellSummary) — compare.js catches
  // that per cell so one bad cell can't lose every other cell's result; this is the edge case.
  return `  verdict: not decided — ${error || 'no verdict rule'}`;
}

function renderCell(summary, verdict = {}) {
  const lines = [summary.cellId, verdictLine(verdict)];
  for (const g of verdict.guardrails || []) lines.push(`  ! ${g}`);

  const moved = movedCases(summary.cases);
  if (moved.length) {
    lines.push('');
    lines.push(`  ${pad('case', NAME_WIDTH)} ${'base'.padStart(6)} ${'cand'.padStart(6)} ${'delta'.padStart(7)}`);
    for (const c of moved) {
      lines.push(
        `  ${pad(c.name, NAME_WIDTH)} ${formatScore(c.base).padStart(6)} ${formatScore(c.candidate).padStart(6)} ${formatDelta(c.delta).padStart(7)}`,
      );
    }
  }

  lines.push('');
  const invalidPct = `${Math.round((summary.invalid.share || 0) * 100)}%`;
  lines.push(
    `  n=${summary.n} meanΔ=${formatDelta(summary.meanDelta)} ci=[${formatDelta(summary.ci.lower)}, ${formatDelta(summary.ci.upper)}]@${summary.ci.level} ` +
      `pass^${summary.passK.k}=${formatScore(summary.passK.base)}→${formatScore(summary.passK.candidate)} invalid=${invalidPct}`,
  );
  return lines.join('\n');
}

// A fingerprint value is whatever made the run reproducible — a SHA, a flag, or the whole cell
// list. Objects are printed as JSON so the header stays one grep-able line per run.
const printValue = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));

/** The terminal output of a compare: one block per cell, fixed-width, no colour. */
function renderConsole({ summaries, verdicts = [], fingerprint }) {
  const header = fingerprint
    ? [...Object.entries(fingerprint).map(([k, v]) => `  ${k}: ${printValue(v)}`), '']
    : [];
  const blocks = summaries.map((s, i) => renderCell(s, verdicts[i] || {}));
  return [...header, blocks.join('\n\n')].join('\n');
}

function renderMarkdownCell(cell) {
  const lines = [`## ${cell.cellId}`, ''];
  const why = cell.reasons && cell.reasons.length ? ` — ${cell.reasons.join('; ')}` : '';
  lines.push(`**verdict:** ${cell.verdict || 'not decided'}${why}`);
  lines.push('');
  lines.push(`- n: ${cell.n}`);
  lines.push(`- mean Δ: ${formatDelta(cell.meanDelta)}`);
  lines.push(`- CI: [${formatDelta(cell.ci.lower)}, ${formatDelta(cell.ci.upper)}] @ ${cell.ci.level}`);
  lines.push(`- pass^${cell.passK.k}: ${formatScore(cell.passK.base)} → ${formatScore(cell.passK.candidate)}`);
  lines.push(`- invalid share: ${Math.round((cell.invalid.share || 0) * 100)}%`);
  for (const g of cell.guardrails || []) lines.push(`- guardrail: ${g}`);
  lines.push('');
  const moved = movedCases(cell.cases);
  if (moved.length) {
    lines.push('| case | base | candidate | delta |');
    lines.push('|---|---|---|---|');
    for (const c of moved) lines.push(`| ${c.name} | ${formatScore(c.base)} | ${formatScore(c.candidate)} | ${formatDelta(c.delta)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

/** A human-readable report of one experiment. No transcripts — the record carries none. */
function renderMarkdown({ experiment }) {
  const lines = [
    `# ${experiment.slug}`,
    '',
    `**date:** ${experiment.date}`,
    '',
    `**hypothesis:** ${experiment.hypothesis}`,
    '',
    `**δ (fixed before the run):** ${experiment.delta}`,
    '',
    '## fingerprint',
    '',
    ...Object.entries(experiment.fingerprint || {}).map(([k, v]) => `- ${k}: ${v}`),
    '',
  ];
  for (const cell of experiment.cells) lines.push(renderMarkdownCell(cell), '');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/** The five fields a committed record keeps per case — evidence, not the raw run data. */
const caseRecord = (c) => ({ name: c.name, base: c.base, candidate: c.candidate, delta: c.delta, regression: c.regression });

/** The plain object written to `evals/experiments/<date>-<slug>.json`. Deterministic: sort
 * everything that came from an array, and never spread an input object into the output. */
function experimentRecord({ slug, hypothesis, delta, fingerprint, summaries, verdicts = [], now = new Date() }) {
  const date = now.toISOString().slice(0, 10);
  const cells = summaries
    .map((s, i) => {
      const v = verdicts[i] || {};
      return {
        cellId: s.cellId,
        cell: s.cell,
        verdict: v.verdict ?? null,
        reasons: v.reasons ? [...v.reasons] : v.error ? [v.error] : [],
        guardrails: v.guardrails ? [...v.guardrails] : [],
        n: s.n,
        meanBase: s.meanBase,
        meanCandidate: s.meanCandidate,
        meanDelta: s.meanDelta,
        ci: s.ci,
        passK: s.passK,
        invalid: s.invalid,
        cost: s.cost,
        duration: s.duration,
        hardRegression: s.hardRegression,
        triggers: s.triggers,
        cases: s.cases.map(caseRecord).sort((a, b) => a.name.localeCompare(b.name)),
      };
    })
    .sort((a, b) => a.cellId.localeCompare(b.cellId));
  return { schemaVersion: 1, slug, date, hypothesis, delta, fingerprint, cells };
}

/** Writes the record, refusing to clobber a prior experiment. Returns the path written,
 * relative to `root`, so a caller can log or link it without knowing the join order. */
function writeExperiment({ root, record }) {
  const relPath = path.join('evals', 'experiments', `${record.date}-${record.slug}.json`);
  const abs = path.join(root, relPath);
  if (fs.existsSync(abs)) {
    throw new Error(`${relPath} already exists — pick a different slug`);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(record, null, 2)}\n`);
  return relPath;
}

module.exports = { renderConsole, renderMarkdown, experimentRecord, writeExperiment, formatScore, formatDelta, formatRatio };
