'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');
const { ROOT, hashContent, hashFile } = require('../lib/units');
const inst = require('../lib/install');
const upd = require('../lib/update');
const rc = require('../lib/receipt');
const claude = require('../lib/adapters/claude');

const USAGE = `engcat — install and update the engineering catalog for Claude Code and GitHub Copilot.

  engcat install [--bundle all|<a,b>] [--target claude|copilot|both] [--global|--local] [--version <v>] [--yes] [--keep-local|--overwrite]
  engcat update  [--global|--local] [--target …] [--keep-local|--overwrite] [--yes]
  engcat status  [--global|--local]
  engcat check
  engcat list

Anything you leave out is asked interactively. Scope defaults to --global (recommended, §7.1)
once --bundle and --target are both given, so a one-liner never touches stdin.
--yes takes the default answer where one exists (scope → global); it never overwrites a
local edit — say --overwrite or --keep-local for that. install applies the same rule to any
file already on disk at a path it would write, catalog-managed or not: differs → asked,
--overwrite replaces it, --keep-local leaves it and the catalog's copy goes unwritten.
Pin a version with npx git+<source>#v<version> and pass --version <version> to prove it.`;

/**
 * Line-queue prompter that works for both interactive TTY and piped (non-TTY) stdin.
 * Sequential readline.question() calls drop lines on piped EOF, so we buffer every line
 * and hand them out one ask() at a time, resolving to '' once input is exhausted.
 */
function createPrompter(stdin, stdout) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()('');
  });

  function ask(prompt) {
    stdout.write(prompt);
    return new Promise((resolve) => {
      if (queue.length) resolve(queue.shift());
      else if (closed) resolve('');
      else waiters.push(resolve);
    }).then((a) => String(a).trim());
  }

  return { ask, close: () => rl.close() };
}

/** Parse a selection string like "1,3" or "all" against a list length. Returns indices. */
function parseSelection(input, length) {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'all') return [...Array(length).keys()];
  const indices = [];
  for (const part of trimmed.split(',')) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isInteger(n) && n >= 1 && n <= length) indices.push(n - 1);
  }
  return [...new Set(indices)];
}

/**
 * Pure: turn argv into the answers the commands would otherwise prompt for. Every field is
 * empty when the flag was absent — the caller asks for what is missing rather than guessing.
 * Unknown options are collected instead of thrown so they can all be reported at once.
 */
function parseArgs(argv = []) {
  const out = { command: null, bundles: [], targets: [], scope: null, yes: false, keepLocal: false, overwrite: false, version: null, help: false, errors: [] };
  const list = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
  const setTargets = (v) => { out.targets = list(v).flatMap((t) => (t === 'both' ? ['claude', 'copilot'] : [t])); };
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (!out.command && !arg.startsWith('-')) { out.command = arg; continue; }
    if (arg === '-h' || arg === '--help') out.help = true;
    else if (arg === '-g' || arg === '--global') out.scope = 'global';
    else if (arg === '-l' || arg === '--local') out.scope = 'local';
    else if (arg === '-y' || arg === '--yes') out.yes = true;
    else if (arg === '--keep-local') out.keepLocal = true;
    else if (arg === '--overwrite') out.overwrite = true;
    else {
      const m = /^(?:-(b|t|v)|--(bundle|target|version))(?:=(.*))?$/.exec(arg);
      if (!m) { out.errors.push(`unknown option "${arg}"`); continue; }
      const key = { b: 'bundle', t: 'target', v: 'version' }[m[1]] || m[2];
      let value = m[3];
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || String(value).startsWith('-')) { out.errors.push(`${arg} needs a value`); continue; }
        i += 1;
      }
      if (key === 'bundle') out.bundles.push(...list(value));
      else if (key === 'target') setTargets(value);
      else out.version = String(value);
    }
  }
  if (out.keepLocal && out.overwrite) out.errors.push('--keep-local and --overwrite contradict each other');
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortHash = (v) => String(v).slice(0, 6);

