'use strict';
// git without a shell: spawn with an argument array, stdin closed, never a prompt, a timeout per
// call. Every call resolves (never rejects) to { code, stdout, stderr, timedOut }.
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;

function git(args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // No credential prompt may wait on a terminal nobody is watching.
        env: { ...env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e.message, timedOut: false });
      return;
    }
    const out = [], err = [];
    let timedOut = false, done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish({ code: -1, stdout: '', stderr: e.message, timedOut }));
    child.on('close', (code) => finish({
      code: timedOut ? -1 : code,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8') + (timedOut ? `\ngit ${args[0]} timed out after ${Math.round(timeoutMs / 1000)} s` : ''),
      timedOut,
    }));
  });
}

// Runs fn over items with at most `limit` in flight; results keep the input order.
async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const firstLine = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

module.exports = { git, pool, firstLine, DEFAULT_TIMEOUT_MS };
