'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSuite, parseInlineMap } = require('../scripts/eval/cases');

const ROOT = path.join(__dirname, '..');

function tmpSuite(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-'));
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}
const CASE = '---\ntags: [trigger:positive]\nmax_turns: 3\n---\n\nrestart the api on staging\n';
const GRADER = '---\ntype: tool_used\ntool: Skill\nmin: 1\n---\n';

test('the catalog’s own suite loads without problems', () => {
  const { cases, errors } = loadSuite({ root: ROOT });
  assert.deepEqual(errors, [], 'every case in evals/ is valid');
  assert.ok(cases.length >= 40, `expected the migrated suite, found ${cases.length} cases`);
  const trigger = cases.find((c) => c.tags.includes('trigger:positive'));
  assert.equal(trigger.graders[0].type, 'tool_used');
  assert.equal(trigger.graders[0].min, 1, 'numeric grader options are numbers, not strings');
  assert.ok(cases.every((c) => c.group && c.prompt.trim()), 'every case has a group and a prompt');
});

test('a case is read with its graders, limits and context', () => {
  const root = tmpSuite({
    'evals/alpha/does-a-thing/prompt.md': CASE,
    'evals/alpha/does-a-thing/graders/skill-fired.md': GRADER,
    // case.yaml is a plain YAML document, never `---`-delimited — the native runner rejects
    // a wrapped one outright ("case.yaml must be a YAML object").
    'evals/alpha/does-a-thing/case.yaml': 'schema_version: "1.1"\nname: does-a-thing\ncontext:\n  scaffold_script: fixture.sh\n  add_dirs: [resources]\n',
    'evals/alpha/does-a-thing/fixture.sh': '#!/usr/bin/env bash\nexit 0\n',
  });
  const { cases, errors } = loadSuite({ root });
  assert.deepEqual(errors, []);
  assert.equal(cases.length, 1);
  const [c] = cases;
  assert.equal(c.name, 'does-a-thing');
  assert.equal(c.group, 'alpha');
  assert.equal(c.maxTurns, 3);
  assert.equal(c.timeoutSeconds, 300, 'the native default applies when the case is silent');
  assert.equal(c.context.scaffold_script, 'fixture.sh');
  assert.deepEqual(c.context.add_dirs, ['resources']);
});

test('a scaffold_script naming a file that does not exist is a lint error, not a silent no-op', () => {
  const root = tmpSuite({
    'evals/alpha/does-a-thing/prompt.md': CASE,
    'evals/alpha/does-a-thing/graders/skill-fired.md': GRADER,
    'evals/alpha/does-a-thing/case.yaml': 'schema_version: "1.1"\nname: does-a-thing\ncontext:\n  scaffold_script: gone.sh\n',
  });
  const { errors } = loadSuite({ root });
  assert.ok(errors.some((e) => e.includes('scaffold_script') && e.includes('gone.sh')), 'both arms execute this script — a missing one would run the case on a bare directory');
});

test('a case.yaml wrapped in --- like a frontmatter file is rejected, not silently misread', () => {
  const root = tmpSuite({
    'evals/alpha/does-a-thing/prompt.md': CASE,
    'evals/alpha/does-a-thing/graders/skill-fired.md': GRADER,
    'evals/alpha/does-a-thing/case.yaml': '---\nschema_version: "1.1"\nname: does-a-thing\n---\n',
  });
  const { errors } = loadSuite({ root });
  assert.ok(errors.some((e) => e.includes('case.yaml')), 'a wrapped case.yaml must fail loudly — the native runner rejects it too');
});

test('the loader rejects what the native runner would reject', () => {
  const root = tmpSuite({
    'evals/alpha/bad-key/prompt.md': '---\nturns: 3\n---\n\nhello\n',
    'evals/alpha/bad-key/graders/g.md': GRADER,
    'evals/alpha/bad-tag/prompt.md': '---\ntags: [urgent]\n---\n\nhello\n',
    'evals/alpha/bad-tag/graders/g.md': GRADER,
    'evals/alpha/no-graders/prompt.md': CASE,
    'evals/alpha/bad-grader/prompt.md': CASE,
    'evals/alpha/bad-grader/graders/g.md': '---\ntype: regex\n---\n',
    'evals/alpha/empty-prompt/prompt.md': '---\ntags: [behaviour]\n---\n',
    'evals/alpha/empty-prompt/graders/g.md': GRADER,
  });
  const { errors } = loadSuite({ root });
  const joined = errors.join('\n');
  assert.match(joined, /bad-key: unknown key "turns"/);
  assert.match(joined, /bad-tag: tag "urgent" is not one of/);
  assert.match(joined, /no-graders: a case needs at least one grader/);
  assert.match(joined, /bad-grader\/graders\/g\.md: a regex grader needs "pattern"/);
  assert.match(joined, /empty-prompt: the prompt body is empty/);
});

test('two cases may not share a name', () => {
  const root = tmpSuite({
    'evals/alpha/one/prompt.md': '---\nname: shared-name\ntags: [behaviour]\n---\n\nhi\n',
    'evals/alpha/one/graders/g.md': GRADER,
    'evals/beta/two/prompt.md': '---\nname: shared-name\ntags: [behaviour]\n---\n\nhi\n',
    'evals/beta/two/graders/g.md': GRADER,
  });
  const { errors } = loadSuite({ root });
  assert.match(errors.join('\n'), /case name "shared-name" is already used by evals\/alpha\/one/);
});

test('results, experiments, mocks and container hold no cases', () => {
  const root = tmpSuite({
    'evals/results/2026-01-01/prompt.md': CASE,
    'evals/experiments/x/prompt.md': CASE,
    'evals/scenarios/real/prompt.md': CASE,
    'evals/scenarios/real/graders/g.md': GRADER,
  });
  const { cases, errors } = loadSuite({ root });
  assert.deepEqual(errors, []);
  assert.deepEqual(cases.map((c) => c.name), ['real']);
});

test('a case tagged isolation:container gets isolation "container"; an ordinary case gets "native"', () => {
  const root = tmpSuite({
    'evals/alpha/needs-container/prompt.md': '---\ntags: [behaviour, isolation:container]\n---\n\ndo a thing in a container\n',
    'evals/alpha/needs-container/graders/g.md': GRADER,
    'evals/alpha/plain/prompt.md': CASE,
    'evals/alpha/plain/graders/g.md': GRADER,
  });
  const { cases, errors } = loadSuite({ root });
  assert.deepEqual(errors, []);
  const byName = Object.fromEntries(cases.map((c) => [c.name, c]));
  assert.equal(byName['needs-container'].isolation, 'container');
  assert.equal(byName['plain'].isolation, 'native');
});

test('the one inline map the format uses is parsed', () => {
  assert.deepEqual(parseInlineMap('{ source: file, path: out/report.md }'), { source: 'file', path: 'out/report.md' });
  assert.equal(parseInlineMap('last_message'), 'last_message');
});