/** Everything a command needs, built once per run. */
function makeContext(args, io, catalog) {
  const out = (s) => io.stdout.write(`${s}\n`);
  const err = (s) => io.stderr.write(`${s}\n`);
  // Opened lazily: a fully-specified run must never touch stdin, or it hangs under npx
  // in CI and in any non-interactive shell.
  let prompter = null;
  const ask = (question) => {
    if (!prompter) prompter = createPrompter(io.stdin, io.stdout);
    return prompter.ask(question);
  };
  const close = () => { if (prompter) prompter.close(); };
  return { args, io, catalog, root: io.root, cwd: io.cwd, home: io.home, out, err, ask, close };
}

async function pickBundles(ctx) {
  const { catalog, out, ask } = ctx;
  if (!catalog.bundles.length) throw new Error('the catalog has no bundles');
  out('\nWhich bundle?');
  catalog.bundles.forEach((b, i) => out(`  ${i + 1}. ${b.name} — ${b.description || b.audience || ''}`.trimEnd()));
  const answer = await ask('\nSelect (e.g. 1,3) — Enter installs everything: ');
  if (answer.trim() === '') return catalog.bundles.map((b) => b.name);
  const indices = parseSelection(answer, catalog.bundles.length);
  if (!indices.length) return null;
  return indices.map((i) => catalog.bundles[i].name);
}

async function pickTargets(ctx) {
  const { out, ask } = ctx;
  const ids = Object.keys(inst.ADAPTERS);
  out('\nWhich tool?');
  ids.forEach((id, i) => out(`  ${i + 1}. ${inst.ADAPTERS[id].label}`));
  out(`  ${ids.length + 1}. Both`);
  const answer = await ask('> ');
  const n = Number.parseInt(answer, 10);
  if (n === ids.length + 1) return ids;
  if (Number.isInteger(n) && n >= 1 && n <= ids.length) return [ids[n - 1]];
  return null;
}

async function pickScope(ctx) {
  const { out, ask, home, cwd } = ctx;
  out('\nInstall where?');
  out(`  1. Global — all projects (${home})  [default]`);
  out(`  2. This project (${cwd})`);
  const answer = await ask('> ');
  if (answer === '' || answer === '1') return 'global';
  if (answer === '2') return 'local';
  return null;
}

/** Scope for install: flag → default when fully specified → --yes → prompt. */
async function resolveScope(ctx, { defaultWhen }) {
  const { args } = ctx;
  if (args.scope) return args.scope;
  if (defaultWhen || args.yes) return 'global';
  return pickScope(ctx);
}

async function cmdInstall(ctx) {
  const { args, catalog, root, cwd, home, out, err, ask } = ctx;
  const fullySpecified = args.bundles.length > 0 && args.targets.length > 0;
  // `--bundle all` and an empty answer at the picker both mean every bundle: the recommended
  // install is everything, globally, for both tools.
  let bundles = args.bundles.some((b) => b.toLowerCase() === 'all') ? catalog.bundles.map((b) => b.name) : args.bundles;
  let targets = args.targets;
  if (!bundles.length) {
    bundles = await pickBundles(ctx);
    if (!bundles) { err('Nothing selected. Aborting.'); return 1; }
  }
  if (!targets.length) {
    targets = await pickTargets(ctx);
    if (!targets) { err('Unknown choice. Aborting.'); return 1; }
  }
  const scope = await resolveScope(ctx, { defaultWhen: fullySpecified });
  if (!scope) { err('Unknown choice. Aborting.'); return 1; }

  const baseDir = inst.baseDirFor(scope, cwd, home);
  const receipt = rc.readReceipt(baseDir);
  let code = 0;
  for (const target of targets) {
    const label = inst.ADAPTERS[target].label;
    // A second install at the same target and scope adds to what is already there: the
    // receipt record (and the planned unit set) must keep covering every bundle installed.
    const existing = rc.findInstall(receipt, target, scope);
    const existingBundles = existing ? existing.bundles : [];
    const allBundles = [...existingBundles, ...bundles.filter((b) => !existingBundles.includes(b))];
    const { plans: [plan] } = inst.planInstall({ root, catalog, bundles: allBundles, targets: [target], scope });
    out(`\n${label} (${scope}) → ${baseDir}`);
    if (existingBundles.length) out(`  adding to: ${existingBundles.join(', ')}`);
    for (const { unit } of plan.items) out(`  ✓ ${unit.kind} ${unit.name}`);
    for (const { unit, reason } of plan.skipped) out(`  – ${unit.kind} ${unit.name} — skipped: ${reason}`);
    if (!plan.items.length) {
      err(`Error: nothing to install for ${label} — every unit was skipped`);
      code = 1;
      continue;
    }

    // A file already on disk that would come out different — whether hand-authored and
    // never installed by this catalog, or left over from an older install — is never
    // overwritten silently (mirrors cmdUpdate's local-edit protection, §7.3).
    const kept = new Set();
    for (const item of plan.items) {
      for (const o of item.outputs) {
        const abs = path.join(baseDir, o.path);
        if (!fs.existsSync(abs) || hashFile(abs) === hashContent(o.content)) continue;
        out(`  ! ${o.path} already exists and differs`);
        let overwrite = args.overwrite;
        if (!args.overwrite && !args.keepLocal) {
          overwrite = /^y(es)?$/i.test(await ask(`Overwrite ${o.path}? [y/N] `));
        }
        if (!overwrite) kept.add(o.path);
      }
    }

    const { written } = inst.applyInstall({ plan, baseDir, catalog, bundles: allBundles, kept });
    if (kept.size) out(`  kept ${plural(kept.size, 'file')} as-is: ${[...kept].join(', ')}`);
    out(`Installed ${plural(plan.items.length, 'unit')} (${written.length} files) for ${label} (${scope}) into ${baseDir}; receipt: ${rc.receiptPath(baseDir)}`);
  }
  return code;
}

