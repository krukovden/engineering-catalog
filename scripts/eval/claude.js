'use strict';
// Runs one case x one arm through the native `claude plugin eval` command and turns its JSON
// back into RunRecords. `exec` is always injected so tests never launch the real binary.
const fs = require('fs');
const { spawn } = require('child_process');
const { fromClaudeJson } = require('./records');

// Version comparison is ours (base vs candidate checkouts); the native ablation flag is a
// different question, so every invocation pins it off and lets the JSON carry everything else.
function buildArgs({ pluginDir, evalDir = 'evals', caseName, tags, runs, model, judgeModel, allowTools, maxCostUsd, outputDir, jsonPath, concurrency, scaffold }) {
  const args = [pluginDir, '--eval-dir', evalDir, '--ablation', 'none', '--trust-plugin', '--no-publish', '--json', jsonPath, '--output-dir', outputDir];
  // `--trust-plugin` deliberately does not imply `--scaffold`, and the native default is off, so
  // a case with a `context.scaffold_script` reaches the model on a bare directory unless this is
  // passed. Only set it when the case actually has one — it runs author-supplied bash as you.
  if (scaffold) args.push('--scaffold');
  if (caseName) args.push('--case', caseName);
  if (runs !== undefined) args.push('--runs', String(runs));
  if (model) args.push('--model', model);
  if (judgeModel) args.push('--judge-model', judgeModel);
  if (concurrency !== undefined) args.push('-j', String(concurrency));
  if (maxCostUsd !== undefined) args.push('--max-cost-usd', String(maxCostUsd));
  if (Array.isArray(allowTools) && allowTools.length) args.push('--allow-tools', ...allowTools);
  if (Array.isArray(tags)) for (const tag of tags) args.push('--tag', tag);
  return args;
}

function classifyExit(code) {
  if (code === 0) return 'ok';
  if (code === 1) return 'below-threshold';
  if (code === 2) return 'partial';
  if (code === 130 || code === 143) return 'interrupted';
  return 'failed';
}

const tail = (text, lines = 20) => (text || '').split('\n').slice(-lines).join('\n').trim();

function spawnExec(command, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** One case x one arm. Never throws for a broken cell — that would kill an entire compare. */
async function runCase(opts) {
  const { cell, arm, cases, env = {}, cwd, exec = spawnExec, ...argOpts } = opts;
  const args = buildArgs(argOpts);
  // The eval child sessions inherit CLAUDE_CODE_* from this process's env.
  const childEnv = { ...process.env, ...env, CLAUDE_CODE_EFFORT_LEVEL: cell.effort };
  const { code, stdout, stderr } = await exec('claude', ['plugin', 'eval', ...args], { cwd, env: childEnv });
  const outcome = classifyExit(code);
  if (outcome === 'interrupted') {
    throw new Error(`claude plugin eval was interrupted (exit ${code}): ${tail(stderr)}`);
  }
  if (outcome === 'failed') {
    return { records: [], raw: null, exitCode: code, outcome, error: tail(stderr), stdout };
  }
  // stdout only says where the payload went; the JSON at jsonPath is authoritative.
  const raw = JSON.parse(fs.readFileSync(argOpts.jsonPath, 'utf8'));
  const records = fromClaudeJson(raw, { cell, arm, cases });
  return { records, raw, exitCode: code, outcome, error: null, stdout };
}

module.exports = { buildArgs, classifyExit, spawnExec, runCase };
