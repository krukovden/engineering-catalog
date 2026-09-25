'use strict';
// Version A of the catalog against version B, measured. The native command compares
// "plugin on" with "plugin off"; what a *change* to the catalog did between two commits is
// nobody's job but ours — run the same cases against both trees, hand the numbers to stats.
// Both arms run identical cases (the candidate's `evals/` is copied over the base worktree),
// so a difference can only come from the catalog.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { build } = require('../../lib/build');
const { scanUnits, FOLDERS } = require('../../lib/units');
const { scanHooks } = require('../../lib/hooks');
const { loadSuite } = require('./cases');
const { changedPaths, selectCases } = require('./affected');
const { withBaseWorktree, currentSha, isDirty, resolveRef } = require('./worktree');
const claudeArm = require('./claude');
const copilotArm = require('./copilot');
const { writeRecords, fingerprint, hashSuite } = require('./records');
const { summariseCell, decideVerdict } = require('./stats');
const { renderConsole, experimentRecord, writeExperiment } = require('./report');

const CONFIG_FILE = 'evals/eval.config.json';
const RESULTS_DIR = 'evals/results';
// The tools `claude plugin eval` gates behind an operator grant; everything else a case names
// in `allowed_tools` (Read, Glob, Grep, Skill…) is already available to the run.
const GATED_TOOLS = ['Bash', 'Write', 'Edit', 'WebFetch'];

const loadConfig = (root) => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
  delete raw.$comment;
  return raw;
};

/** Which cell group a case belongs to — its tags decide, not the tier it was selected at. */
const caseGroup = (c) => (c.tags.some((t) => t.startsWith('trigger:')) ? 'trigger' : 'behaviour');

const cellId = (cell) => `${cell.target}:${cell.model}:${cell.effort}`;

const gatedTools = (allowed) => allowed.filter((t) => GATED_TOOLS.includes(t) || t.startsWith('mcp__'));

/** Env forwarded into the container — a safelist, not the full merged env claude.js/copilot.js
 * build for a host run (that starts from `...process.env` and would blow up `-e` argv with
 * irrelevant or sensitive host vars). Only the credential the target actually needs, read
 * straight off this process's env at call time, plus the effort level every cell needs. */
function containerCredentials(target) {
  const env = {};
  if (target === 'claude') {
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  } else if (target === 'copilot' && process.env.COPILOT_GITHUB_TOKEN) {
    env.COPILOT_GITHUB_TOKEN = process.env.COPILOT_GITHUB_TOKEN;
  }
  return env;
}

// The three variables a containerized Copilot run cannot do without: its fake HOME holds the
// installed catalog, and the token is how the CLI authenticates. Picked out of the caller's env by
// name — forwarding the whole merged env (which starts from `...process.env`) would push every
// host variable through `-e` argv.
const COPILOT_FORWARDED = ['HOME', 'COPILOT_HOME', 'COPILOT_GITHUB_TOKEN'];

/**
 * An `exec` with claude.js's / copilot.js's own `(command, args, { cwd, env }) => Promise<{code,
 * stdout, stderr}>` shape, but routed through the container instead of the host. The caller's
 * merged env is never forwarded wholesale; see `containerCredentials` and `COPILOT_FORWARDED`.
 *
 * The two arms need different things mounted. Claude's native command runs *in* the worktree and
 * writes its JSON there, so the worktree is the container's cwd. Copilot runs in a throwaway
 * workdir with a throwaway HOME, and both live outside the worktree — so they are mounted
 * writable, the worktree comes along read-only (it holds the case's scaffold script), and the
 * workdir is the cwd.
 */
function makeContainerExec({ isolation, runtime, root, target, effort, mounts }) {
  const env = { ...containerCredentials(target), CLAUDE_CODE_EFFORT_LEVEL: effort };
  if (target !== 'copilot') {
    return (command, args) => isolation.runInContainer({ runtime, command, args, cwd: root, env, mounts });
  }
  return (command, args, opts = {}) => {
    const callerEnv = opts.env || {};
    const forwarded = { ...env };
    for (const name of COPILOT_FORWARDED) if (callerEnv[name]) forwarded[name] = callerEnv[name];
    const cwd = opts.cwd || root;
    // `wrapCommand` already mounts `cwd` writable and sets `-w`; only the extras belong here.
    const copilotMounts = [...mounts, `${root}:${root}:ro`];
    if (callerEnv.HOME) copilotMounts.push(`${callerEnv.HOME}:${callerEnv.HOME}:rw`);
    return isolation.runInContainer({
      runtime, command, args, cwd, env: forwarded, mounts: copilotMounts, timeoutMs: opts.timeoutMs,
    });
  };
}

