'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseFrontmatter } = require('./frontmatter');

const ROOT = path.resolve(__dirname, '..');

/** Owner folders answer "who fixes this"; lifecycle folders never ship (§3). */
const AUDIENCES = ['developers', 'qa', 'product', 'ops'];
const SHARED = 'shared';
const OWNER_FOLDERS = [SHARED, ...AUDIENCES];
const LIFECYCLE_FOLDERS = ['in-progress', 'deprecated'];
const FOLDERS = [...OWNER_FOLDERS, ...LIFECYCLE_FOLDERS];
const KINDS = ['skill', 'agent', 'workflow'];
const KIND_DIRS = { skill: 'skills', agent: 'agents', workflow: 'workflows' };
const INVOCATIONS = ['model', 'user'];
const TARGETS = ['claude', 'copilot'];
const PLATFORM_VALUES = ['skip'];

function listFilesRecursive(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

function hashContent(buf) {
  return `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
}
function hashFile(file) {
  return hashContent(fs.readFileSync(file));
}

function unitVersion(unit) {
  const lines = unit.files.map((f) => `${f}\0${hashFile(path.join(unit.dir, f))}`);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

function asStringList(value, what) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new Error(`${what} must be a list of names`);
  }
  return value;
}

function readEntry(file, what) {
  const { frontmatter, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  if (!frontmatter.name || !frontmatter.description) {
    throw new Error(`${what} is missing required frontmatter (name/description)`);
  }
  return { frontmatter, body };
}

function repoPath(folder, kind, leaf) {
  return folder ? path.posix.join(KIND_DIRS[kind], folder, leaf) : null;
}

function loadSkillFromDir(dir, folder = null) {
  const leaf = path.basename(dir);
  const entryFile = path.join(dir, 'SKILL.md');
  if (!fs.existsSync(entryFile)) throw new Error(`skill "${leaf}" has no SKILL.md`);
  const { frontmatter, body } = readEntry(entryFile, `skill "${leaf}"`);
  if (frontmatter.name !== leaf) {
    throw new Error(`skill "${leaf}" frontmatter name is "${frontmatter.name}" — must match folder name`);
  }
  const invocation = frontmatter.invocation || 'model';
  if (!INVOCATIONS.includes(invocation)) {
    throw new Error(`skill "${leaf}" has invocation "${invocation}" — must be one of: ${INVOCATIONS.join(', ')}`);
  }
  const platforms = frontmatter.platforms || {};
  if (typeof platforms !== 'object' || Array.isArray(platforms)) {
    throw new Error(`skill "${leaf}" frontmatter "platforms" must be a block of key: value pairs`);
  }
  for (const [id, value] of Object.entries(platforms)) {
    if (!TARGETS.includes(id)) throw new Error(`skill "${leaf}" has an override for unknown platform "${id}" — known: ${TARGETS.join(', ')}`);
    if (!PLATFORM_VALUES.includes(value)) throw new Error(`skill "${leaf}" sets platforms.${id} to "${value}" — the only supported value is: ${PLATFORM_VALUES.join(', ')}`);
  }
  const unit = {
    kind: 'skill', name: frontmatter.name, description: frontmatter.description, frontmatter, body,
    folder, promoted: OWNER_FOLDERS.includes(folder), dir, entryFile,
    files: listFilesRecursive(dir), path: repoPath(folder, 'skill', leaf),
    invocation, platforms, requires: asStringList(frontmatter.requires, `skill "${leaf}" requires`),
  };
  unit.version = unitVersion(unit);
  return unit;
}

function loadSingleFile(kind, file, folder) {
  const leaf = path.basename(file, '.md');
  const { frontmatter, body } = readEntry(file, `${kind} "${leaf}"`);
  if (frontmatter.name !== leaf) {
    throw new Error(`${kind} "${leaf}" frontmatter name is "${frontmatter.name}" — must match file name`);
  }
  return {
    kind, name: frontmatter.name, description: frontmatter.description, frontmatter, body,
    folder, promoted: OWNER_FOLDERS.includes(folder), dir: path.dirname(file), entryFile: file,
    files: [path.basename(file)], path: repoPath(folder, kind, path.basename(file)),
  };
}

/**
 * `model:` is a hint (§2.2): one string for every platform, or a one-level map keyed by
 * target (`claude: opus`, `copilot: gemini-3.8-flash`) when no single name is valid on both.
 * A platform missing from the map gets no hint. Returns null | string | { [target]: string }.
 */
function agentModel(value, what) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} model must be a model name or a block of "<platform>: <model>" lines`);
  }
  for (const [id, model] of Object.entries(value)) {
    if (!TARGETS.includes(id)) throw new Error(`${what} model names unknown platform "${id}" — known: ${TARGETS.join(', ')}`);
    if (typeof model !== 'string' || model === '') throw new Error(`${what} model.${id} must be a single model name`);
  }
  return value;
}

