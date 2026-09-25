'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSkillFromDir, loadAgentFromFile, loadWorkflowFromFile } = require('./units');
const { resolveRequires } = require('./checks');
const receipt = require('./receipt');
const claude = require('./adapters/claude');
const copilot = require('./adapters/copilot');

const ADAPTERS = { claude, copilot };

function loadCatalog(root) {
  const file = path.join(root, 'catalog.json');
  if (!fs.existsSync(file)) throw new Error('catalog.json not found — run `npm run build` first');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function baseDirFor(scope, projectDir = process.cwd(), home = os.homedir()) {
  return scope === 'global' ? home : projectDir;
}

function resolveBundleUnits(catalog, bundleNames) {
  const byName = new Map(catalog.skills.map((s) => [s.name, { kind: 'skill', ...s }]));
  const want = { skills: new Set(), agents: new Set(), workflows: new Set() };
  for (const name of bundleNames) {
    const b = catalog.bundles.find((x) => x.name === name);
    if (!b) throw new Error(`no such bundle "${name}" — available: ${catalog.bundles.map((x) => x.name).join(', ')}`);
    b.skills.forEach((s) => want.skills.add(s));
    b.agents.forEach((a) => want.agents.add(a));
    b.workflows.forEach((w) => want.workflows.add(w));
  }
  // A workflow carries its steps: step agents and skills, then agents' skills, then requires.
  for (const w of want.workflows) {
    const workflow = catalog.workflows.find((x) => x.name === w);
    if (!workflow) continue;
    for (const step of workflow.steps) {
      const [kind, name] = Object.entries(step)[0];
      if (kind === 'agent') want.agents.add(name);
      if (kind === 'skill') want.skills.add(name);
    }
  }
  for (const a of want.agents) {
    const agent = catalog.agents.find((x) => x.name === a);
    if (agent) agent.skills.forEach((s) => want.skills.add(s));
  }
  for (const s of [...want.skills]) resolveRequires(s, byName).forEach((r) => want.skills.add(r));
  return {
    skills: catalog.skills.filter((s) => want.skills.has(s.name)),
    agents: catalog.agents.filter((a) => want.agents.has(a.name)),
    workflows: catalog.workflows.filter((w) => want.workflows.has(w.name)),
  };
}

function loadUnitsFromCatalog(root, resolved) {
  const abs = (p) => path.join(root, p);
  return [
    ...resolved.skills.map((s) => loadSkillFromDir(abs(s.path), s.folder)),
    ...resolved.agents.map((a) => loadAgentFromFile(abs(a.path), a.folder)),
    ...resolved.workflows.map((w) => loadWorkflowFromFile(abs(w.path), w.folder)),
  ];
}

function planInstall({ root, catalog, bundles, targets, scope }) {
  const units = loadUnitsFromCatalog(root, resolveBundleUnits(catalog, bundles));
  const plans = targets.map((target) => {
    const adapter = ADAPTERS[target];
    if (!adapter) throw new Error(`unknown target "${target}" — choose from: ${Object.keys(ADAPTERS).join(', ')}`);
    const items = [];
    const skipped = [];
    for (const unit of units) {
      const reason = adapter.skipReason(unit);
      if (reason) skipped.push({ unit, reason });
      else items.push({ unit, outputs: adapter.outputs(unit, scope) });
    }
    return { target, scope, items, skipped };
  });
  return { units, plans };
}

// Never of the form `sha256:...`, so it can never equal a real hashFile()/hashContent()
// result: detectLocalEdits (receipt hash vs disk hash) then always reports this file as
// edited, even when nobody has touched it since install. Recording the file's own disk hash
// here instead would match itself immediately, and the next `engcat update` would silently
// overwrite it — the bug this sentinel replaces.
const UNMANAGED = 'unmanaged';

/**
 * `kept` names output paths to leave untouched — a pre-existing file at that path (not
 * necessarily catalog-managed) that the person chose to keep over what this install would
 * write. Its receipt entry is the UNMANAGED sentinel, not its real content hash, so a kept
 * file is flagged as needing a decision on every future `engcat update` too (mirrors
 * cmdUpdate), not just the first one after it happens to change.
 */
function applyInstall({ plan, baseDir, catalog, bundles, date, kept = new Set() }) {
  const written = [];
  for (const item of plan.items) {
    const outs = item.outputs.filter((o) => !kept.has(o.path));
    written.push(...claude.writeOutputs(outs, baseDir));
  }
  const record = receipt.recordFromOutputs({
    target: plan.target, scope: plan.scope, catalogVersion: catalog.version, source: catalog.source,
    bundles, planned: plan.items, date,
  });
  for (const unit of record.units) {
    for (const file of Object.keys(unit.files)) {
      if (kept.has(file)) unit.files[file] = UNMANAGED;
    }
  }
  receipt.writeReceipt(baseDir, receipt.upsertInstall(receipt.readReceipt(baseDir), record));
  return { written, record };
}

module.exports = { ADAPTERS, loadCatalog, baseDirFor, resolveBundleUnits, loadUnitsFromCatalog, planInstall, applyInstall };
