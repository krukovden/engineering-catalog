#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const POINTER_START_PREFIX = '<!-- engineering-catalog:memory:start';
const POINTER_END = '<!-- engineering-catalog:memory:end -->';
const DEFAULT_PENDING_LIMIT = 20;

function parseArgs(argv) {
  const out = { json: false, pendingLimit: DEFAULT_PENDING_LIMIT, root: process.cwd(), home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--pending-limit') out.pendingLimit = Number(argv[++i] || DEFAULT_PENDING_LIMIT);
    else if (arg === '--root') out.root = path.resolve(argv[++i] || '.');
    else if (arg === '--home') out.home = path.resolve(argv[++i] || '.');
  }
  if (!Number.isFinite(out.pendingLimit) || out.pendingLimit < 0) throw new Error('--pending-limit must be a non-negative number');
  return out;
}

function stripJsonComments(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/^\uFEFF/, '')
    .replace(/("(?:\\.|[^"\\])*")|(\/\*[\s\S]*?\*\/)|(^[ \t]*\/\/[^\r\n]*)/gm, (match, str) => {
      if (str) return str;
      return '';
    });
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(stripJsonComments(raw));
  }
  catch { return null; }
}

function lines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function relative(root, file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') ? rel.split(path.sep).join('/') : file;
}

function recursiveStrings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => recursiveStrings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => recursiveStrings(item, out));
  return out;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function check(status, id, detail, fix, extra = {}) {
  return { status, id, detail, fix, ...extra };
}

function firstInstall(receipt) {
  return receipt && Array.isArray(receipt.installs) && receipt.installs.length ? receipt.installs[0] : null;
}

function hasCopilotInstall(receipt) {
  return !!(receipt && Array.isArray(receipt.installs) && receipt.installs.some((install) => install.target === 'copilot'));
}

function hasSkillTree(dir) {
  return fs.existsSync(path.join(dir, 'catalog-freshness', 'SKILL.md'))
    || fs.existsSync(path.join(dir, 'memory', 'SKILL.md'))
    || fs.existsSync(path.join(dir, 'catalog-doctor', 'SKILL.md'));
}

function pluginInstalled(home, config) {
  const strings = recursiveStrings(config && config.installedPlugins ? config.installedPlugins : []).filter((value) => /engineering-catalog/i.test(value));
  if (strings.length > 0) return true;
  const installed = path.join(home, '.copilot', 'installed-plugins');
  if (!fs.existsSync(installed)) return false;
  return fs.readdirSync(installed).some((entry) => /engineering-catalog/i.test(entry));
}

function copilotCollision(root, home) {
  const config = readJson(path.join(home, '.copilot', 'config.json'));
  const plugin = pluginInstalled(home, config);
  const localReceipt = readJson(path.join(root, '.engineering-catalog', 'receipt.json'));
  const globalReceipt = readJson(path.join(home, '.engineering-catalog', 'receipt.json'));
  const localCopy = hasCopilotInstall(localReceipt) || hasSkillTree(path.join(root, '.github', 'skills'));
  const globalCopy = hasCopilotInstall(globalReceipt) || hasSkillTree(path.join(home, '.copilot', 'skills'));
  if (plugin && (localCopy || globalCopy)) {
    const copies = [localCopy ? 'local engcat Copilot install' : null, globalCopy ? 'global engcat Copilot install' : null].filter(Boolean).join(' and ');
    return check('fail', 'copilot-namespace', `engineering-catalog is installed as a Copilot plugin and as a ${copies}`, 'Keep one Copilot delivery path: uninstall the plugin or remove the engcat Copilot install.');
  }
  return check('ok', 'copilot-namespace', 'No Copilot plugin / engcat install collision detected.', 'none');
}

function copilotTrusted(root, home) {
  const configFile = path.join(home, '.copilot', 'config.json');
  const config = readJson(configFile);
  if (!config) {
    return check('warn', 'copilot-trusted-folder', `Could not read ${configFile}; trust status is unknown.`, 'If you rely on repository hooks, add this repository to trustedFolders in ~/.copilot/config.json.');
  }
  const trusted = Array.isArray(config.trustedFolders) ? config.trustedFolders : null;
  if (!trusted) {
    return check('warn', 'copilot-trusted-folder', `${configFile} has no trustedFolders array; trust status is unknown.`, 'If you rely on repository hooks, add this repository to trustedFolders in ~/.copilot/config.json.');
  }
  if (trusted.some((entry) => samePath(entry, root))) {
    return check('ok', 'copilot-trusted-folder', 'Repository path is present in Copilot trustedFolders.', 'none');
  }
  return check('warn', 'copilot-trusted-folder', 'Repository path is absent from Copilot trustedFolders, so repository hooks will not load.', 'Add this repository path to trustedFolders in ~/.copilot/config.json.');
}

