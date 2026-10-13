'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tracked = new Set();
const tmpRoot = path.resolve(os.tmpdir());

function trackTempDir(dir) {
  if (typeof dir !== 'string' || !dir) return;
  const resolved = path.resolve(dir);
  if (resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`)) {
    tracked.add(resolved);
  }
}

function cleanupTracked() {
  for (const dir of Array.from(tracked)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Some temp dirs may already be removed when another cleanup path runs.
    }
    tracked.delete(dir);
  }
}

const originalMkdtempSync = fs.mkdtempSync.bind(fs);
fs.mkdtempSync = function trackedMkdtempSync(prefix, options) {
  const dir = originalMkdtempSync(prefix, options);
  trackTempDir(dir);
  return dir;
};

const originalMkdtemp = fs.mkdtemp.bind(fs);
fs.mkdtemp = function trackedMkdtemp(prefix, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = undefined;
  }

  return originalMkdtemp(prefix, options, (error, dir) => {
    if (!error) trackTempDir(dir);
    callback && callback(error, dir);
  });
};

process.on('beforeExit', cleanupTracked);
process.on('exit', cleanupTracked);