/** One entry per cell that has cases to run, in a stable order. */
function planCells({ cases, config, targets }) {
  const plan = [];
  for (const group of ['trigger', 'behaviour']) {
    const groupCases = cases.filter((c) => caseGroup(c) === group);
    if (!groupCases.length) continue;
    for (const cell of config.cells[group] || []) {
      if (!targets.includes(cell.target)) continue;
      plan.push({ group, cell, id: cellId(cell), cases: groupCases, runs: config.runs[group] ?? config.runs.default });
    }
  }
  return plan;
}

/** Runs of one case in one arm on Claude, through the native command. */
async function runClaudeArm({ entry, arm, pluginDir, c, byName, resultsDir, remainingUsd, exec }) {
  const outputDir = path.join(resultsDir, entry.id.replace(/[:/]/g, '_'), arm, c.name);
  const jsonPath = path.join(outputDir, 'result.json');
  fs.mkdirSync(outputDir, { recursive: true });
  const { records, outcome } = await claudeArm.runCase({
    pluginDir, caseName: c.name, runs: entry.runs, model: entry.cell.model,
    judgeModel: null, allowTools: gatedTools(c.allowedTools),
    scaffold: !!(c.context && c.context.scaffold_script),
    maxCostUsd: remainingUsd, outputDir, jsonPath,
    cell: entry.cell, arm, cases: byName, exec,
  });
  return { records, outcome, spent: records.reduce((s, r) => s + (r.costUsd || 0), 0) };
}

/**
 * Runs of one case in one arm on Copilot. Unlike the native Claude command, `copilot.js`'s
 * `runCase` produces exactly one run per call (it has no `--runs` of its own), so this loops
 * `entry.runs` times; a run past the cost ceiling stops the loop rather than being launched and
 * discarded. `home` is the arm's already-installed fake HOME (see `compare`) — passing it
 * without `root` tells `copilot.js` to reuse it instead of reinstalling per run.
 */
async function runCopilotArm({ entry, arm, c, home, token, config, remainingUsd, judgeExec, exec }) {
  const records = [];
  let spent = 0;
  let outcome = 'ok';
  for (let index = 0; index < entry.runs; index++) {
    if (spent >= remainingUsd) break;
    const r = await copilotArm.runCase({
      cell: entry.cell, arm, caseDef: c, home, token, index,
      judge: config.judge, creditUsd: config.copilotCreditUsd, exec, judgeExec,
    });
    if (r.outcome === 'failed' || r.outcome === 'interrupted') outcome = r.outcome;
    spent += r.records.reduce((s, rec) => s + (rec.costUsd || 0), 0);
    records.push(...r.records);
  }
  return { records, outcome, spent };
}

/**
 * The whole compare. `exec` and `now` are injected so a test can drive it without a model.
 * Returns the summaries, the verdicts (a verdict may be undecided — the rule is deliberately
 * unwritten) and the experiment record when one was asked for.
 */
