'use strict';
// Runs one case through the real `copilot` CLI and turns its JSONL stdout into a RunRecord.
// Mirrors claude.js's public shape (buildArgs/runCase) and its "never throw for a broken run"
// philosophy, but Copilot has no native grading, no ablation flag and no --json file — this
// module supplies the grading (via graders.js) and reads the trace straight off stdout.
//
// Every fact this module encodes about the real CLI (auth capture order, required flags, event
// schema, tool-name mapping) was captured by live experimentation and is recorded in
// copilot-facts.md; a comment here says only *why* a line exists, not what the CLI's --help text
// claims (the two disagree in more than one place, and the live behavior wins).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { loadCatalog, planInstall, applyInstall } = require('../../lib/install');
const { classifyInvalid } = require('./records');
const { mapToolName, gradeCase } = require('./graders');
const { runJudge } = require('./judge');

const tail = (text, lines = 20) => (text || '').split('\n').slice(-lines).join('\n').trim();

// Always available regardless of a case's own `allowed_tools` — copilot-facts.md: `skill` loads
// skills at all, `report_intent` is Copilot's own reasoning-display mechanism, never a
// case-grantable tool.
const ALWAYS_AVAILABLE = ['report_intent', 'skill'];

/** Claude-vocabulary tool names in, Copilot `--available-tools` values out, deduplicated. */
function mapTools(allowedTools = []) {
  const mapped = allowedTools.map(mapToolName);
  return [...new Set([...mapped, ...ALWAYS_AVAILABLE])];
}

/**
 * `gh auth token` must run in the parent's *real* env, before the fake HOME for an isolated run
 * is ever constructed — copilot-facts.md: building a shell command that sets HOME=<tmp> first
 * makes `gh` inherit the fake HOME and fail to find the keychain token. `exec` is injected so
 * tests never shell out to the real `gh` binary; it takes no arguments and returns the raw token
 * text (or throws), keeping the injection point a one-liner for tests.
 */
function defaultGhExec() {
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' });
}

function ghToken(exec = defaultGhExec) {
  let raw;
  try {
    raw = exec();
  } catch (e) {
    throw new Error(`"gh auth token" failed — the Copilot eval arm needs an authenticated gh CLI (run "gh auth login" first): ${e.message}`);
  }
  const token = (raw || '').trim();
  if (!token) throw new Error('"gh auth token" returned no token — run "gh auth login" first; the Copilot eval arm cannot run without one');
  return token;
}

/**
 * Installs the catalog into a fake HOME with no CLI involved, per copilot-facts.md: `--plugin-dir`
 * does not load plugin skills on this CLI at all, so the only path that works is installing the
 * *global* layout (`<home>/.copilot/skills`, `<home>/.copilot/agents`) directly via lib/install.js.
 * This also sidesteps the interactive "Trust this directory?" prompt a real project dir would hit.
 */
function installCatalog({ root, home, bundles }) {
  const catalog = loadCatalog(root);
  const bundleNames = bundles && bundles.length ? bundles : catalog.bundles.map((b) => b.name);
  const { plans } = planInstall({ root, catalog, bundles: bundleNames, targets: ['copilot'], scope: 'global' });
  const [plan] = plans;
  return applyInstall({ plan, baseDir: home, catalog, bundles: bundleNames, date: new Date() });
}

/**
 * `-C <dir>` is documented but errors at runtime on this CLI — use the child process's own `cwd`
 * instead. `--usage-output-file` is likewise documented but broken; the `result` event on stdout
 * already carries everything it would have, so it is never passed. Copilot has no `max_turns`
 * equivalent — `timeout_seconds` (enforced by `runCase` killing the process) is the only limit
 * this arm can honour, which is why no turn-count flag appears here.
 */
function buildArgs({ prompt, model, effort, allowedTools = [] }) {
  return [
    '-p', prompt,
    '--allow-all-tools', '--allow-all-paths', '--no-ask-user', '--no-auto-update',
    '--output-format', 'json',
    '--model', model,
    '--reasoning-effort', effort,
    '--available-tools', ...mapTools(allowedTools),
  ];
}

