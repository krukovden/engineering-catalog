'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  imageTag,
  detectRuntime,
  available,
  wrapCommand,
  runInContainer,
} = require('../scripts/eval/isolation');

test('detectRuntime tries podman before docker and returns it on success', () => {
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    return 'podman version 4.0.0';
  };
  const runtime = detectRuntime({ exec });
  assert.equal(runtime, 'podman');
  assert.deepEqual(calls, ['podman']);
});

test('detectRuntime falls back to docker when podman fails, without retrying podman', () => {
  const calls = [];
  const exec = (cmd) => {
    calls.push(cmd);
    if (cmd === 'podman') throw new Error('not found');
    return 'Docker version 24.0.0';
  };
  const runtime = detectRuntime({ exec });
  assert.equal(runtime, 'docker');
  assert.deepEqual(calls, ['podman', 'docker']);
});

test('detectRuntime returns null when both fail', () => {
  const exec = () => { throw new Error('not found'); };
  assert.equal(detectRuntime({ exec }), null);
});

test('wrapCommand produces the documented argv shape for podman', () => {
  const result = wrapCommand({
    runtime: 'podman',
    command: 'claude',
    args: ['plugin', 'eval', '.'],
    cwd: '/work/dir',
    env: { GH_TOKEN: 'secret-value' },
    mounts: ['/host/cache:/cache:ro'],
  });
  assert.deepEqual(result, {
    command: 'podman',
    args: [
      'run', '--rm',
      '-v', '/work/dir:/work/dir:rw',
      '-w', '/work/dir',
      '-v', '/host/cache:/cache:ro',
      '-e', 'GH_TOKEN=secret-value',
      imageTag(),
      'claude', 'plugin', 'eval', '.',
    ],
  });
});

test('wrapCommand produces the documented argv shape for docker', () => {
  const result = wrapCommand({
    runtime: 'docker',
    command: 'copilot',
    args: ['-p', 'do the thing'],
    cwd: '/work/dir',
    env: {},
    mounts: [],
  });
  assert.deepEqual(result, {
    command: 'docker',
    args: [
      'run', '--rm',
      '-v', '/work/dir:/work/dir:rw',
      '-w', '/work/dir',
      imageTag(),
      'copilot', '-p', 'do the thing',
    ],
  });
});

test('wrapCommand forwards every env key as its own -e token and never leaks the value elsewhere', () => {
  const result = wrapCommand({
    runtime: 'podman',
    command: 'claude',
    args: ['plugin', 'eval'],
    cwd: '/work/dir',
    env: { GH_TOKEN: 'super-secret', OTHER: 'also-secret' },
    mounts: ['/host/data:/data:ro'],
  });
  const secretTokens = result.args.filter((a) => a === 'GH_TOKEN=super-secret' || a === 'OTHER=also-secret');
  assert.equal(secretTokens.length, 2);
  // every other argv entry must be free of the secret values, so nothing leaked into a mount
  // or working-directory argument.
  const others = result.args.filter((a) => a !== 'GH_TOKEN=super-secret' && a !== 'OTHER=also-secret');
  for (const arg of others) {
    assert.ok(!arg.includes('super-secret'), `unexpected leak in "${arg}"`);
    assert.ok(!arg.includes('also-secret'), `unexpected leak in "${arg}"`);
  }
  assert.deepEqual(result.args, [
    'run', '--rm',
    '-v', '/work/dir:/work/dir:rw',
    '-w', '/work/dir',
    '-v', '/host/data:/data:ro',
    '-e', 'GH_TOKEN=super-secret',
    '-e', 'OTHER=also-secret',
    imageTag(),
    'claude', 'plugin', 'eval',
  ]);
});

test('available is true/false exactly on runtime being non-null/null', () => {
  assert.equal(available({ runtime: 'podman' }), true);
  assert.equal(available({ runtime: 'docker' }), true);
  assert.equal(available({ runtime: null }), false);
  assert.equal(available({ runtime: undefined }), false);
});

test('runInContainer calls the injected exec with the wrapped command and returns its result verbatim', async () => {
  const seen = [];
  const exec = async (command, args, opts) => {
    seen.push({ command, args, opts });
    return { code: 0, stdout: 'ok', stderr: '' };
  };
  const result = await runInContainer({
    runtime: 'podman',
    command: 'claude',
    args: ['plugin', 'eval'],
    cwd: '/work/dir',
    env: { GH_TOKEN: 'secret' },
    mounts: [],
    exec,
  });
  assert.deepEqual(result, { code: 0, stdout: 'ok', stderr: '' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'podman');
  assert.deepEqual(seen[0].args, [
    'run', '--rm',
    '-v', '/work/dir:/work/dir:rw',
    '-w', '/work/dir',
    '-e', 'GH_TOKEN=secret',
    imageTag(),
    'claude', 'plugin', 'eval',
  ]);
  assert.equal(seen[0].opts.cwd, '/work/dir');
});

test('runInContainer never hands the container env to the runtime client itself', async () => {
  // Regression: the container env used to be passed to the host spawn as well as baked into argv.
  // A Copilot run forwards `HOME` pointed at its throwaway home, and the podman client then looks
  // for its connection config and socket in a home that has neither — every run died with
  // "Cannot connect to Podman" (exit 125) while the mocks stayed green. Caught by a live run.
  const seen = [];
  const exec = async (command, args, opts) => { seen.push({ args, opts }); return { code: 0, stdout: '', stderr: '' }; };
  await runInContainer({
    runtime: 'podman', command: 'copilot', args: ['-p', 'x'], cwd: '/work/dir',
    env: { HOME: '/tmp/fake-home', COPILOT_GITHUB_TOKEN: 'secret' }, mounts: [], timeoutMs: 1000, exec,
  });
  assert.equal(seen[0].opts.env, undefined, 'the client inherits the host environment, untouched');
  assert.equal(seen[0].opts.timeoutMs, 1000, 'the wall-clock kill still reaches the client');
  assert.ok(seen[0].args.includes('HOME=/tmp/fake-home'), 'the container still gets it, through -e');
  assert.ok(seen[0].args.includes('COPILOT_GITHUB_TOKEN=secret'));
});

test('Containerfile is valid at a basic level: FROM, no baked CMD/ENTRYPOINT, creates a non-root user', () => {
  const containerfilePath = path.join(__dirname, '..', 'evals', 'container', 'Containerfile');
  const text = fs.readFileSync(containerfilePath, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.ok(lines.some((l) => l.startsWith('FROM ')), 'expected a FROM line');
  assert.ok(!lines.some((l) => l.startsWith('CMD ') || l.startsWith('ENTRYPOINT ')), 'must not bake in a fixed script');
  assert.ok(lines.some((l) => /useradd/.test(l)), 'expected a non-root user to be created');
  assert.ok(lines.some((l) => l.startsWith('USER ') && !/^USER\s+root$/.test(l)), 'expected USER to switch away from root');
});
