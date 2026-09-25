'use strict';
// Optional container isolation for the eval harness (DESIGN.md §12). The two arms do not start
// from the same place: `claude plugin eval` sandboxes shell tools at the OS level itself, while
// `copilot` is launched with --allow-all-tools --allow-all-paths and has nothing but a throwaway
// HOME and workdir between a case and the operator's machine. So a container is a nice-to-have on
// the Claude arm (and mandatory only for a case that says so) and the real containment on the
// Copilot one. `exec` is always injected so tests never launch a real container runtime.
const { execFileSync, spawn } = require('child_process');

const IMAGE_TAG = 'engcat-eval:local';
const CONTAINERFILE = 'evals/container/Containerfile';

function imageTag() {
  return IMAGE_TAG;
}

function execSync(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' });
}

/** Podman first (this repo's own decisions prefer it where both exist), then docker, else null. Never throws. */
function detectRuntime({ exec = execSync } = {}) {
  for (const runtime of ['podman', 'docker']) {
    try {
      exec(runtime, ['--version']);
      return runtime;
    } catch {
      // not installed, or not on PATH — try the next candidate
    }
  }
  return null;
}

/** True when a usable runtime exists — reads as `if (!available({ runtime }))` at call sites. */
function available({ runtime }) {
  return runtime !== null && runtime !== undefined;
}

/** Builds the image. Idempotent by the runtime's own layer cache — no "already built" tracking here. */
function buildImage({ runtime, root, exec = execSync }) {
  return exec(runtime, ['build', '-t', imageTag(), '-f', CONTAINERFILE, root]);
}

/**
 * Wraps a native command so it runs inside the container instead. Every `env` entry is forwarded
 * as its own `-e NAME=value` through the runtime's env-forwarding — never written to a file or
 * baked into the image — so a secret only ever appears in that one argv token.
 */
function wrapCommand({ runtime, command, args = [], cwd, env = {}, mounts = [] }) {
  const runArgs = ['run', '--rm', '-v', `${cwd}:${cwd}:rw`, '-w', cwd];
  for (const mount of mounts) {
    runArgs.push('-v', mount);
  }
  for (const [name, value] of Object.entries(env)) {
    runArgs.push('-e', `${name}=${value}`);
  }
  runArgs.push(imageTag(), command, ...args);
  return { command: runtime, args: runArgs };
}

function spawnInContainer(command, args, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    // `env` is for the *container* and is already baked into argv as `-e NAME=value` (see
    // wrapCommand). It must not reach the podman/docker client this spawns: passing it as
    // `spawn`'s own `env` replaces this process's environment and wipes PATH, and merging it on
    // is no better — a container `HOME` pointed at a throwaway directory sends the client looking
    // for its connection config and socket in a home that has neither, and every run dies with
    // "Cannot connect to Podman" (exit 125). `runInContainer` therefore does not forward it, and
    // a caller reaching this directly gets a merge rather than a replacement.
    const child = spawn(command, args, { cwd, env: env ? { ...process.env, ...env } : undefined });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // The Copilot arm has no turn limit of its own and leans entirely on a wall-clock kill; losing
    // it inside the container would turn a runaway run into a hung compare. Killing the runtime
    // client takes the `--rm` container with it.
    const timer = timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs)
      : null;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}

/** Wraps then runs, returning the same `{ code, stdout, stderr }` shape as claude.js's spawnExec
 *  (plus copilot.js's `timedOut`, so either arm's `runCase` can consume it unchanged). */
async function runInContainer({ runtime, command, args, cwd, env, mounts, timeoutMs, exec = spawnInContainer }) {
  const wrapped = wrapCommand({ runtime, command, args, cwd, env, mounts });
  // No `env` here on purpose — it belongs to the container, and the client needs the host's own.
  return exec(wrapped.command, wrapped.args, { cwd, timeoutMs });
}

module.exports = {
  imageTag,
  execSync,
  detectRuntime,
  available,
  buildImage,
  wrapCommand,
  spawnInContainer,
  runInContainer,
};
