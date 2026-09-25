'use strict';
const fs = require('fs');
const path = require('path');
const { withDisableModelInvocation, renderWorkflowSkill, agentMarkdown } = require('../render');

const id = 'claude';
const label = 'Claude Code';
const supportsGlobal = true;

function skipReason(unit) {
  if (unit.kind === 'skill' && unit.platforms && unit.platforms.claude === 'skip') return 'the skill opts out of Claude (platforms.claude: skip)';
  return null;
}

/**
 * Every file of a skill, relative to `skillsDir`. `markUserInvoked` injects
 * `disable-model-invocation: true` into a user-invoked skill's SKILL.md — Claude's dialect for
 * "only a person may fire this". Copilot has no such dialect (the flag hides the skill from
 * `/name` too), so its adapter passes false.
 */
function skillOutputs(unit, skillsDir, { markUserInvoked = true } = {}) {
  return unit.files.map((rel) => {
    const src = path.join(unit.dir, rel);
    let content = fs.readFileSync(src);
    if (markUserInvoked && rel === 'SKILL.md' && unit.invocation === 'user') content = Buffer.from(withDisableModelInvocation(content.toString('utf8')), 'utf8');
    return { path: path.posix.join(skillsDir, unit.name, rel), content, mode: fs.statSync(src).mode & 0o777 };
  });
}

/** Pure: what would be written, relative to the base dir. Same layout for both scopes. */
function outputs(unit, _scope = 'local') {
  if (skipReason(unit)) return [];
  if (unit.kind === 'skill') return skillOutputs(unit, '.claude/skills');
  if (unit.kind === 'agent') return [{ path: path.posix.join('.claude/agents', `${unit.name}.md`), content: Buffer.from(agentMarkdown(unit, { platform: id }), 'utf8'), mode: 0o644 }];
  return [{ path: path.posix.join('.claude/skills', unit.name, 'SKILL.md'), content: Buffer.from(renderWorkflowSkill(unit), 'utf8'), mode: 0o644 }];
}

function writeOutputs(outs, baseDir) {
  const written = [];
  for (const o of outs) {
    const dest = path.join(baseDir, o.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, o.content);
    fs.chmodSync(dest, o.mode);
    written.push(o.path);
  }
  return written;
}

function install(unit, baseDir, scope = 'local') {
  return writeOutputs(outputs(unit, scope), baseDir);
}

module.exports = { id, label, supportsGlobal, skipReason, outputs, install, writeOutputs, skillOutputs };