/** The install records at the chosen scope, narrowed by --target when given. */
function recordsAt(ctx, scope) {
  const { args, cwd, home } = ctx;
  const baseDir = inst.baseDirFor(scope, cwd, home);
  const receipt = rc.readReceipt(baseDir);
  let records = receipt.installs.filter((r) => r.scope === scope);
  if (args.targets.length) records = records.filter((r) => args.targets.includes(r.target));
  return { baseDir, receipt, records };
}

async function cmdUpdate(ctx) {
  const { args, catalog, root, out, err, ask } = ctx;
  const scope = await resolveScope(ctx, { defaultWhen: false });
  if (!scope) { err('Unknown choice. Aborting.'); return 1; }
  const { baseDir, records } = recordsAt(ctx, scope);
  if (!records.length) { err(`nothing installed here (${baseDir}, ${scope}) — run engcat install`); return 1; }

  // Refuse before touching anything: a downgrade of one record is a downgrade of the whole run.
  for (const record of records) {
    if (upd.compareVersions(catalog.version, record.catalogVersion) < 0) {
      err(`installed ${record.catalogVersion} is newer than this catalog ${catalog.version} — pass --version or run the newer catalog`);
      return 1;
    }
  }

  let receipt = rc.readReceipt(baseDir);
  for (const record of records) {
    const label = inst.ADAPTERS[record.target] ? inst.ADAPTERS[record.target].label : record.target;
    out(`\n${label} (${scope}) → ${baseDir}: ${record.catalogVersion} → ${catalog.version}`);
    const { plans } = inst.planInstall({ root, catalog, bundles: record.bundles, targets: [record.target], scope });
    const plan = plans[0];

    const diff = upd.diffUnits(record, plan);
    for (const u of diff.added) out(`  + ${u.kind} ${u.name}`);
    for (const { unit, from } of diff.changed) out(`  ~ ${unit.kind} ${unit.name} ${shortHash(from)} → ${shortHash(unit.version)}`);
    for (const u of diff.removed) out(`  - ${u.kind} ${u.name}`);
    out(`  = ${diff.unchanged.length} unchanged`);

    // Local edits are never overwritten silently (§7.3): every edited file is named, and
    // the user decides — unless a flag already answered for all of them. A stale file is
    // about to be deleted, not overwritten, so the question says so.
    const stale = upd.staleFiles(record, plan);
    const kept = new Set();
    for (const edit of upd.detectLocalEdits(record, baseDir)) {
      if (edit.status !== 'edited') continue;
      out(`  ! ${edit.file} was edited locally`);
      let overwrite = args.overwrite;
      if (!args.overwrite && !args.keepLocal) {
        const question = stale.includes(edit.file)
          ? `Delete ${edit.file} (no longer in the catalog)? [y/N] `
          : `Overwrite ${edit.file}? [y/N] `;
        overwrite = /^y(es)?$/i.test(await ask(question));
      }
      if (!overwrite) kept.add(edit.file);
    }

    // Write what differs on disk; a file the user kept is left alone.
    let written = 0;
    for (const item of plan.items) {
      for (const o of item.outputs) {
        if (kept.has(o.path)) continue;
        const abs = path.join(baseDir, o.path);
        if (fs.existsSync(abs) && hashFile(abs) === hashContent(o.content)) continue;
        claude.writeOutputs([o], baseDir);
        written += 1;
      }
    }
    let removed = 0;
    const unmanaged = [];
    for (const file of stale) {
      if (kept.has(file)) {
        out(`  kept ${file} — no longer managed by the catalog; delete it by hand when you are done with it`);
        unmanaged.push(file);
        continue;
      }
      const abs = path.join(baseDir, file);
      if (fs.existsSync(abs)) { fs.rmSync(abs); removed += 1; }
      pruneEmptyDirs(path.dirname(abs), baseDir);
    }

    // Kept files keep their old hash so the next update flags them again.
    const next = rc.recordFromOutputs({
      target: record.target, scope, catalogVersion: catalog.version, source: catalog.source,
      bundles: record.bundles, planned: plan.items,
    });
    const oldHashes = new Map(record.units.flatMap((u) => Object.entries(u.files)));
    for (const unit of next.units) {
      for (const file of Object.keys(unit.files)) if (kept.has(file) && oldHashes.has(file)) unit.files[file] = oldHashes.get(file);
    }
    receipt = rc.upsertInstall(receipt, next);
    rc.writeReceipt(baseDir, receipt);

    const keptManaged = [...kept].filter((f) => !unmanaged.includes(f));
    const notes = [];
    if (keptManaged.length) notes.push(`${plural(keptManaged.length, 'local edit')} kept (${keptManaged.join(', ')})`);
    if (unmanaged.length) notes.push(`${plural(unmanaged.length, 'file')} left unmanaged (${unmanaged.join(', ')})`);
    out(`Updated ${label} (${scope}) to ${catalog.version}: ${plural(written, 'file')} written, ${removed} removed${notes.map((n) => `, ${n}`).join('')}`);
  }
  return 0;
}

