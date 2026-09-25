'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { build, generate, README_START, README_END, STYLE_START, STYLE_END } = require('../lib/build');
const { scanUnits } = require('../lib/units');

const FIX = path.join(__dirname, 'fixtures', 'catalog');
function tmpCatalog() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
  fs.cpSync(FIX, root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'x', version: '9.9.9', description: 'Fixture',
    author: { name: 'Fixture Team' }, homepage: 'https://example.invalid/home',
    repository: 'https://example.invalid/repo', license: 'MIT', keywords: ['fix'],
  }));
  fs.writeFileSync(path.join(root, 'README.md'), `# Fixture\n\nIntro.\n\n${README_START}\nold\n${README_END}\n\nOutro.\n`);
  return root;
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('build writes every artifact with the package version', () => {
  const root = tmpCatalog();
  const r = build({ root });
  assert.deepEqual(r.errors, []);
  const catalog = readJson(path.join(root, 'catalog.json'));
  assert.equal(catalog.version, '9.9.9');
  assert.deepEqual(catalog.skills.map((s) => s.name), ['alpha', 'beta', 'delta', 'gamma']);
  assert.deepEqual(catalog.skills[0].requires, ['beta']);
  assert.equal(catalog.agents[0].name, 'helper');
  assert.deepEqual(catalog.agents[0].model, { claude: 'opus', copilot: 'gemini-3.8-flash' }, 'catalog keeps the model as written');
  assert.equal(catalog.agents[1].model, 'sonnet');
  assert.deepEqual(catalog.workflows[0].steps, [{ agent: 'triager' }, { skill: 'gamma' }]);
  assert.deepEqual(catalog.bundles.map((b) => b.name), ['developers', 'qa']);
  const plugin = readJson(path.join(root, '.claude-plugin/plugin.json'));
  assert.equal(plugin.version, '9.9.9');
  // Claude's manifest lists PARENT folders (each holding <name>/SKILL.md), owner folders only.
  assert.deepEqual(plugin.skills, ['./skills/shared', './skills/developers', './skills/qa']);
  assert.deepEqual(plugin.agents, ['./agents/shared/helper.md', './agents/qa/triager.md']);
  assert.equal(plugin.hooks, './hooks/hooks.json');
  assert.equal(readJson(path.join(root, '.claude-plugin/marketplace.json')).plugins[0].version, '9.9.9');
  // Copilot's manifest: the same parent folders; agents is ONE directory of <name>.agent.md; hooks in Copilot format.
  const copilot = readJson(path.join(root, 'plugin.json'));
  assert.equal(copilot.version, '9.9.9');
  assert.deepEqual(copilot.skills, plugin.skills);
  assert.equal(copilot.agents, './.copilot-plugin/agents/');
  assert.equal(copilot.hooks, './.copilot-plugin/hooks.json');
  assert.deepEqual(fs.readdirSync(path.join(root, '.copilot-plugin/agents')).sort(), ['helper.agent.md', 'triager.agent.md']);
  const helper = fs.readFileSync(path.join(root, '.copilot-plugin/agents/helper.agent.md'), 'utf8');
  assert.ok(helper.startsWith('---\nname: helper\ndescription: "Helper role."\nskills: [alpha]\nmodel: gemini-3.8-flash\n---\n'), 'Copilot agent files carry the Copilot model');
  assert.ok(helper.includes('Does things.'));
  const triager = fs.readFileSync(path.join(root, '.copilot-plugin/agents/triager.agent.md'), 'utf8');
  assert.ok(triager.includes('\nmodel: sonnet\n'));
  // Both hook manifests come from the hand-written sources under hooks/.
  const hooks = readJson(path.join(root, '.copilot-plugin/hooks.json'));
  assert.equal(hooks.version, 1);
  const [start] = hooks.hooks.sessionStart;
  assert.equal(start.type, 'command');
  assert.ok(start.bash.includes('${COPILOT_PLUGIN_ROOT') && start.bash.includes('scripts/fixture-hook.sh" --quiet'));
  assert.ok(start.powershell.includes('$env:COPILOT_PLUGIN_ROOT') && start.powershell.includes('fixture-hook.ps1" -Quiet'));
  assert.equal(typeof start.timeoutSec, 'number');
  const claudeHooks = readJson(path.join(root, 'hooks/hooks.json'));
  assert.equal(claudeHooks.hooks.SessionStart[0].hooks[0].command, 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/fixture-hook.sh" --quiet');
  // Copilot's marketplace file.
  const market = readJson(path.join(root, '.github/plugin/marketplace.json'));
  assert.equal(market.name, 'engineering-catalog');
  assert.equal(market.metadata.version, '9.9.9');
  assert.ok(market.owner.name);
  assert.deepEqual(market.plugins, [{
    name: 'engineering-catalog', source: './', description: 'Fixture', version: '9.9.9',
    author: { name: 'Fixture Team' }, homepage: 'https://example.invalid/home',
    repository: 'https://example.invalid/repo', license: 'MIT', keywords: ['fix'],
  }]);
});

test('every manifest carries the publisher metadata a person sees before installing', () => {
  const root = tmpCatalog();
  build({ root });
  const market = readJson(path.join(root, '.claude-plugin/marketplace.json'));
  // `claude plugin validate --strict` fails a marketplace with no description and a plugin
  // with no author, and that is the check Anthropic's submission pipeline runs.
  assert.equal(market.description, 'Fixture');
  assert.deepEqual(market.owner, { name: 'Fixture Team' });
  for (const f of ['.claude-plugin/marketplace.json', '.github/plugin/marketplace.json']) {
    const entry = readJson(path.join(root, f)).plugins[0];
    assert.deepEqual(entry.author, { name: 'Fixture Team' }, `${f} entry has no author`);
    assert.equal(entry.homepage, 'https://example.invalid/home', `${f} entry has no homepage`);
    assert.equal(entry.license, 'MIT', `${f} entry has no license`);
  }
  for (const f of ['.claude-plugin/plugin.json', 'plugin.json']) {
    const m = readJson(path.join(root, f));
    assert.deepEqual(m.author, { name: 'Fixture Team' }, `${f} has no author`);
    assert.equal(m.repository, 'https://example.invalid/repo', `${f} has no repository`);
    assert.deepEqual(m.keywords, ['fix'], `${f} has no keywords`);
  }
  // displayName is Claude's field; Copilot's schema does not list it, so it stays out of the
  // manifest Copilot reads rather than being sent untested.
  assert.equal(readJson(path.join(root, '.claude-plugin/plugin.json')).displayName, 'AI Engineering Catalog');
  assert.equal(readJson(path.join(root, 'plugin.json')).displayName, undefined);
});

test('build deletes stale Copilot agent files; check mode reports them without deleting', () => {
  const root = tmpCatalog();
  build({ root });
  // What a removed (or demoted) agent leaves behind: a rendered file no source produces any more.
  const ghost = path.join(root, '.copilot-plugin/agents/ghost.agent.md');
  fs.writeFileSync(ghost, '---\nname: ghost\n---\n');
  const check = build({ root, check: true });
  assert.deepEqual(check.errors, []);
  assert.deepEqual(check.removed, ['.copilot-plugin/agents/ghost.agent.md']);
  assert.ok(fs.existsSync(ghost), 'check mode must not delete');
  assert.deepEqual(build({ root }).removed, ['.copilot-plugin/agents/ghost.agent.md']);
  assert.deepEqual(fs.readdirSync(path.join(root, '.copilot-plugin/agents')).sort(), ['helper.agent.md', 'triager.agent.md']);
  assert.deepEqual(build({ root, check: true }).removed, []);
});

test('unpromoted units reach no artifact; promoted reach README tables', () => {
  const root = tmpCatalog();
  build({ root });
  for (const f of ['catalog.json', 'plugin.json', '.claude-plugin/plugin.json', '.github/plugin/marketplace.json', 'README.md']) {
    assert.ok(!fs.readFileSync(path.join(root, f), 'utf8').includes('wip'), `${f} mentions wip`);
  }
  const plugin = readJson(path.join(root, '.claude-plugin/plugin.json'));
  assert.ok(!plugin.skills.some((p) => /in-progress|deprecated/.test(p)), 'Claude manifest lists a lifecycle folder');
  assert.ok(!plugin.skills.includes('./skills/ops') && !plugin.skills.includes('./skills/product'), 'Claude manifest lists an empty owner folder');
  const copilot = readJson(path.join(root, 'plugin.json'));
  assert.ok(!copilot.skills.some((p) => /in-progress|deprecated/.test(p)), 'Copilot manifest lists a lifecycle folder');
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.ok(readme.includes('Intro.') && readme.includes('Outro.'));
  assert.ok(!readme.includes('\nold\n'));
  assert.ok(readme.includes('| [alpha](skills/shared/alpha/SKILL.md) | shared | model |'));
  assert.ok(readme.includes('agent:triager → skill:gamma'));
  assert.ok(fs.readFileSync(path.join(root, 'skills/in-progress/README.md'), 'utf8').includes('[wip](wip/SKILL.md)'));
  assert.ok(fs.readFileSync(path.join(root, 'workflows/ops/README.md'), 'utf8').includes('_Nothing here yet._'));
});

test('build refuses on invariant errors and writes nothing', () => {
  const root = tmpCatalog();
  fs.writeFileSync(path.join(root, 'skills/qa/gamma/SKILL.md'), '---\nname: gamma\ndescription: d\nrequires:\n  - nope\n---\nb\n');
  const r = build({ root });
  assert.ok(r.errors.length > 0);
  assert.ok(!fs.existsSync(path.join(root, 'catalog.json')));
});

test('check mode reports stale artifacts and is clean after a build', () => {
  const root = tmpCatalog();
  assert.ok(build({ root, check: true }).written.includes('catalog.json'));
  build({ root });
  const clean = build({ root, check: true });
  assert.deepEqual(clean.written, []);
  assert.deepEqual(clean.removed, []);
});

test('the response style is written once and mirrored into the Copilot instructions', () => {
  const style = '---\nname: Terse\ndescription: d\n---\n\nLead with the answer.\n\n## Hard rules\n\n- No filler.\n';
  const instructions = '<!-- engineering-catalog:memory:start -->\nRead memory/index.md first.\n<!-- engineering-catalog:memory:end -->\n';
  const scanned = scanUnits({ root: FIX });
  const args = { units: scanned.units.filter((u) => u.promoted), allUnits: scanned.units, bundles: scanned.bundles, version: '9.9.9', description: 'd' };
  const file = generate({ ...args, styleFile: style, copilotInstructions: instructions })
    .find((f) => f.path === '.github/copilot-instructions.md');

  assert.ok(file, 'the Copilot instructions are generated when both sources exist');
  assert.match(file.content, /engineering-catalog:memory:start[\s\S]*Read memory\/index\.md first/,
    'the memory block and anything else in that file survive — only the style block is ours');
  assert.ok(!file.content.includes('name: Terse'), 'the style frontmatter is Claude Code metadata, not an instruction');
  assert.match(file.content, /## Response style[\s\S]*Lead with the answer\.[\s\S]*### Hard rules/,
    'the body lands under one heading, its own sections demoted below it');
  assert.match(file.content, new RegExp(`${STYLE_START}[\\s\\S]*${STYLE_END}`), 'the block is marked so a rebuild replaces it');

  const again = generate({ ...args, styleFile: style, copilotInstructions: file.content })
    .find((f) => f.path === '.github/copilot-instructions.md');
  assert.equal(again.content, file.content, 'rewriting an already-generated file is a no-op');

  assert.equal(generate(args).find((f) => f.path === '.github/copilot-instructions.md'), undefined,
    'a repository without an output style gets no block rather than an empty one');
});

test('generate is pure and deterministic', () => {
  const { units, bundles } = scanUnits({ root: FIX });
  const a = generate({ units, bundles, version: '1.0.0', description: 'd', source: 's', readme: '# R\n' });
  const b = generate({ units, bundles, version: '1.0.0', description: 'd', source: 's', readme: '# R\n' });
  assert.deepEqual(a, b);
  assert.ok(a.find((f) => f.path === 'README.md').content.includes(README_START));
});