function loadAgentFromFile(file, folder = null) {
  const unit = loadSingleFile('agent', file, folder);
  unit.skills = asStringList(unit.frontmatter.skills, `agent "${unit.name}" skills`);
  unit.model = agentModel(unit.frontmatter.model, `agent "${unit.name}"`);
  unit.version = unitVersion(unit);
  return unit;
}

function loadWorkflowFromFile(file, folder = null) {
  const unit = loadSingleFile('workflow', file, folder);
  const steps = unit.frontmatter.steps || [];
  if (!Array.isArray(steps)) throw new Error(`workflow "${unit.name}" steps must be a list`);
  steps.forEach((step, i) => {
    const keys = typeof step === 'object' && step ? Object.keys(step) : [];
    if (keys.length !== 1 || !['agent', 'skill'].includes(keys[0])) {
      throw new Error(`workflow "${unit.name}" step ${i + 1} must be "- agent: <name>" or "- skill: <name>"`);
    }
  });
  unit.steps = steps;
  unit.version = unitVersion(unit);
  return unit;
}

function loadBundle(file) {
  const leaf = path.basename(file, '.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { throw new Error(`bundle "${leaf}": ${err.message}`); }
  if (raw.name !== leaf) throw new Error(`bundle "${leaf}" name is "${raw.name}" — must match file name`);
  if (!raw.description) throw new Error(`bundle "${leaf}" needs a description`);
  const audience = raw.audience || raw.name;
  if (!AUDIENCES.includes(audience)) {
    throw new Error(`bundle "${leaf}" must name its audience (one of ${AUDIENCES.join(', ')}) — add an "audience" field`);
  }
  return {
    name: raw.name, audience, description: raw.description,
    skills: asStringList(raw.skills, `bundle "${leaf}" skills`),
    agents: asStringList(raw.agents, `bundle "${leaf}" agents`),
    workflows: asStringList(raw.workflows, `bundle "${leaf}" workflows`),
    file, path: path.posix.join('bundles', `${leaf}.json`),
  };
}

const LOADERS = { skill: loadSkillFromDir, agent: loadAgentFromFile, workflow: loadWorkflowFromFile };

function scanUnits({ root = ROOT, folders = OWNER_FOLDERS } = {}) {
  const units = [];
  const warnings = [];
  for (const kind of KINDS) {
    const kindDir = path.join(root, KIND_DIRS[kind]);
    if (!fs.existsSync(kindDir)) continue;
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      const rel = `${KIND_DIRS[kind]}/${entry.name}`;
      if (entry.isDirectory()) {
        if (FOLDERS.includes(entry.name)) continue;
        if (kind === 'skill' && fs.existsSync(path.join(kindDir, entry.name, 'SKILL.md'))) {
          warnings.push(`${rel}/ sits outside an owner or lifecycle folder — move it into one of: ${FOLDERS.join(', ')}`);
        } else {
          warnings.push(`${rel}/ is not a known folder — ignored`);
        }
      } else if (entry.name.endsWith('.md') && kind !== 'skill') {
        warnings.push(`${rel} sits outside an owner or lifecycle folder — move it into one of: ${FOLDERS.join(', ')}`);
      }
    }
    for (const folder of folders) {
      const folderDir = path.join(kindDir, folder);
      if (!fs.existsSync(folderDir)) continue;
      const found = [];
      for (const entry of fs.readdirSync(folderDir, { withFileTypes: true })) {
        const isSkill = kind === 'skill';
        if (isSkill && !entry.isDirectory()) continue;
        if (!isSkill && (entry.isDirectory() || !entry.name.endsWith('.md') || entry.name === 'README.md')) continue;
        const target = path.join(folderDir, entry.name);
        if (isSkill && !fs.existsSync(path.join(target, 'SKILL.md'))) {
          warnings.push(`skills/${folder}/${entry.name}/ has no SKILL.md`);
          continue;
        }
        try { found.push(LOADERS[kind](target, folder)); }
        catch (err) { warnings.push(`skipped ${kind} ${folder}/${entry.name}: ${err.message}`); }
      }
      found.sort((a, b) => a.name.localeCompare(b.name));
      units.push(...found);
    }
  }
  const bundles = [];
  const bundlesDir = path.join(root, 'bundles');
  if (fs.existsSync(bundlesDir)) {
    for (const name of fs.readdirSync(bundlesDir).filter((n) => n.endsWith('.json')).sort()) {
      try { bundles.push(loadBundle(path.join(bundlesDir, name))); }
      catch (err) { warnings.push(`skipped bundle ${name}: ${err.message}`); }
    }
  }
  return { units, bundles, warnings };
}

module.exports = {
  ROOT, AUDIENCES, SHARED, OWNER_FOLDERS, LIFECYCLE_FOLDERS, FOLDERS, KINDS, KIND_DIRS,
  INVOCATIONS, TARGETS, PLATFORM_VALUES,
  listFilesRecursive, hashContent, hashFile, unitVersion,
  loadSkillFromDir, loadAgentFromFile, loadWorkflowFromFile, loadBundle, scanUnits,
};