/** Remove directories left empty by a deleted file, stopping at the base dir. */
function pruneEmptyDirs(dir, baseDir) {
  const stop = path.resolve(baseDir);
  let current = path.resolve(dir);
  while (current !== stop && current.startsWith(stop)) {
    try {
      if (fs.readdirSync(current).length) return;
      fs.rmdirSync(current);
    } catch { return; }
    current = path.dirname(current);
  }
}

async function cmdStatus(ctx) {
  const { out, err } = ctx;
  const scope = await resolveScope(ctx, { defaultWhen: false });
  if (!scope) { err('Unknown choice. Aborting.'); return 1; }
  const { baseDir, records } = recordsAt(ctx, scope);
  if (!records.length) { out(`nothing installed here (${baseDir}, ${scope}) — run engcat install`); return 0; }
  for (const record of records) {
    const label = inst.ADAPTERS[record.target] ? inst.ADAPTERS[record.target].label : record.target;
    out(`\n${record.target} — ${label} (${record.scope}) in ${baseDir}`);
    out(`  catalog ${record.catalogVersion}, installed ${record.date}`);
    out(`  bundles: ${record.bundles.join(', ') || '(none)'}; ${plural(record.units.length, 'unit')}`);
    for (const u of record.units) out(`    ${u.kind} ${u.name} ${shortHash(u.version)}`);
    const edits = upd.detectLocalEdits(record, baseDir);
    for (const e of edits) out(`  ! ${e.file} ${e.status === 'missing' ? 'is missing' : 'was edited locally'}`);
    if (!edits.length) out('  no local edits');
  }
  return 0;
}

