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
    ? { skills: '.copilot/skills', agents: '.copilot/agents', instructions: '.copilot/instructions' }
    : { skills: '.github/skills', agents: '.github/agents', instructions: '.github/instructions' };
}

/**
 * A model-invoked skill fires when the model decides to, and a greeting is not a reason: a
 * "once per session" skill ran in only some sessions (live, copilot 1.0.83). Copilot reads
 * every `*.instructions.md` under its instructions folders into every session, so a
 * `session-start` skill gets one that names it — and says to *begin the reply* with what it
 * prints: told merely to "relay" the line, the model ran the script and dropped its output.
 */
function sessionStartInstructions(unit) {
  return [
    '---',
    'applyTo: "**"',
    '---',
    `At the start of every session, before you answer the user's first message, run the \`${unit.name}\` skill. Its script prints nothing when there is nothing to say; then say nothing about it. Never narrate this check, a preflight or any other internal step to the user, and send every tool call with no text beside it: words written next to a tool call are shown to the user as a message. When it prints a line, begin your reply with that line, word for word, as its own paragraph (translated into the user's language if they write in another), and only then answer the message. Do this even when the message is a greeting.`,
    '',
  ].join('\n');
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
  if (unit.kind === 'skill') {
    const files = skillOutputs(unit, L.skills, { markUserInvoked: false });
    if (unit.sessionStart) {
      files.push({ path: path.posix.join(L.instructions, `${unit.name}.instructions.md`), content: Buffer.from(sessionStartInstructions(unit), 'utf8'), mode: 0o644 });
    }
    return files;
  }
  if (unit.kind === 'agent') return [{ path: path.posix.join(L.agents, `${unit.name}.agent.md`), content: Buffer.from(agentMarkdown(unit, { platform: id }), 'utf8'), mode: 0o644 }];
  return [{ path: path.posix.join(L.skills, unit.name, 'SKILL.md'), content: Buffer.from(renderWorkflowSkill(unit, { markUserInvoked: false }), 'utf8'), mode: 0o644 }];
}

function install(unit, baseDir, scope = 'local') {
  return writeOutputs(outputs(unit, scope), baseDir);
}

module.exports = { id, label, supportsGlobal, layout, skipReason, outputs, install };
