'use strict';
// Which cases a change can possibly move. `unitNeeds` says what a unit depends on; a change
// travels the other way, so the map is inverted once and walked from the changed units.
const path = require('path');
const { execFileSync } = require('child_process');
const { unitNeeds } = require('../../lib/checks');
const { hookId } = require('../../lib/hooks');

const TIERS = { 1: 'trigger', 2: 'affected', 3: 'all' };

/** Everything that differs between `base` and the working tree, including untracked files. */
function changedPaths({ root, base }) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])])].sort();
}

/** unit name -> names of the units that lean on it, directly or through another unit. */
function reverseDependencies(units) {
  const byName = new Map(units.map((u) => [u.name, u]));
  const reverse = new Map();
  for (const unit of units) {
    for (const dep of unitNeeds(unit, byName)) {
      if (!reverse.has(dep)) reverse.set(dep, new Set());
      reverse.get(dep).add(unit.name);
    }
  }
  return reverse;
}

/** The units a set of changed paths touches, plus everything that leans on them. */
function affectedUnits({ units, changed }) {
  const direct = units.filter((u) => changed.some((c) => c === u.path || c.startsWith(`${u.path}/`))).map((u) => u.name);
  const reverse = reverseDependencies(units);
  const seen = new Set(direct);
  const stack = [...direct];
  while (stack.length) {
    for (const dependent of reverse.get(stack.pop()) || []) {
      if (!seen.has(dependent)) { seen.add(dependent); stack.push(dependent); }
    }
  }
  return seen;
}

/** The hooks a set of changed paths touches: their source file, or either script twin. */
function affectedHooks({ hooks, changed }) {
  return new Set(hooks
    .filter((h) => changed.some((c) => c === h.path || c === `${h.script}.sh` || c === `${h.script}.ps1`))
    .map(hookId));
}

const tagValues = (c, prefix) => c.tags.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));

/**
 * The cases a compare should run. Tier 1 keeps only trigger cases, tier 2 drops scenarios,
 * tier 3 keeps everything; `all` skips the affected filter entirely.
 */
function selectCases({ cases, units, hooks, changed, tier = 2, all = false }) {
  const tierName = TIERS[tier] || TIERS[2];
  const unitNames = affectedUnits({ units, changed });
  const hookIds = affectedHooks({ hooks, changed });
  const byTier = cases.filter((c) => {
    if (tierName === 'trigger') return c.tags.some((t) => t.startsWith('trigger:'));
    if (tierName === 'affected') return !c.tags.includes('scenario');
    return true;
  });
  if (all || tierName === 'all') return { cases: byTier, unitNames, hookIds };
  const selected = byTier.filter((c) => unitNames.has(c.group)
    || tagValues(c, 'unit:').some((u) => unitNames.has(u))
    || tagValues(c, 'hook:').some((h) => hookIds.has(h))
    || changed.some((p) => p === c.relDir || p.startsWith(`${c.relDir}${path.sep}`)));
  return { cases: selected, unitNames, hookIds };
}

module.exports = { changedPaths, reverseDependencies, affectedUnits, affectedHooks, selectCases, TIERS };