function cmdCheck(ctx) {
  const { catalog, out, err } = ctx;
  const source = catalog.source;
  if (!source) { err('the catalog records no source to check against'); return 1; }
  let text;
  try {
    text = execFileSync('git', ['ls-remote', '--tags', source], { timeout: 10000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const detail = ((e.stderr && String(e.stderr).trim()) || e.message).split('\n')[0];
    err(`could not reach ${source}: ${detail}`);
    return 1;
  }
  const versions = [];
  for (const line of String(text).split('\n')) {
    const m = /refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim());
    if (m) versions.push(m[1]);
  }
  if (!versions.length) { out(`no version tags on ${source}; running ${catalog.version}`); return 0; }
  versions.sort(upd.compareVersions);
  const latest = versions[versions.length - 1];
  const cmp = upd.compareVersions(latest, catalog.version);
  if (cmp > 0) {
    out(`newest tag v${latest} is newer than this catalog ${catalog.version} — run npx git+${source}#v${latest} to update`);
    return 2;
  }
  out(`this catalog ${catalog.version} is up to date (newest tag v${latest})`);
  return 0;
}

function cmdList(ctx) {
  const { catalog, out } = ctx;
  out(`${catalog.name} ${catalog.version}${catalog.source ? ` — ${catalog.source}` : ''}`);
  out('\nBundles');
  if (!catalog.bundles.length) out('  (none)');
  for (const b of catalog.bundles) {
    const parts = [];
    if (b.skills.length) parts.push(`skills ${b.skills.join(', ')}`);
    if (b.agents.length) parts.push(`agents ${b.agents.join(', ')}`);
    if (b.workflows.length) parts.push(`workflows ${b.workflows.join(', ')}`);
    out(`  ${b.name}: ${parts.join('; ') || '(empty)'}${b.description ? ` — ${b.description}` : ''}`);
  }
  const groups = [['Skills', catalog.skills], ['Agents', catalog.agents], ['Workflows', catalog.workflows]];
  for (const [title, units] of groups) {
    out(`\n${title}`);
    if (!units.length) out('  (none)');
    const byFolder = new Map();
    for (const u of units) {
      if (!byFolder.has(u.folder)) byFolder.set(u.folder, []);
      byFolder.get(u.folder).push(u);
    }
    for (const [folder, list] of byFolder) {
      out(`  ${folder}/`);
      for (const u of list) {
        const mark = u.invocation === 'user' ? ' [type it]' : '';
        out(`    ${u.name}${mark} — ${u.description}`);
      }
    }
  }
  return 0;
}

const COMMANDS = { install: cmdInstall, update: cmdUpdate, status: cmdStatus, check: cmdCheck, list: cmdList };

async function run(argv = [], io = {}) {
  const full = {
    root: ROOT, cwd: process.cwd(), home: os.homedir(),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
    ...io,
  };
  const args = parseArgs(argv);
  const out = (s) => full.stdout.write(`${s}\n`);
  const err = (s) => full.stderr.write(`${s}\n`);

  if (args.errors.length) {
    args.errors.forEach((e) => err(`Error: ${e}`));
    err(`\n${USAGE}`);
    return 1;
  }
  if (args.help || !args.command) { out(USAGE); return 0; }
  const command = COMMANDS[args.command];
  if (!command) { err(`Error: unknown command "${args.command}"\n\n${USAGE}`); return 1; }

  let catalog;
  try { catalog = inst.loadCatalog(full.root); }
  catch (e) { err(`Error: ${e.message}`); return 1; }

  for (const t of args.targets) {
    if (!inst.ADAPTERS[t]) { err(`Error: unknown target "${t}" — choose from: ${Object.keys(inst.ADAPTERS).join(', ')}`); return 1; }
  }
  if (args.version && catalog.version !== args.version) {
    err(`Error: catalog is ${catalog.version}, not ${args.version}; run npx git+${catalog.source}#v${args.version} to pin`);
    return 1;
  }

  const ctx = makeContext(args, full, catalog);
  try {
    return await command(ctx);
  } catch (e) {
    err(`Error: ${e.message}`);
    return 1;
  } finally {
    ctx.close();
  }
}

module.exports = { run, parseArgs, parseSelection, createPrompter, USAGE };