function sessionStartHooks(root) {
  const hits = [];
  const hooksDir = path.join(root, '.github', 'hooks');
  if (fs.existsSync(hooksDir)) {
    for (const name of fs.readdirSync(hooksDir).filter((entry) => entry.endsWith('.json')).sort()) {
      const file = path.join(hooksDir, name);
      const hook = readJson(file);
      const count = hook && hook.hooks && Array.isArray(hook.hooks.sessionStart) ? hook.hooks.sessionStart.length : 0;
      if (count > 0) hits.push(`${relative(root, file)} (${count})`);
    }
  }
  const claudeSettings = path.join(root, '.claude', 'settings.json');
  const settings = readJson(claudeSettings);
  const sessionStart = settings && settings.hooks && Array.isArray(settings.hooks.SessionStart) ? settings.hooks.SessionStart : [];
  if (sessionStart.length > 0) hits.push(`${relative(root, claudeSettings)} (${sessionStart.length})`);
  if (hits.length > 0) {
    return check('warn', 'session-start-hooks', `Repository defines sessionStart hooks in ${hits.join(', ')}.`, 'Keep at most one context-emitting sessionStart hook; fold extra messages into the existing hook.');
  }
  return check('ok', 'session-start-hooks', 'No repository-owned sessionStart hooks detected.', 'none');
}

function hasPointerBlock(file) {
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, 'utf8');
  return text.includes(POINTER_START_PREFIX) && text.includes(POINTER_END);
}

function configuredMemoryDir(root) {
  const pointerFiles = [
    path.join(root, 'CLAUDE.md'),
    path.join(root, 'AGENTS.md'),
    path.join(root, '.github', 'copilot-instructions.md'),
  ];
  for (const file of pointerFiles) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(POINTER_START_PREFIX) || !text.includes(POINTER_END)) continue;
    const match = /Read `([^`]+\/index\.md)` first\./.exec(text);
    if (!match) continue;
    const indexFile = path.isAbsolute(match[1]) ? match[1] : path.resolve(root, match[1]);
    return path.dirname(indexFile);
  }
  return path.join(root, 'memory');
}

function defaultGit(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim();
}

function isRepository(root, git = defaultGit) {
  try { return !!git(['rev-parse', '--show-toplevel'], root); } catch { return false; }
}

// Memory lives in a repository; a plain folder has nothing to point at.
function memoryState(root, pendingLimit, { git = defaultGit } = {}) {
  if (!isRepository(root, git)) {
    return check('skip', 'memory-pointers', 'Not a git repository; memory checks do not apply here.', 'none');
  }
  const pointers = [
    'CLAUDE.md',
    'AGENTS.md',
    path.join('.github', 'copilot-instructions.md'),
  ];
  const missing = pointers.filter((rel) => !hasPointerBlock(path.join(root, rel)));
  const memoryDir = configuredMemoryDir(root);
  const pendingFile = path.join(memoryDir, '.pending');
  const pending = lines(pendingFile);
  const pendingLabel = relative(root, pendingFile);
  if (missing.length === 0 && pending.length <= pendingLimit) {
    return check('ok', 'memory-pointers', `Memory pointer blocks are present and ${pendingLabel} has ${pending.length} entr${pending.length === 1 ? 'y' : 'ies'}.`, 'none');
  }
  const parts = [];
  if (missing.length) parts.push(`missing pointers: ${missing.map((rel) => rel.split(path.sep).join('/')).join(', ')}`);
  if (pending.length > pendingLimit) parts.push(`${pendingLabel} has ${pending.length} entries (limit ${pendingLimit})`);
  const fix = missing.length && pending.length > pendingLimit
    ? 'Re-run memory-init to restore pointer blocks, and drain the memory queue when the task is done.'
    : missing.length
      ? 'Re-run memory-init to restore pointer blocks.'
      : 'Drain the memory queue when the task is done.';
  return check('warn', 'memory-pointers', parts.join('; '), fix);
}

function nodeState() {
  try {
    const version = execFileSync('node', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return check('ok', 'node', `node is on PATH (${version}).`, 'none');
  } catch {
    return check('fail', 'node', 'node is not on PATH.', 'Install Node 20+ and re-run catalog-doctor.');
  }
}

// https://dev.azure.com/ORG/PROJECT/_git/REPO, https://ORG.visualstudio.com/[DefaultCollection/]PROJECT/_git/REPO,
// git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO.
function azureRemote(url) {
  const u = String(url || '').trim();
  const dec = (v) => { try { return decodeURIComponent(v); } catch { return v; } };
  const forms = [
    /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//i,
    /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i,
    /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|\/)v3\/([^/]+)\/([^/]+)\//i,
  ];
  for (const re of forms) {
    const m = re.exec(u);
    if (m) return { org: dec(m[1]), project: dec(m[2]) };
  }
  return null;
}

const orgUrl = (org) => (/^https?:\/\//i.test(org) ? org : `https://dev.azure.com/${org}`);
const orgName = (org) => {
  const raw = String(org || '').trim();
  const m = /dev\.azure\.com\/([^/]+)/i.exec(raw) || /^https?:\/\/([^./]+)\.visualstudio\.com/i.exec(raw);
  return m ? m[1] : raw;
};