/** Same shape as claude.js's spawnExec, plus a kill-on-timeout the Claude arm doesn't need
 * (Claude's own `--eval-dir` command enforces `max_turns` itself; this one has nothing to lean
 * on but a wall-clock timer). */
function spawnExec(command, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/**
 * Turns raw `--output-format json` stdout (one JSON object per line) into the normalized trace
 * `graders.js` consumes. Unknown/unparseable lines are skipped rather than fatal — a stray line
 * of interleaved stderr-on-stdout noise shouldn't sink an otherwise-gradable run.
 */
function parseTrace(jsonlText, { workdir } = {}) {
  const calls = new Map();
  const order = [];
  const replyParts = [];
  let result = null;
  let turns = 0;
  for (const line of String(jsonlText || '').split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'tool.execution_start') {
      const id = event.data.toolCallId;
      calls.set(id, { name: event.data.toolName, input: event.data.arguments, success: null });
      order.push(id);
    } else if (event.type === 'tool.execution_complete') {
      const call = calls.get(event.data.toolCallId);
      if (call) call.success = !!event.data.success;
    } else if (event.type === 'assistant.message') {
      const content = event.data && event.data.content;
      if (content) replyParts.push(content);
    } else if (event.type === 'assistant.turn_start') {
      turns += 1;
    } else if (event.type === 'result') {
      result = event;
    }
  }
  const toolCalls = order.map((id) => calls.get(id));
  const reply = replyParts.join('');
  const raw = `${toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input)}) -> ${c.success}`).join('\n')}\n\n${reply}`;
  return { reply, raw, toolCalls, turns, usage: result ? result.usage : undefined, result, workdir };
}

/**
 * The Copilot-side equivalent of records.js's `fromClaudeJson`, but for exactly one run (Copilot
 * cases run once per `runCase` call, like Claude's per-run granularity — the caller batches
 * `runs` by calling this repeatedly, matching how it already treats claude.js).
 *
 * Copilot has no `partial` flag like Claude's; its own invalid signal is a missing `result`
 * event, or a `result.exitCode` that disagrees with the process's own exit code — either is
 * treated as a crash via the same `classifyInvalid` the Claude arm uses, so `stats.js`/
 * `report.js` never need to know which target produced a record.
 */
function fromCopilotJson({ cell, arm, caseDef, trace, exitCode, graded, index = 0, startedAt, creditUsd }) {
  const usage = trace.usage || {};
  const resultExitCode = trace.result ? trace.result.exitCode : undefined;
  const crashed = !trace.result || (resultExitCode !== undefined && resultExitCode !== exitCode);
  // `graded` is trusted as given — the caller (runCase) is the one that decides whether to grade
  // at all, and passes a non-finite score for a crashed run so classifyInvalid's own fallback
  // (score isn't a finite number) catches it even if this crash text doesn't match a known
  // rate-limit/usage-limit/auth pattern.
  const error = crashed
    ? (!trace.result
      ? `copilot exited ${exitCode} with no result event`
      : `copilot process exit ${exitCode} disagreed with its own result.exitCode ${resultExitCode}`)
    : null;
  return {
    cell,
    arm,
    caseName: caseDef.name,
    group: caseDef.group,
    tags: caseDef.tags || [],
    run: index,
    score: graded.score,
    passed: graded.passed,
    graders: graded.graders,
    turns: trace.turns,
    costUsd: usage.premiumRequests !== undefined && creditUsd !== undefined ? usage.premiumRequests * creditUsd : undefined,
    durationSeconds: usage.sessionDurationMs !== undefined ? usage.sessionDurationMs / 1000 : undefined,
    startedAt: startedAt || null,
    error,
    invalid: classifyInvalid({ error, partial: false, score: graded.score }),
  };
}

/** How long a case's own setup may take before it is treated as broken. */
const SCAFFOLD_TIMEOUT_MS = 120000;

/**
 * Runs a case's `context.scaffold_script` (the same key the native Claude command reads) in the
 * run's workdir. The path is relative to the case directory, matching how `claude plugin eval`
 * resolves it. No-op for a case without one.
 */
async function runScaffold({ caseDef, cwd, env, exec }) {
  const script = caseDef.context && caseDef.context.scaffold_script;
  if (!script) return null;
  const scriptPath = path.resolve(caseDef.dir, script);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`${caseDef.name}: scaffold_script "${script}" does not exist at ${scriptPath}`);
  }
  const { code, stderr } = await exec('bash', [scriptPath], { cwd, env, timeoutMs: SCAFFOLD_TIMEOUT_MS });
  if (code !== 0) throw new Error(`${caseDef.name}: scaffold_script exited ${code}: ${tail(stderr)}`);
  return scriptPath;
}

/**
 * One case, one run, end to end. Never throws — a killed/crashed run returns `outcome: 'failed'`
 * or `'interrupted'` with the stderr tail, same philosophy as claude.js, so one bad Copilot cell
 * cannot take down a whole compare. `exec` is injected (default `spawnExec`) so tests never
 * launch the real `copilot` binary; `token`/`ghTokenFn`/`installCatalogFn` are equally injectable
 * so tests never shell out to `gh` or touch the real catalog root unexpectedly.
 */
async function runCase(opts) {
  const {
    cell, arm, caseDef, root, bundles = [], exec = spawnExec, token,
    ghTokenFn = ghToken, home, workdir, installCatalogFn = installCatalog,
    judge, judgeExec, creditUsd, index = 0, timeoutMs,
  } = opts;
  const startedAt = new Date().toISOString();
  try {
    const resolvedHome = home || fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
    const resolvedWorkdir = workdir || fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-work-'));
    if (root) installCatalogFn({ root, home: resolvedHome, bundles });
    const ghTok = token || ghTokenFn();
    const timeout = timeoutMs !== undefined ? timeoutMs : (caseDef.timeoutSeconds || 300) * 1000;
    const args = buildArgs({ prompt: caseDef.prompt, model: cell.model, effort: cell.effort, allowedTools: caseDef.allowedTools });
    const env = {
      ...process.env,
      HOME: resolvedHome,
      COPILOT_HOME: path.join(resolvedHome, '.copilot'),
      COPILOT_GITHUB_TOKEN: ghTok,
    };
    // Copilot has no `--scaffold` of its own, so this arm runs the case's setup itself — in the
    // same workdir and the same fake HOME the CLI will get, so `git init`/`git config` land in the
    // sandbox and not in the operator's real home. A scaffold that fails throws into the catch
    // below and the run is reported failed rather than graded: a case whose setup never ran is
    // not a model result.
    await runScaffold({ caseDef, cwd: resolvedWorkdir, env, exec });
    const { code, stdout, stderr, timedOut } = await exec('copilot', args, { cwd: resolvedWorkdir, env, timeoutMs: timeout });
    const trace = parseTrace(stdout, { workdir: resolvedWorkdir });
    const hasResult = !timedOut && !!trace.result && trace.result.exitCode === code;
    let graded = { score: NaN, passed: false, graders: [] };
    if (hasResult) {
      const judgeFn = (grader, tr) => runJudge({ grader, trace: tr, judge, exec: judgeExec });
      graded = await gradeCase(caseDef, trace, { judge: judgeFn });
    }
    const record = fromCopilotJson({ cell, arm, caseDef, trace, exitCode: code, graded, index, startedAt, creditUsd });
    if (timedOut) {
      record.error = `copilot timed out after ${timeout}ms: ${tail(stderr)}`;
      record.invalid = classifyInvalid({ error: record.error, partial: false, score: record.score });
    }
    const outcome = timedOut ? 'interrupted' : !hasResult ? 'failed' : graded.score < 1 ? 'below-threshold' : 'ok';
    const topError = hasResult ? null : (record.error || tail(stderr) || 'copilot run produced no result event');
    return { records: [record], raw: stdout, exitCode: code, outcome, error: topError };
  } catch (e) {
    // A broken run (missing gh auth, a spawn error, an install failure) must not kill a whole
    // compare — report it as a failed cell instead of throwing.
    return { records: [], raw: null, exitCode: null, outcome: 'failed', error: tail(String((e && e.stack) || e)) };
  }
}

module.exports = {
  ALWAYS_AVAILABLE, SCAFFOLD_TIMEOUT_MS, mapTools, ghToken, installCatalog, buildArgs, spawnExec,
  parseTrace, runScaffold, fromCopilotJson, runCase,
};