async function compare(opts) {
  const {
    root, base, tier = 2, all = false, targets = ['claude'], caseFilter,
    record: slug, hypothesis, maxCostUsd, runsOverride, container = 'auto',
    log = console.log, warn = console.error, exec, copilotExec, judgeExec,
    ghTokenFn, now = new Date(), isolation = require('./isolation'),
  } = opts;

  const stale = build({ root, check: true });
  if (stale.errors.length) return { exitCode: 1, error: `build: ${stale.errors[0]}` };
  if (stale.written.length) return { exitCode: 1, error: 'generated artifacts are stale — run npm run build first' };

  const config = loadConfig(root);
  const budgetUsd = maxCostUsd ?? config.budget.maxCostUsd;
  const { cases: allCases, errors } = loadSuite({ root });
  if (errors.length) return { exitCode: 1, error: 'fix `npm run eval -- lint` first' };

  const { units } = scanUnits({ root, folders: FOLDERS });
  const hooks = scanHooks({ root });
  const changed = changedPaths({ root, base });
  const selected = selectCases({ cases: allCases, units, hooks, changed, tier, all });
  if (!selected.cases.length) return { exitCode: 1, error: `no case is affected by the change since ${base}` };
  // A narrowing flag, not a selection rule: the harness still decides what a change can move,
  // and this only cuts that set down for a smoke run or a debug loop.
  if (caseFilter) selected.cases = selected.cases.filter((c) => c.name.includes(caseFilter));
  if (!selected.cases.length) return { exitCode: 1, error: `no affected case matches --case ${caseFilter}` };

  // Two needs, one runtime. A case tagged `isolation:container` must never touch the host — its
  // own scaffold runs arbitrary bash. The Copilot arm wants the container for a different reason:
  // `copilot` is launched with --allow-all-tools --allow-all-paths and has no OS sandbox of its
  // own, where `claude plugin eval` sandboxes shell tools itself, so on that arm a throwaway HOME
  // and workdir are otherwise the only containment there is. A missing runtime therefore *skips* a
  // tagged case but only *downgrades* the Copilot arm — and `required` is the flag that says a
  // silent downgrade is not acceptable either way.
  let containerRuntime = null;
  const containerCases = selected.cases.filter((c) => c.isolation === 'container');
  const copilotWanted = targets.includes('copilot');
  const skippedContainer = [];
  if (containerCases.length || copilotWanted) {
    const downgrade = (reason) => {
      for (const c of containerCases) {
        warn(`⚠ ${c.relDir}: container case skipped — ${reason}`);
        skippedContainer.push({ name: c.name, reason });
      }
      selected.cases = selected.cases.filter((c) => c.isolation !== 'container');
      if (copilotWanted) warn(`⚠ the Copilot arm runs on the host — ${reason}`);
    };
    if (container === 'off') {
      downgrade('container isolation is off (--container off)');
    } else {
      const runtime = isolation.detectRuntime();
      if (!runtime) {
        if (container === 'required') return { exitCode: 1, error: 'no podman/docker runtime available (--container required)' };
        downgrade('no podman/docker runtime available');
      } else {
        try {
          await isolation.buildImage({ runtime, root });
          containerRuntime = runtime;
        } catch (e) {
          if (container === 'required') return { exitCode: 1, error: `no podman/docker runtime available (--container required): container image build failed: ${e.message}` };
          downgrade(`container image build failed: ${e.message}`);
        }
      }
    }
    if (!selected.cases.length) return { exitCode: 1, error: `no case is affected by the change since ${base}` };
  }

  const byName = new Map(allCases.map((c) => [c.name, c]));
  const plan = planCells({ cases: selected.cases, config, targets });
  if (!plan.length) return { exitCode: 1, error: `no cell in ${CONFIG_FILE} matches target(s) ${targets.join(', ')}` };
  if (runsOverride) plan.forEach((e) => { e.runs = runsOverride; });

  const runId = `${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${base.replace(/[^\w.-]/g, '_')}`;
  const resultsDir = path.join(root, RESULTS_DIR, runId);
  const recordsFile = path.join(resultsDir, 'runs.jsonl');
  const candidateSha = currentSha({ root });
  const baseSha = resolveRef({ root, ref: base });
  if (baseSha === candidateSha && !isDirty({ root })) {
    warn(`⚠ base and candidate are the same commit with a clean tree — this is an A/A check`);
  }

  const summaries = [];
  let spentUsd = 0;
  let partial = false;

  // One fake HOME per arm, installed once and reused for every Copilot case/run of that arm —
  // reinstalling the whole catalog per run would be correct but needlessly slow, and the
  // catalog under test doesn't change between cases within one arm.
  const copilotHomes = {};
  const needsCopilot = plan.some((e) => e.cell.target === 'copilot');
  let ghTok;
  const cleanupHomes = () => {
    for (const dir of Object.values(copilotHomes)) fs.rmSync(dir, { recursive: true, force: true });
  };

  const baseDir = path.join(os.tmpdir(), `engcat-base-${process.pid}`);
  fs.rmSync(baseDir, { recursive: true, force: true });
  try {
    await withBaseWorktree({ root, ref: base, dir: baseDir }, async (baseTree) => {
      if (needsCopilot) {
        ghTok = (ghTokenFn || copilotArm.ghToken)();
        for (const [arm, pluginDir] of [['base', baseTree.path], ['candidate', root]]) {
          const home = fs.mkdtempSync(path.join(os.tmpdir(), `engcat-copilot-${arm}-`));
          copilotArm.installCatalog({ root: pluginDir, home });
          copilotHomes[arm] = home;
        }
      }
      for (const entry of plan) {
        const records = [];
        for (const [i, c] of entry.cases.entries()) {
          // Alternate which arm goes first: a rate limit or provider drift then hits both.
          const order = i % 2 === 0 ? ['base', 'candidate'] : ['candidate', 'base'];
          for (const arm of order) {
            if (spentUsd >= budgetUsd) { partial = true; continue; }
            const remainingUsd = Math.max(budgetUsd - spentUsd, 0.01);
            const containerAdapter = containerRuntime && (c.isolation === 'container' || entry.cell.target === 'copilot')
              ? makeContainerExec({
                isolation, runtime: containerRuntime, root, target: entry.cell.target, effort: entry.cell.effort,
                mounts: arm === 'base' ? [`${baseTree.path}:${baseTree.path}:ro`] : [],
              })
              : null;
            const r = entry.cell.target === 'copilot'
              ? await runCopilotArm({ entry, arm, c, home: copilotHomes[arm], token: ghTok, config, remainingUsd, judgeExec, exec: containerAdapter || copilotExec })
              : await runClaudeArm({ entry, arm, pluginDir: arm === 'base' ? baseTree.path : root, c, byName, resultsDir, remainingUsd, exec: containerAdapter || exec });
            if (r.outcome === 'failed') warn(`⚠ ${entry.id} ${arm} ${c.name}: the run failed and was dropped`);
            spentUsd += r.spent;
            records.push(...r.records);
          }
          log(`  ${entry.id} ${i + 1}/${entry.cases.length} ${c.name} ($${spentUsd.toFixed(2)})`);
        }
        writeRecords(recordsFile, records);
        const summary = summariseCell({ cell: entry.cell, records, cases: entry.cases, config, cellCount: plan.length });
        summary.group = entry.group;
        summaries.push(summary);
      }
    });
  } finally {
    cleanupHomes();
  }

  // A cell cut short by the ceiling has no case rows to show for the cases it claims, which
  // `decideVerdict` itself reads as Invalid — no extra signal needs passing in here.
  const verdicts = summaries.map((summary) => {
    try {
      return { cellId: summary.cellId, ...decideVerdict(summary, config) };
    } catch (e) {
      return { cellId: summary.cellId, verdict: null, error: e.message, reasons: [], guardrails: [] };
    }
  });

  // Never claim 'native' when isolation was asked for — say what actually ran, and what was
  // skipped or downgraded, and why. `cases` are the tagged cases that got a container; `targets`
  // are the arms that got one for being unsandboxed rather than for being tagged.
  const isolationInfo = !containerCases.length && !copilotWanted
    ? 'native'
    : containerRuntime
      ? {
        mode: 'container',
        runtime: containerRuntime,
        cases: containerCases.map((c) => c.name),
        targets: copilotWanted ? ['copilot'] : [],
      }
      : {
        mode: 'native',
        skipped: skippedContainer.map((s) => s.name),
        downgraded: copilotWanted ? ['copilot'] : [],
      };

  const print = fingerprint({
    baseSha, candidateSha, candidateDirty: isDirty({ root }),
    suiteHash: hashSuite(selected.cases), cells: plan.map((e) => e.cell), judge: config.judge,
    claudeVersion: null, os: `${os.platform()} ${os.release()}`, isolation: isolationInfo,
    createdAt: now.toISOString(), partial, spentUsd: Number(spentUsd.toFixed(4)),
  });

  log(renderConsole({ summaries, verdicts, fingerprint: print }));
  if (partial) warn(`✗ the $${budgetUsd} ceiling was hit — results are partial`);

  let written = null;
  if (slug) {
    const rec = experimentRecord({
      slug, hypothesis, delta: config.verdict.delta,
      fingerprint: print, summaries, verdicts, now,
    });
    written = writeExperiment({ root, record: rec });
    log(`✓ experiment recorded at ${written}`);
  }
  return { exitCode: partial ? 2 : 0, summaries, verdicts, fingerprint: print, recordPath: written, spentUsd };
}

module.exports = { compare, planCells, caseGroup, cellId, gatedTools, loadConfig, CONFIG_FILE, RESULTS_DIR, GATED_TOOLS };
