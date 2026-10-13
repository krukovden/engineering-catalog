#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const HOURS = 24;
const POINTER_VERSION = 1;
const HOOK_VERSION = 1;
const ADO_BOARD_VERSION = 1;
const LINE = 'project state behind: run memory-init';

function projectDir() {
  return path.resolve(process.env.COPILOT_PROJECT_DIR || process.cwd());
}

function homeDir() {
  return path.resolve(process.env.ENGCAT_HOME || os.homedir());
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const i = args.indexOf('--hours');
  return { hours: i >= 0 && args[i + 1] ? Number(args[i + 1]) : HOURS };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function markerVersion(file, prefix, suffix = '') {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^\\s*${escapeRe(prefix)}(?: v=(\\d+))?${escapeRe(suffix)}\\s*$`, 'm');
  const m = re.exec(text);
  if (!m) return null;
  return m[1] ? Number(m[1]) : 0;
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function git(project, args) {
  return execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
}

function hookVersion(project) {
  try {
    let hooksDir = git(project, ['rev-parse', '--git-path', 'hooks']);
    if (!path.isAbsolute(hooksDir)) hooksDir = path.join(project, hooksDir);
    return markerVersion(path.join(hooksDir, 'post-commit'), '# engineering-catalog:memory:start');
  } catch {
    return null;
  }
}

function slug(text) {
  return String(text).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseRemoteUrl(url) {
  const value = String(url || '').trim();
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(value);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(value);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(value);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  return null;
}

function boardMapVersion(project, home) {
  const repoFile = path.join(project, '.engineering-catalog', 'ado-board.json');
  if (fs.existsSync(repoFile)) {
    const map = readJson(repoFile);
    return map.version == null ? 0 : Number(map.version);
  }
  let remote;
  try { remote = parseRemoteUrl(git(project, ['remote', 'get-url', 'origin'])); } catch { return null; }
  if (!remote) return null;
  const homeFile = path.join(home, '.engineering-catalog', 'ado-board', slug(remote.org), `${slug(remote.project)}.json`);
  if (!fs.existsSync(homeFile)) return null;
  const map = readJson(homeFile);
  return map.version == null ? 0 : Number(map.version);
}

function stateVersions(project, home) {
  const files = ['CLAUDE.md', 'AGENTS.md', path.join('.github', 'copilot-instructions.md')];
  const pointers = files
    .map((rel) => markerVersion(path.join(project, rel), '<!-- engineering-catalog:memory:start', ' -->'))
    .filter((v) => v != null);
  return {
    pointers,
    hook: hookVersion(project),
    board: boardMapVersion(project, home),
  };
}

function memoryBehind(versions) {
  return versions.pointers.some((v) => v < POINTER_VERSION)
    || (versions.hook != null && versions.hook < HOOK_VERSION);
}

function boardBehind(versions) {
  return versions.board != null && versions.board < ADO_BOARD_VERSION;
}

function isBehind(versions) {
  return memoryBehind(versions) || boardBehind(versions);
}

// Each component has its own repair: memory-init rewrites markers and the hook,
// `ado-board states discover` migrates the board map.
function lineFor(versions) {
  const fixes = [];
  if (memoryBehind(versions)) fixes.push('memory-init');
  if (boardBehind(versions)) fixes.push('ado-board states discover');
  return fixes.length ? `project state behind: run ${fixes.join(' and ')}` : null;
}

function signature(versions) {
  return JSON.stringify(versions);
}

function due(cache, key, nextSig, nowMs, hours) {
  const seen = cache[key];
  if (!seen || seen.signature !== nextSig) return true;
  return !(Date.parse(seen.lastNotified || '') > 0 && nowMs - Date.parse(seen.lastNotified) < hours * 3600000);
}

function main(argv) {
  try {
    const { hours } = parseArgs(argv);
    const project = projectDir();
    const home = homeDir();
    const versions = stateVersions(project, home);
    const key = project;
    const cacheFile = path.join(home, '.engineering-catalog', 'project-state.json');
    let cache = {};
    try { cache = readJson(cacheFile); } catch { /* first run */ }
    if (!isBehind(versions)) {
      if (cache[key]) {
        delete cache[key];
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');
      }
      return;
    }
    const nowIso = new Date().toISOString();
    const nextSig = signature(versions);
    if (!due(cache, key, nextSig, Date.parse(nowIso), hours)) return;
    cache[key] = { lastNotified: nowIso, signature: nextSig };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');
    process.stdout.write(`${lineFor(versions)}\n`);
  } catch {
    // Silent on every error: this is a hint, never a gate.
  }
}

if (require.main === module) main(process.argv);

module.exports = {
  POINTER_VERSION, HOOK_VERSION, ADO_BOARD_VERSION, LINE,
  markerVersion, parseRemoteUrl, slug, stateVersions, isBehind, lineFor,
};
