'use strict';
// The part of the catalog's cost that needs no model call: what every session pays for the
// descriptions the agent keeps in context. On Claude a user-invoked skill is hidden from the
// model (`disable-model-invocation`), so it costs nothing; the Copilot adapter installs the
// same skill without that flag, so there it does.
const TARGETS = ['claude', 'copilot'];
// Rough and deliberately crude: the comparison between two versions is what matters, and a
// tokenizer would be a runtime dependency this repo does not take.
const CHARS_PER_TOKEN = 4;

const inContext = (unit, target) => {
  if (unit.platforms && unit.platforms[target] === 'skip') return false;
  if (unit.kind === 'agent') return true;
  if (unit.kind !== 'skill') return false;
  return target === 'copilot' || unit.invocation !== 'user';
};

/** Always-on description characters per target, with the per-unit breakdown. */
function contextBudget({ units }) {
  const out = {};
  for (const target of TARGETS) {
    const items = units.filter((u) => u.promoted && inContext(u, target))
      .map((u) => ({ name: u.name, kind: u.kind, chars: u.description.length }))
      .sort((a, b) => b.chars - a.chars);
    const chars = items.reduce((sum, i) => sum + i.chars, 0);
    out[target] = { chars, tokens: Math.round(chars / CHARS_PER_TOKEN), items };
  }
  return out;
}

/** Per-target and per-unit differences between two budgets — the T0 half of a compare. */
function compareBudgets(base, candidate) {
  const rows = [];
  for (const target of TARGETS) {
    const before = new Map(base[target].items.map((i) => [i.name, i.chars]));
    const after = new Map(candidate[target].items.map((i) => [i.name, i.chars]));
    const changed = [...new Set([...before.keys(), ...after.keys()])]
      .map((name) => ({ name, before: before.get(name) || 0, after: after.get(name) || 0 }))
      .filter((r) => r.before !== r.after)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before));
    rows.push({
      target,
      chars: { before: base[target].chars, after: candidate[target].chars, delta: candidate[target].chars - base[target].chars },
      tokens: { before: base[target].tokens, after: candidate[target].tokens, delta: candidate[target].tokens - base[target].tokens },
      changed,
    });
  }
  return rows;
}

module.exports = { contextBudget, compareBudgets, TARGETS, CHARS_PER_TOKEN };
