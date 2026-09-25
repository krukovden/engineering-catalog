'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildArgs, classifyExit, runCase } = require('../scripts/eval/claude');

const FIXTURE = path.join(__dirname, 'fixtures/eval/claude-eval-shape.json');
const CELL = { target: 'claude', model: 'claude-haiku-4-5', effort: 'low' };

test('buildArgs emits every flag for a full option set', () => {
  const args = buildArgs({
    pluginDir: '.', evalDir: 'evals', caseName: 'trigger-x', tags: ['trigger:positive', 'unit:safety-ssh'],
    runs: 2, model: 'claude-haiku-4-5', judgeModel: 'claude-opus-5', allowTools: ['Bash', 'Read'],
    maxCostUsd: 5, outputDir: 'out', jsonPath: 'out/run.json', concurrency: 3,
  });
  assert.deepEqual(args, [
    '.', '--eval-dir', 'evals', '--ablation', 'none', '--trust-plugin', '--no-publish',
    '--json', 'out/run.json', '--output-dir', 'out',
    '--case', 'trigger-x', '--runs', '2', '--model', 'claude-haiku-4-5', '--judge-model', 'claude-opus-5',
    '-j', '3', '--max-cost-usd', '5', '--allow-tools', 'Bash', 'Read',
    '--tag', 'trigger:positive', '--tag', 'unit:safety-ssh',
  ]);
});

test('buildArgs omits every optional flag when the input is absent, but always carries the fixed ones', () => {
  const args = buildArgs({ pluginDir: '.', outputDir: 'out', jsonPath: 'out/run.json' });
  assert.deepEqual(args, ['.', '--eval-dir', 'evals', '--ablation', 'none', '--trust-plugin', '--no-publish', '--json', 'out/run.json', '--output-dir', 'out']);
  for (const flag of ['--case', '--runs', '--model', '--judge-model', '-j', '--max-cost-usd', '--allow-tools', '--tag']) {
    assert.ok(!args.includes(flag), `did not expect ${flag}`);
  }
});

test('buildArgs passes --scaffold only for a case that has one, right after the fixed flags', () => {
  const withScaffold = buildArgs({ pluginDir: '.', outputDir: 'out', jsonPath: 'out/run.json', scaffold: true, caseName: 'behaviour-x' });
  assert.deepEqual(withScaffold, [
    '.', '--eval-dir', 'evals', '--ablation', 'none', '--trust-plugin', '--no-publish',
    '--json', 'out/run.json', '--output-dir', 'out', '--scaffold', '--case', 'behaviour-x',
  ]);
  const without = buildArgs({ pluginDir: '.', outputDir: 'out', jsonPath: 'out/run.json', scaffold: false, caseName: 'trigger-x' });
  assert.ok(!without.includes('--scaffold'));
});

test('classifyExit covers every documented code', () => {
  assert.equal(classifyExit(0), 'ok');
  assert.equal(classifyExit(1), 'below-threshold');
  assert.equal(classifyExit(2), 'partial');
  assert.equal(classifyExit(130), 'interrupted');
  assert.equal(classifyExit(143), 'interrupted');
  assert.equal(classifyExit(17), 'failed');
});

test('runCase reads the JSON from jsonPath, sets CLAUDE_CODE_EFFORT_LEVEL from the cell, and normalises to records', async () => {
  const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-run-')), 'run.json');
  let capturedEnv;
  const exec = async (command, args, opts) => {
    assert.equal(command, 'claude');
    assert.deepEqual(args.slice(0, 2), ['plugin', 'eval']);
    capturedEnv = opts.env;
    fs.copyFileSync(FIXTURE, jsonPath);
    return { code: 0, stdout: `wrote ${jsonPath}`, stderr: '' };
  };
  const result = await runCase({
    cell: CELL, arm: 'candidate', cases: new Map(), exec,
    pluginDir: '.', outputDir: path.dirname(jsonPath), jsonPath,
  });
  assert.equal(capturedEnv.CLAUDE_CODE_EFFORT_LEVEL, 'low');
  assert.equal(result.outcome, 'ok');
  assert.equal(result.exitCode, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].arm, 'candidate');
  assert.equal(result.raw.schemaVersion, 1);
});

test('runCase treats a below-threshold exit as normal — the JSON is still authoritative', async () => {
  const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-run-')), 'run.json');
  const exec = async () => {
    fs.copyFileSync(FIXTURE, jsonPath);
    return { code: 1, stdout: '', stderr: '' };
  };
  const result = await runCase({ cell: CELL, arm: 'base', cases: new Map(), exec, pluginDir: '.', outputDir: path.dirname(jsonPath), jsonPath });
  assert.equal(result.outcome, 'below-threshold');
  assert.equal(result.records.length, 1);
});

test('runCase rejects on an interrupted exit code instead of returning a record', async () => {
  const exec = async () => ({ code: 130, stdout: '', stderr: 'killed by signal' });
  await assert.rejects(
    () => runCase({ cell: CELL, arm: 'candidate', cases: new Map(), exec, pluginDir: '.', outputDir: '/tmp', jsonPath: '/tmp/never-read.json' }),
    /interrupted/,
  );
});

test('runCase returns outcome "failed" with no records rather than throwing, carrying the stderr tail', async () => {
  const exec = async () => ({ code: 17, stdout: '', stderr: 'line1\nline2\nboom: something broke' });
  const result = await runCase({ cell: CELL, arm: 'candidate', cases: new Map(), exec, pluginDir: '.', outputDir: '/tmp', jsonPath: '/tmp/never-read.json' });
  assert.equal(result.outcome, 'failed');
  assert.deepEqual(result.records, []);
  assert.match(result.error, /boom: something broke/);
});
