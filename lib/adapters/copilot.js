'use strict';
const path = require('path');
const { skillOutputs, writeOutputs } = require('./claude');
const { agentMarkdown, renderWorkflowSkill } = require('../render');

const id = 'copilot';
const label = 'GitHub Copilot';
const supportsGlobal = true;

/** §7.1: project-local under .github/, user-global under ~/.copilot/. */
function layout(scope) {
  return scope === 'global'
    ? { skills: '.copilot/skills', agents: '.copilot/agents' }
    : { skills: '.github/skills', agents: '.github/agents' };
}

function skipReason(unit) {
  if (unit.kind === 'skill' && unit.platforms && unit.platforms.copilot === 'skip') return 'the skill opts out of Copilot (platforms.copilot: skip)';
  return null;
}

/**
 * Copilot CLI reads the same SKILL.md format as Claude, but has no user-invocation dialect:
 * `disable-model-invocation: true` hides a skill from the model AND from `/name` (verified on
 * copilot 1.0.83 — the model answers "Skill not found"). A person invokes a skill there by
 * writing `/name` in the prompt, which only works for a visible skill. So user-invoked skills
 * and workflows install without the flag; their descriptions carry the "run only when asked"
 * intent.
 */
function outputs(unit, scope = 'local') {
  if (skipReason(unit)) return [];
  const L = layout(scope);
  if (unit.kind === 'skill') return skillOutputs(unit, L.skills, { markUserInvoked: false });
  if (unit.kind === 'agent') return [{ path: path.posix.join(L.agents, `${unit.name}.agent.md`), content: Buffer.from(agentMarkdown(unit, { platform: id }), 'utf8'), mode: 0o644 }];
  return [{ path: path.posix.join(L.skills, unit.name, 'SKILL.md'), content: Buffer.from(renderWorkflowSkill(unit, { markUserInvoked: false }), 'utf8'), mode: 0o644 }];
}

function install(unit, baseDir, scope = 'local') {
  return writeOutputs(outputs(unit, scope), baseDir);
}

module.exports = { id, label, supportsGlobal, layout, skipReason, outputs, install };
