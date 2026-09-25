#!/usr/bin/env node
'use strict';
// memory-init.js — resumable initialisation of project memory (DESIGN §8.11).
// Self-contained on purpose: the skill directory is copied verbatim at install
// time. Only Node built-ins — no requires outside this file.
//   node memory-init.js --project <dir> [--dir memory] [--store committed|local] [--name <project name>] [--json]
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const START = '<!-- engineering-catalog:memory:start -->';
const END = '<!-- engineering-catalog:memory:end -->';
const HOOK_START = '# engineering-catalog:memory:start';
const HOOK_END = '# engineering-catalog:memory:end';

// managedBlock — replace the block between the markers in place, or append a
// new block (with a leading blank line) when the markers are absent. Same
// semantics regardless of comment style: pass the exact marker lines to use.
// A marker counts only when it is a whole line: a file that merely *mentions* the marker in
// prose (CLAUDE.md documents them) must not have its text swallowed as if it were the block.
function managedBlock(existing, start, end, content) {
  const block = `${start}\n${content}\n${end}`;
  const re = new RegExp(`^[ \\t]*${escapeRe(start)}[ \\t]*$[\\s\\S]*?^[ \\t]*${escapeRe(end)}[ \\t]*$`, 'm');
  if (re.test(existing)) return existing.replace(re, () => block);
  if (existing.length === 0) return `${block}\n`;
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${sep}${block}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opt = (k, def = null) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : def; };
  const project = opt('--project');
  if (!project) { throw new Error('usage: memory-init.js --project <dir> [--dir memory] [--store committed|local] [--name <project name>] [--json]'); }
  const dir = opt('--dir', 'memory');
  const store = opt('--store', 'committed');
  if (store !== 'committed' && store !== 'local') throw new Error(`--store must be "committed" or "local", got "${store}"`);
  const name = opt('--name', path.basename(path.resolve(project)));
  const json = args.includes('--json');
  return { project: path.resolve(project), dir, store, name, json };
}

