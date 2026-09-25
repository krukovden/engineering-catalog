'use strict';
// Loads an eval suite in the `claude plugin eval` case format (prompt.md + graders/*.md,
// optional case.yaml). Claude runs these through its own command; the Copilot runner reads
// the same files, so this loader is the one place that decides what a case may contain.
const fs = require('fs');
const path = require('path');
const { parseFrontmatter, parseYamlDocument } = require('../../lib/frontmatter');
const { scanEvalGroups } = require('../../lib/checks');

const EVAL_DIR = 'evals';
// Directories under evals/ that are not a unit's case group.
const RESERVED_GROUPS = ['scenarios', 'hooks', 'mocks', 'results', 'experiments', 'container'];
// Of those, the ones that hold no cases at all.
const NON_CASE_DIRS = ['mocks', 'results', 'experiments', 'container'];
const GRADER_TYPES = ['regex', 'tool_used', 'tool_order', 'file_exists', 'llm', 'baseline'];
const PROMPT_KEYS = ['schema_version', 'name', 'description', 'tags', 'plugins', 'runs', 'expected_outcome', 'model', 'max_turns', 'timeout_seconds', 'allowed_tools', 'append_system_prompt', 'env'];
const GRADER_KEYS = ['type', 'weight', 'arm', 'pattern', 'flags', 'match', 'target', 'tool', 'input_match', 'min', 'max', 'before', 'after', 'path', 'exists', 'criteria', 'focus', 'baseline_file'];
const NUMERIC = ['runs', 'max_turns', 'timeout_seconds', 'weight', 'min', 'max'];
const TAG_PREFIXES = ['unit:', 'hook:', 'isolation:', 'trigger:'];
const TAG_WORDS = ['behaviour', 'regression', 'scenario'];

const isCaseDir = (dir) => fs.existsSync(path.join(dir, 'prompt.md')) || fs.existsSync(path.join(dir, 'case.yaml'));

/** `{ source: file, path: x }` — the one inline map the case format uses. */
function parseInlineMap(value) {
  if (typeof value !== 'string' || !value.startsWith('{')) return value;
  const out = {};
  for (const part of value.replace(/^\{|\}$/g, '').split(',')) {
    const [k, ...rest] = part.split(':');
    if (!k || !rest.length) return value;
    out[k.trim()] = rest.join(':').trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

function coerce(key, value) {
  if (NUMERIC.includes(key)) return Number(value);
  if (key === 'exists') return value === 'true' || value === true;
  if (['target', 'focus', 'before', 'after'].includes(key)) return parseInlineMap(value);
  return value;
}

function validateKeys(raw, allowed, where, errors) {
  const frontmatter = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.includes(key)) {
      errors.push(`${where}: unknown key "${key}" — the native runner rejects it too`);
      continue;
    }
    frontmatter[key] = coerce(key, value);
  }
  return frontmatter;
}

function readFrontmatter(file, allowed, where, errors) {
  let parsed;
  try {
    parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
    return { frontmatter: {}, body: '' };
  }
  return { frontmatter: validateKeys(parsed.frontmatter, allowed, where, errors), body: parsed.body };
}

