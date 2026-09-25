'use strict';

const FLAG = 'disable-model-invocation: true';
const FENCE = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/;

function withDisableModelInvocation(raw) {
  const m = FENCE.exec(raw);
  if (!m) throw new Error('SKILL.md has no frontmatter to mark as user-invoked');
  if (/^disable-model-invocation:/m.test(m[2])) return raw;
  return raw.replace(FENCE, (_f, open, inner, close) => `${open}${inner}\n${FLAG}${close}`);
}

function renderWorkflowSkill(w, { markUserInvoked = true } = {}) {
  const steps = w.steps.length
    ? w.steps.map((s, i) => `${i + 1}. ${Object.entries(s)[0].join(': ')}`).join('\n')
    : '_This workflow lists no steps._';
  return [
    '---', `name: ${w.name}`, `description: ${JSON.stringify(w.description)}`, ...(markUserInvoked ? [FLAG] : []), '---', '',
    `# ${w.name}`, '', '## Steps', '', steps, '', w.body, '',
  ].join('\n');
}

/** The model hint an agent carries on `platform`: a string applies everywhere, a map only where it names that key. */
function modelFor(model, platform) {
  if (!model) return null;
  if (typeof model === 'string') return model;
  return (platform && model[platform]) || null;
}

/** Agent file as a platform installs it; `platform` picks the side of a per-platform `model:` map. */
function agentMarkdown(a, { platform = null } = {}) {
  const fm = ['---', `name: ${a.name}`, `description: ${JSON.stringify(a.description)}`];
  if (a.skills && a.skills.length) fm.push(`skills: [${a.skills.join(', ')}]`);
  const model = modelFor(a.model, platform);
  if (model) fm.push(`model: ${model}`);
  fm.push('---', '', a.body, '');
  return fm.join('\n');
}

function managedBlock(existing, start, end, content) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Markers count only as whole lines — prose that mentions them is not the block.
  const re = new RegExp(`\\n?^[ \\t]*${esc(start)}[ \\t]*$[\\s\\S]*?^[ \\t]*${esc(end)}[ \\t]*$\\n?`, 'm');
  const block = content === null ? '' : `${start}\n${content}\n${end}\n`;
  if (re.test(existing)) {
    return existing.replace(re, (m) => (content === null ? (m.startsWith('\n') ? '\n' : '') : `${m.startsWith('\n') ? '\n' : ''}${block}`));
  }
  if (content === null) return existing;
  const head = existing.trim() === '' ? '' : `${existing.replace(/\s*$/, '')}\n\n`;
  return `${head}${block}`;
}

module.exports = { withDisableModelInvocation, renderWorkflowSkill, agentMarkdown, modelFor, managedBlock, FLAG };
