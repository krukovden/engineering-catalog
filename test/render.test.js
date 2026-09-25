'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { withDisableModelInvocation, renderWorkflowSkill, managedBlock, agentMarkdown } = require('../lib/render');

test('withDisableModelInvocation inserts once', () => {
  const once = withDisableModelInvocation('---\nname: a\n---\n\nB\n');
  assert.equal(once, '---\nname: a\ndisable-model-invocation: true\n---\n\nB\n');
  assert.equal(withDisableModelInvocation(once), once);
  assert.throws(() => withDisableModelInvocation('no frontmatter'), /frontmatter/);
});

test('renderWorkflowSkill lists steps and is user-invoked', () => {
  const out = renderWorkflowSkill({ name: 'flow', description: 'A "flow"', steps: [{ agent: 'triager' }, { skill: 'gamma' }], body: '# Flow\n\nText.' });
  assert.ok(out.startsWith('---\nname: flow\ndescription: "A \\"flow\\""\ndisable-model-invocation: true\n---\n'));
  assert.ok(out.includes('## Steps\n\n1. agent: triager\n2. skill: gamma\n'));
  assert.ok(out.trimEnd().endsWith('Text.'));
  assert.ok(renderWorkflowSkill({ name: 'e', description: 'd', steps: [], body: '' }).includes('_This workflow lists no steps._'));
});

test('managedBlock replaces, appends and removes', () => {
  const S = '<!-- x:start -->', E = '<!-- x:end -->';
  const appended = managedBlock('# Doc\n', S, E, 'one');
  assert.equal(appended, `# Doc\n\n${S}\none\n${E}\n`);
  const replaced = managedBlock(appended + '\ntail\n', S, E, 'two');
  assert.ok(replaced.includes(`${S}\ntwo\n${E}`) && !replaced.includes('one') && replaced.includes('tail'));
  assert.equal(managedBlock(replaced, S, E, 'two'), replaced);
  assert.ok(!managedBlock(replaced, S, E, null).includes(S));
});

test('agentMarkdown carries only the installed keys', () => {
  const md = agentMarkdown({ name: 'helper', description: 'Helps.', skills: ['a', 'b'], model: 'sonnet', body: '# Helper\n\nBody.' }, { platform: 'claude' });
  assert.equal(md, '---\nname: helper\ndescription: "Helps."\nskills: [a, b]\nmodel: sonnet\n---\n\n# Helper\n\nBody.\n');
  const bare = agentMarkdown({ name: 'h', description: 'd', skills: [], model: null, body: 'b' }, { platform: 'claude' });
  assert.ok(!bare.includes('skills') && !bare.includes('model'));
});

test('agentMarkdown emits the model hint for the platform it renders for', () => {
  const string = { name: 'h', description: 'd', skills: [], model: 'sonnet', body: 'b' };
  assert.ok(agentMarkdown(string, { platform: 'claude' }).includes('\nmodel: sonnet\n'));
  assert.ok(agentMarkdown(string, { platform: 'copilot' }).includes('\nmodel: sonnet\n'));
  const map = { ...string, model: { claude: 'opus', copilot: 'gemini-3.8-flash' } };
  assert.ok(agentMarkdown(map, { platform: 'claude' }).includes('\nmodel: opus\n'));
  assert.ok(agentMarkdown(map, { platform: 'copilot' }).includes('\nmodel: gemini-3.8-flash\n'));
  const partial = { ...string, model: { claude: 'opus' } };
  assert.ok(agentMarkdown(partial, { platform: 'claude' }).includes('\nmodel: opus\n'));
  assert.ok(!agentMarkdown(partial, { platform: 'copilot' }).includes('model:'));
  assert.ok(!agentMarkdown(map).includes('model:'), 'a map without a platform names no model');
});

test('managedBlock ignores markers mentioned inside a line of prose', () => {
  const S = '<!-- x:start -->', E = '<!-- x:end -->';
  const prose = `Between \`${S}\` / \`${E}\` only the block is rewritten.\n`;
  const out = managedBlock(prose, S, E, 'one');
  assert.ok(out.startsWith(prose));
  assert.ok(out.endsWith(`${S}\none\n${E}\n`));
});