function memoryDirFor(project, dir, store, home = process.env.ENGCAT_HOME || os.homedir()) {
  if (store === 'local') {
    const id = crypto.createHash('sha1').update(project).digest('hex');
    return path.join(home, '.engineering-catalog', 'memory', id);
  }
  return path.join(project, dir);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// --- steps -------------------------------------------------------------
// Each step takes ctx and returns { state: 'done'|'kept'|'skipped', detail }.

function stepFolder(ctx) {
  const unitsDir = path.join(ctx.memoryDir, 'units');
  const storeFile = path.join(ctx.memoryDir, '.store.json');
  const existed = fs.existsSync(unitsDir) && fs.existsSync(storeFile);
  fs.mkdirSync(unitsDir, { recursive: true });
  if (existed) return { state: 'kept', detail: ctx.memoryDir };
  // A committed store is shared through git, so it records the repo-relative posix dir;
  // a local store lives under the home directory and records where that is.
  const dir = ctx.store === 'local' ? ctx.memoryDir : toPosix(ctx.dir);
  fs.writeFileSync(storeFile, `${JSON.stringify({ store: ctx.store, dir, created: todayIso() }, null, 2)}\n`);
  return { state: 'done', detail: ctx.memoryDir };
}

function stepIndex(ctx) {
  const file = path.join(ctx.memoryDir, 'index.md');
  if (fs.existsSync(file)) return { state: 'kept', detail: file };
  const grade = '_Not yet written — the memory-init skill fills this in from the code, graded `inferred`._';
  const text = [
    '<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.',
    '     Machine-read fields: `reconciled-sha:` and `store:` lines. Keep it small; unit files win on conflict. -->',
    `# ${ctx.name} — memory index`,
    '',
    'reconciled-sha: none',
    `store: ${ctx.store}`,
    '',
    '## What this project is',
    grade,
    '',
    '## Architecture',
    grade,
    '',
    '## Units',
    '| Unit | Summary |',
    '|---|---|',
    '',
    '## Rejected at project level',
    `- (none recorded — history before ${todayIso()} predates tracking)`,
    '',
  ].join('\n');
  fs.writeFileSync(file, text);
  return { state: 'done', detail: file };
}

function pointerContent(ctx) {
  const memoryDirForPointer = ctx.store === 'local' ? toPosix(ctx.memoryDir) : toPosix(ctx.dir);
  const indexPath = ctx.store === 'local' ? toPosix(path.join(ctx.memoryDir, 'index.md')) : toPosix(path.join(ctx.dir, 'index.md'));
  const unitsPath = ctx.store === 'local' ? toPosix(path.join(ctx.memoryDir, 'units')) : toPosix(path.join(ctx.dir, 'units'));
  return [
    '## Project memory',
    `Read \`${indexPath}\` first. Load \`${unitsPath}/<slug>.md\` only when work touches that unit.`,
    'Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.',
    'A request for something listed under "Rejected at project level" is not implemented: quote the rejection and its reason, ask whether to overturn it, and change nothing until the person says yes.',
    'Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.',
    'Before reporting a task done, drain `<memory>/.pending` (the memory skill says how): read each queued commit, write an entry only if it passes the test, then mark the queue reconciled.'.replace('<memory>', memoryDirForPointer),
  ].join('\n');
}

function stepPointers(ctx) {
  const targets = ['CLAUDE.md', '.github/copilot-instructions.md', 'AGENTS.md'];
  const content = pointerContent(ctx);
  let anyDone = false;
  const detail = [];
  for (const rel of targets) {
    const file = path.join(ctx.project, rel);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const updated = managedBlock(existing, START, END, content);
    if (updated === existing) { detail.push(`${rel}: kept`); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, updated);
    anyDone = true;
    detail.push(`${rel}: done`);
  }
  return { state: anyDone ? 'done' : 'kept', detail: detail.join('; ') };
}

function stepHook(ctx) {
  let hooksDir;
  try {
    hooksDir = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: ctx.project, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (err) {
    return { state: 'skipped', detail: 'not a git repository' };
  }
  if (!path.isAbsolute(hooksDir)) hooksDir = path.join(ctx.project, hooksDir);
  fs.mkdirSync(hooksDir, { recursive: true });
  const hookFile = path.join(hooksDir, 'post-commit');
  // Hooks run with cwd = the working tree's top level, but the line must not depend on
  // that or on this machine: a committed store is found through git at run time, and a
  // local store's absolute path is written with forward slashes so sh reads it anywhere.
  const pendingFile = ctx.store === 'local'
    ? `${toPosix(ctx.memoryDir)}/.pending`
    : `$(git rev-parse --show-toplevel)/${toPosix(ctx.dir)}/.pending`;
  const content = `git rev-parse HEAD >> "${pendingFile}"`;
  const existing = fs.existsSync(hookFile) ? fs.readFileSync(hookFile, 'utf8') : '#!/bin/sh\n';
  const updated = managedBlock(existing, HOOK_START, HOOK_END, content);
  if (updated === existing) {
    fs.chmodSync(hookFile, 0o755);
    return { state: 'kept', detail: hookFile };
  }
  fs.writeFileSync(hookFile, updated);
  fs.chmodSync(hookFile, 0o755);
  return { state: 'done', detail: hookFile };
}

function stepGitignore(ctx) {
  if (ctx.store === 'local') return { state: 'skipped', detail: 'local store lives outside the repository' };
  const file = path.join(ctx.project, '.gitignore');
  const rel = toPosix(path.join(ctx.dir, '.pending'));
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const already = existing.split(/\r?\n/).some((l) => l.trim() === rel);
  if (already) return { state: 'kept', detail: file };
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(file, `${existing}${sep}${rel}\n`);
  return { state: 'done', detail: file };
}

const STEPS = [
  ['folder', stepFolder],
  ['index', stepIndex],
  ['pointers', stepPointers],
  ['hook', stepHook],
  ['gitignore', stepGitignore],
];

function main() {
  let ctx0;
  try {
    ctx0 = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const memoryDir = memoryDirFor(ctx0.project, ctx0.dir, ctx0.store);
  const ctx = { ...ctx0, memoryDir };
  const steps = [];
  let hadError = false;
  for (const [name, fn] of STEPS) {
    try {
      const { state, detail } = fn(ctx);
      steps.push({ name, state, detail });
    } catch (err) {
      steps.push({ name, state: 'error', detail: err.message });
      hadError = true;
    }
  }
  if (ctx.json) {
    console.log(JSON.stringify({ memoryDir, steps }));
  } else {
    console.log(`memory dir: ${memoryDir}`);
    for (const s of steps) console.log(`${s.name}\t${s.state}\t${s.detail}`);
  }
  process.exit(hadError ? 1 : 0);
}

if (require.main === module) main();

module.exports = { managedBlock, parseArgs, memoryDirFor, pointerContent, STEPS };