// `case.yaml` is a plain YAML document — never `---`-delimited frontmatter. Wrapping it in
// `---` (an easy mistake: every other file in a case is frontmatter-shaped) parses fine under
// this repo's own lenient checker but makes the *native* `claude plugin eval` reject the file
// outright ("case.yaml must be a YAML object"), so this reads it with the undelimited parser.
function readYaml(file, allowed, where, errors) {
  let raw;
  try {
    raw = parseYamlDocument(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${where}: ${e.message}`);
    return {};
  }
  return validateKeys(raw, allowed, where, errors);
}

function loadGraders(caseDir, relDir, errors) {
  const dir = path.join(caseDir, 'graders');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((file) => {
    const where = `${relDir}/graders/${file}`;
    const { frontmatter, body } = readFrontmatter(path.join(dir, file), GRADER_KEYS, where, errors);
    const grader = { name: path.basename(file, '.md'), weight: 1, ...frontmatter, criteria: frontmatter.criteria || body };
    if (!GRADER_TYPES.includes(grader.type)) errors.push(`${where}: type "${grader.type}" is not one of ${GRADER_TYPES.join(', ')}`);
    const need = { regex: 'pattern', tool_used: 'tool', file_exists: 'path', baseline: 'baseline_file' }[grader.type];
    if (need && grader[need] === undefined) errors.push(`${where}: a ${grader.type} grader needs "${need}"`);
    if (grader.type === 'tool_order' && (!grader.before || !grader.after)) errors.push(`${where}: a tool_order grader needs "before" and "after"`);
    if (grader.type === 'llm' && !grader.criteria) errors.push(`${where}: an llm grader needs a rubric in its body`);
    return grader;
  });
}

function loadCase(caseDir, root, errors) {
  const relDir = path.relative(root, caseDir);
  const group = relDir.split(path.sep)[1];
  const promptFile = path.join(caseDir, 'prompt.md');
  const { frontmatter, body } = fs.existsSync(promptFile)
    ? readFrontmatter(promptFile, PROMPT_KEYS, relDir, errors)
    : { frontmatter: {}, body: '' };
  const yaml = path.join(caseDir, 'case.yaml');
  let context = {};
  if (fs.existsSync(yaml)) {
    // schema_version/description/plugins/expected_outcome/execution.* exist in the format for
    // a case.yaml written without a prompt.md; every case here also has one, so only the keys
    // actually in use are accepted — widen this if a case.yaml-only case is ever added.
    const parsed = readYaml(yaml, ['schema_version', 'name', 'tags', 'context', 'runs'], `${relDir}/case.yaml`, errors);
    context = parsed.context || {};
    // Both arms execute this script; a name that resolves to nothing would run the case on a bare
    // directory and grade the model for setup that never happened.
    if (context.scaffold_script && !fs.existsSync(path.join(caseDir, context.scaffold_script))) {
      errors.push(`${relDir}: context.scaffold_script names "${context.scaffold_script}", which does not exist`);
    }
  }
  const tags = frontmatter.tags || [];
  for (const tag of tags) {
    if (!TAG_WORDS.includes(tag) && !TAG_PREFIXES.some((p) => tag.startsWith(p))) {
      errors.push(`${relDir}: tag "${tag}" is not one of ${TAG_WORDS.join(', ')} or a ${TAG_PREFIXES.join('/')} prefix`);
    }
  }
  if (!body.trim()) errors.push(`${relDir}: the prompt body is empty`);
  const graders = loadGraders(caseDir, relDir, errors);
  if (!graders.length) errors.push(`${relDir}: a case needs at least one grader`);
  return {
    name: frontmatter.name || path.basename(caseDir),
    group, dir: caseDir, relDir, tags, prompt: body, graders, context,
    runs: frontmatter.runs, maxTurns: frontmatter.max_turns || 10,
    timeoutSeconds: frontmatter.timeout_seconds || 300,
    allowedTools: frontmatter.allowed_tools || [],
    isolation: tags.includes('isolation:container') ? 'container' : 'native',
    model: frontmatter.model, env: frontmatter.env || {},
  };
}

function walk(dir, root, found) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(dir, entry.name);
    if (dir === path.join(root, EVAL_DIR) && NON_CASE_DIRS.includes(entry.name)) continue;
    if (isCaseDir(child)) found.push(child);
    else walk(child, root, found);
  }
  return found;
}

/** Every case under `evals/`, plus the problems that would make a run meaningless. */
function loadSuite({ root }) {
  const dir = path.join(root, EVAL_DIR);
  const errors = [];
  if (!fs.existsSync(dir)) return { cases: [], errors };
  const cases = walk(dir, root, []).sort().map((d) => loadCase(d, root, errors));
  const byName = new Map();
  for (const c of cases) {
    if (byName.has(c.name)) errors.push(`${c.relDir}: case name "${c.name}" is already used by ${byName.get(c.name)}`);
    else byName.set(c.name, c.relDir);
  }
  return { cases, errors };
}

module.exports = { EVAL_DIR, RESERVED_GROUPS, GRADER_TYPES, loadSuite, scanEvalGroups, parseInlineMap };