// The organization (and project) the credential should be proven against: ADO_ORG/ADO_PROJECT,
// else this repository's Azure Repos origin, else the one board ~/.engineering-catalog/repos.json maps.
function adoContext(root, home, env = process.env, git = defaultGit) {
  if (env.ADO_ORG) return { org: env.ADO_ORG, project: env.ADO_PROJECT || null, source: 'ADO_ORG' };
  try {
    const remote = azureRemote(git(['remote', 'get-url', 'origin'], root));
    if (remote) return { ...remote, source: 'origin' };
  } catch { /* not a repository, or no origin */ }
  const map = readJson(path.join(env.ENGCAT_HOME || home, '.engineering-catalog', 'repos.json'));
  const boards = new Map();
  for (const entry of Object.values(map && typeof map === 'object' ? map : {})) {
    const b = entry && entry.board;
    if (b && b.org && b.project) boards.set(`${orgName(b.org)}/${b.project}`.toLowerCase(), { org: orgName(b.org), project: b.project });
  }
  if (boards.size === 1) return { ...[...boards.values()][0], source: 'repos.json' };
  return null;
}

const NO_ORG_FIX = 'Nobody told the catalog which Azure DevOps organization you work in. Open your team\'s board in the browser, copy its link (https://dev.azure.com/<organization>/<project>), and give it to ado-credentials.';

function adoState(ctx = null) {
  const root = path.join(__dirname, '..', '..', 'ado-credentials', 'scripts');
  const isWindows = process.platform === 'win32';
  // check.ps1 reads the organization from its saved contexts; only check.sh takes --org.
  const target = !isWindows && ctx && ctx.org ? ['--org', orgUrl(ctx.org), ...(ctx.project ? ['--project', ctx.project] : [])] : [];
  const command = isWindows
    ? ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'check.ps1')]]
    : ['sh', [path.join(root, 'check.sh'), ...target]];
  const fixFor = (parsed) => {
    if (/no organization/i.test(parsed.detail || '')) return NO_ORG_FIX;
    return Array.isArray(parsed.steps) && parsed.steps.length ? parsed.steps[0] : 'Run ado-credentials and follow its steps.';
  };
  try {
    const stdout = execFileSync(command[0], command[1], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    const parsed = JSON.parse(stdout || '{}');
    if (parsed.outcome === 'ok') return check('ok', 'ado-credentials', parsed.detail || 'Azure DevOps credential is working.', 'none');
    const status = parsed.outcome === 'error' ? 'fail' : 'warn';
    return check(status, 'ado-credentials', parsed.detail || `Azure DevOps credential check returned ${parsed.outcome || 'unknown'}.`, fixFor(parsed));
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr).trim() : '';
    const stdout = err && err.stdout ? String(err.stdout).trim() : '';
    const body = stderr || stdout || err.message;
    try {
      const parsed = JSON.parse(stdout || '{}');
      const status = parsed.outcome === 'error' ? 'fail' : 'warn';
      return check(status, 'ado-credentials', parsed.detail || body, fixFor(parsed));
    } catch {
      return check('fail', 'ado-credentials', body || 'ado-credentials check failed.', 'Run ado-credentials directly and follow its output.');
    }
  }
}

function collectChecks(options, deps = {}) {
  const ado = deps.adoState || adoState;
  const git = deps.git || defaultGit;
  return [
    copilotCollision(options.root, options.home),
    copilotTrusted(options.root, options.home),
    sessionStartHooks(options.root),
    nodeState(),
    memoryState(options.root, options.pendingLimit, { git }),
    ado(adoContext(options.root, options.home, deps.env || process.env, git)),
  ];
}

function renderText(result) {
  return result.checks.map((item) => `${item.status}\t${item.id}\t${item.detail}\tfix: ${item.fix}`).join('\n');
}

function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const result = { root: options.root, home: options.home, checks: collectChecks(options) };
  return options.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderText(result)}\n`;
}

if (require.main === module) process.stdout.write(run());

module.exports = {
  DEFAULT_PENDING_LIMIT,
  parseArgs,
  collectChecks,
  copilotCollision,
  copilotTrusted,
  sessionStartHooks,
  memoryState,
  nodeState,
  adoState,
  adoContext,
  azureRemote,
  isRepository,
  stripJsonComments,
  POINTER_START_PREFIX,
  POINTER_END,
  hasPointerBlock,
  configuredMemoryDir,
  run,
};
