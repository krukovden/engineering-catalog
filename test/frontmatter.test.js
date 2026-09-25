'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter, parseYamlDocument } = require('../lib/frontmatter');

const fm = (yaml, body = 'Body.') => parseFrontmatter(`---\n${yaml}\n---\n\n${body}\n`);

test('scalars, quotes stripped, body trimmed', () => {
  const r = fm('name: foo\ndescription: "A thing"\nmodel: \'sonnet\'');
  assert.deepEqual(r.frontmatter, { name: 'foo', description: 'A thing', model: 'sonnet' });
  assert.equal(r.body, 'Body.');
});

test('no frontmatter yields empty object and the whole text as body', () => {
  assert.deepEqual(parseFrontmatter('# Hi\n'), { frontmatter: {}, body: '# Hi' });
});

test('folded and literal block scalars', () => {
  const r = fm('description: >\n  one\n  two\nnotes: |\n  a\n  b');
  assert.equal(r.frontmatter.description, 'one two');
  assert.equal(r.frontmatter.notes, 'a\nb');
});

test('list of scalars and inline list', () => {
  const r = fm('requires:\n  - ado-credentials\n  - grilling\nskills: [a, b]');
  assert.deepEqual(r.frontmatter.requires, ['ado-credentials', 'grilling']);
  assert.deepEqual(r.frontmatter.skills, ['a', 'b']);
});

test('list of single-key maps (workflow steps)', () => {
  const r = fm('steps:\n  - agent: qa-triage\n  - skill: ado-credentials');
  assert.deepEqual(r.frontmatter.steps, [{ agent: 'qa-triage' }, { skill: 'ado-credentials' }]);
});

test('one-level map', () => {
  const r = fm('platforms:\n  copilot: skip');
  assert.deepEqual(r.frontmatter.platforms, { copilot: 'skip' });
});

test('comments and blank lines are ignored', () => {
  const r = fm('# c\nname: x\n\nrequires:\n  # c\n  - y');
  assert.deepEqual(r.frontmatter, { name: 'x', requires: ['y'] });
});

test('a second nesting level throws', () => {
  assert.throws(() => fm('platforms:\n  copilot:\n    mode: skip'), /nests too deep/);
  assert.throws(() => fm('steps:\n  - agent:\n      name: x'), /nests too deep/);
});

test('mixed list and map block throws', () => {
  assert.throws(() => fm('x:\n  - a\n  b: c'), /mixes/);
});

test('an empty block is null', () => {
  assert.equal(fm('requires:\nname: x').frontmatter.requires, null);
});

test('parseYamlDocument reads the same grammar with no --- delimiters', () => {
  const doc = parseYamlDocument('schema_version: "1.1"\nname: x\ncontext:\n  scaffold_script: fixture.sh\n  add_dirs: [resources]\n');
  assert.deepEqual(doc, { schema_version: '1.1', name: 'x', context: { scaffold_script: 'fixture.sh', add_dirs: ['resources'] } });
});

test('parseYamlDocument throws on a stray --- delimiter, the same as any other malformed line', () => {
  assert.throws(() => parseYamlDocument('---\nname: x\n---\n'), /cannot parse frontmatter line/);
});
