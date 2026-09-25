'use strict';
const fs = require('fs');
const path = require('path');
const { SHARED, AUDIENCES } = require('./units');

const SECRET_PATTERNS = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'PAT assignment', re: /\b(PAT|TOKEN|SECRET|PASSWORD)\s*[=:]\s*['"]?[A-Za-z0-9+/_-]{32,}/ },
  { name: 'basic auth header', re: /Authorization:\s*Basic\s+[A-Za-z0-9+/=]{40,}/ },
];

// Self-containment (inv. 3, rule 10): a single `../` inside a skill (e.g. a relative
// path used by a script that never leaves the skill directory, or prose that merely
// mentions `../`) is not by itself a reference outside the skill. What we flag:
//   - `../../` anywhere in any text file of the skill (walking up two or more levels),
//   - and, in markdown files only, a markdown link target `](../` or the literal
//     placeholder `<SKILL_DIR>/../` — both are unambiguous cross-skill references.
const ESCAPE_PATTERNS = {
  any: [/\.\.\/\.\.\//],
  md: [/\.\.\/\.\.\//, /\]\(\.\.\//, /<SKILL_DIR>\/\.\.\//],
};

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Transitive `requires` closure of a skill, excluding itself, sorted. */
function resolveRequires(name, byName) {
  const seen = new Set();
  const stack = [name];
  while (stack.length) {
    const cur = byName.get(stack.pop());
    for (const dep of (cur && cur.requires) || []) {
      if (dep !== name && !seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
  }
  return [...seen].sort();
}

/** Transitive closure of skill names an agent leans on (its `skills:` and their requires), sorted. */
function agentNeeds(agent, byName) {
  return [...new Set(agent.skills.flatMap((s) => [s, ...resolveRequires(s, byName)]))].sort();
}

/**
 * Everything a bundle must also name when it names `unit` (inv. 7), excluding the unit
 * itself, sorted: a skill's requires; an agent's skills and their requires; a workflow's
 * step agents and skills with both closures. Unresolvable names are skipped — the
 * reference check reports those.
 */
function unitNeeds(unit, byName) {
  const out = new Set();
  const addSkill = (s) => { out.add(s); resolveRequires(s, byName).forEach((r) => out.add(r)); };
  if (unit.kind === 'skill') resolveRequires(unit.name, byName).forEach((r) => out.add(r));
  if (unit.kind === 'agent') agentNeeds(unit, byName).forEach((r) => out.add(r));
  if (unit.kind === 'workflow') {
    for (const step of unit.steps) {
      const [kind, name] = Object.entries(step)[0];
      const target = byName.get(name);
      if (!target || target.kind !== kind) continue;
      if (kind === 'skill') addSkill(name);
      if (kind === 'agent') { out.add(name); agentNeeds(target, byName).forEach((r) => out.add(r)); }
    }
  }
  out.delete(unit.name);
  return [...out].sort();
}

/** File paths (with a trailing message) of every file in `unit` that looks like it contains a secret. */
function scanForSecrets(unit) {
  const hits = [];
  for (const rel of unit.files) {
    const buf = fs.readFileSync(path.join(unit.dir, rel));
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    for (const { name, re } of SECRET_PATTERNS) {
      if (re.test(text)) {
        const label = unit.kind === 'skill'
          ? `${unit.path || unit.name}/${rel}`
          : (unit.path === null ? `${unit.name}/${rel}` : unit.path);
        hits.push(`${label} looks like it contains a secret (${name})`);
      }
    }
  }
  return hits;
}

/** Errors for skill files that reference outside their own directory (inv. 3). */
function checkSelfContainment(unit) {
  const hits = [];
  if (unit.kind !== 'skill') return hits;
  for (const rel of unit.files) {
    const buf = fs.readFileSync(path.join(unit.dir, rel));
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');
    const patterns = rel.endsWith('.md') ? ESCAPE_PATTERNS.md : ESCAPE_PATTERNS.any;
    let match = null;
    for (const re of patterns) {
      match = re.exec(text);
      if (match) break;
    }
    if (!match) continue;
    const lineStart = text.lastIndexOf('\n', match.index) + 1;
    const lineEndIdx = text.indexOf('\n', match.index);
    const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
    const snippet = text.slice(lineStart, lineEnd).trim().slice(0, 80);
    hits.push(`${unit.path || unit.name}/${rel} references outside its directory: "${snippet}"`);
  }
  return hits;
}

// Directory names under evals/ that belong to the harness rather than to a unit.
const RESERVED_EVAL_GROUPS = ['scenarios', 'hooks', 'mocks', 'results', 'experiments', 'container'];

/** The top-level directories under `evals/`, sorted. */
function scanEvalGroups(root) {
  const dir = path.join(root, 'evals');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Inv. 11: every `evals/<group>` names a promoted unit, so a rename never orphans its cases. */
function checkEvalGroups(groups, byName) {
  const errors = [];
  for (const group of groups) {
    if (RESERVED_EVAL_GROUPS.includes(group)) continue;
    const unit = byName.get(group);
    if (!unit) errors.push(`evals/${group} names "${group}", which is not a unit in the catalog`);
    else if (!unit.promoted) errors.push(`evals/${group} names ${unit.kind} "${group}", which lives in ${unit.folder} and does not ship`);
  }
  return errors;
}

function checkCatalog({ units, bundles, evalGroups }) {
  const errors = [];
  const warnings = [];
  const byName = new Map();

  // 1. unique names across kinds
  for (const u of units) {
    const prev = byName.get(u.name);
    if (prev) errors.push(`duplicate name "${u.name}": ${prev.kind} ${prev.path} and ${u.kind} ${u.path}`);
    else byName.set(u.name, u);
  }
  const isKind = (name, kind) => byName.has(name) && byName.get(name).kind === kind;

  // 2-4. references inside units
  for (const u of units) {
    if (u.kind === 'skill') {
      for (const r of u.requires) if (!isKind(r, 'skill')) errors.push(`skill "${u.name}" requires "${r}" which is not a skill in the catalog`);
    }
    if (u.kind === 'agent') {
      for (const s of u.skills) if (!isKind(s, 'skill')) errors.push(`agent "${u.name}" names skill "${s}" which is not in the catalog`);
    }
    if (u.kind === 'workflow') {
      u.steps.forEach((step, i) => {
        const [kind, name] = Object.entries(step)[0];
        if (!isKind(name, kind)) errors.push(`workflow "${u.name}" step ${i + 1} names ${kind} "${name}" which is not in the catalog`);
      });
    }
  }

  // 5-7. bundles
  const claims = new Map(); // unit name -> Set(audience)
  for (const b of bundles) {
    const named = [
      ...b.skills.map((n) => ['skill', n]),
      ...b.agents.map((n) => ['agent', n]),
      ...b.workflows.map((n) => ['workflow', n]),
    ];
    const skillSet = new Set(b.skills);
    const agentSet = new Set(b.agents);
    const carries = (r) => (isKind(r, 'agent') ? agentSet.has(r) : skillSet.has(r));
    for (const [kind, name] of named) {
      if (!isKind(name, kind)) { errors.push(`bundle "${b.name}" names ${kind} "${name}" which is not in the catalog`); continue; }
      const u = byName.get(name);
      if (!u.promoted) errors.push(`bundle "${b.name}" names ${kind} "${name}" which lives in ${u.folder} and does not ship`);
      if (!claims.has(name)) claims.set(name, new Set());
      claims.get(name).add(b.audience);
      // Inv. 7: a skill needs its requires; an agent needs its skills and theirs; a workflow
      // needs every step unit (agents in `agents`, skills in `skills`) and their closure.
      for (const r of unitNeeds(u, byName)) {
        if (!carries(r)) errors.push(`bundle "${b.name}" names "${name}" but not its requirement "${r}"`);
      }
    }
  }

  // 8. shared rule (§3.1)
  for (const u of units) {
    if (!u.promoted) continue;
    const audiences = claims.get(u.name);
    if (!audiences || audiences.size === 0) continue;
    if (u.folder === SHARED && audiences.size < 2) {
      const only = [...audiences][0];
      errors.push(`${u.kind} "${u.name}" is in shared but only ${only} bundles claim it — move it to ${only}`);
    } else if (AUDIENCES.includes(u.folder)) {
      const other = [...audiences].find((a) => a !== u.folder);
      if (other) errors.push(`${u.kind} "${u.name}" is in ${u.folder} but a ${other} bundle also claims it — move it to shared`);
    }
  }

  // 9. secrets, 10. self-containment
  for (const u of units) {
    errors.push(...scanForSecrets(u));
    errors.push(...checkSelfContainment(u));
  }
  for (const b of bundles) {
    const text = fs.readFileSync(b.file, 'utf8');
    for (const { name, re } of SECRET_PATTERNS) if (re.test(text)) errors.push(`${b.path} looks like it contains a secret (${name})`);
  }

  // 11. eval groups (skipped when the caller did not scan them)
  if (evalGroups) errors.push(...checkEvalGroups(evalGroups, byName));

  return { errors, warnings };
}

module.exports = { checkCatalog, checkEvalGroups, scanEvalGroups, resolveRequires, unitNeeds, scanForSecrets, SECRET_PATTERNS, RESERVED_EVAL_GROUPS };
