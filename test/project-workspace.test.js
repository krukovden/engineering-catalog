'use strict';
// project-workspace: temp git repositories with a local bare "remote"; no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = path.join(__dirname, '..', 'skills/shared/project-workspace/scripts');
const L = require(path.join(DIR, 'workspace-logic.js'));
const W = require(path.join(DIR, 'workspace.js'));
const G = require(path.join(DIR, 'git.js'));

const NOW = '2026-10-13T12:00:00.000Z';
const later = (min) => new Date(Date.parse(NOW) + min * 60000).toISOString();

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Ann Tester', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'Ann Tester', GIT_COMMITTER_EMAIL: 'ann@example.com' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const ROOTS = [];
test.after(() => { for (const r of ROOTS) fs.rmSync(r, { recursive: true, force: true }); });

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pw-')));
  ROOTS.push(root);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const env = { ...GIT_ENV, ENGCAT_HOME: home, PROJECT_WORKSPACE_TIMEOUT_MS: '20000' };
  delete env.AZURE_DEVOPS_EXT_PAT; delete env.ADO_PAT; delete env.ADO_ORG; delete env.ADO_PROJECT;
  let now = NOW;
  const sb = {
    root, home, env,
    setNow: (t) => { now = t; },
    run: (...argv) => W.run(argv, { env, cwd: root, now: () => now, fetch: async () => { throw new Error('no network in tests'); }, runAz: () => { throw new Error('no az'); } }),
    // A bare remote with one commit on main; returns its path.
    remote(name, files = { 'README.md': `# ${name}\n` }, message = 'initial') {
      const bare = path.join(root, 'remotes', `${name}.git`);
      fs.mkdirSync(bare, { recursive: true });
      git(bare, 'init', '-q', '--bare', '-b', 'main');
      const seed = path.join(root, 'seeds', name);
      git(root, 'clone', '-q', bare, seed);
      sb.commit(seed, files, message);
      return bare;
    },
    commit(dir, files, message) {
      for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
        fs.writeFileSync(path.join(dir, f), c);
      }
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', message);
      if (dir.includes(`${path.sep}seeds${path.sep}`)) git(dir, 'push', '-q', 'origin', 'HEAD:main');
    },
    clone(bare, to) {
      const dest = path.join(root, to);
      git(root, 'clone', '-q', bare, dest);
      return dest;
    },
    map: () => JSON.parse(fs.readFileSync(path.join(home, '.engineering-catalog', 'repos.json'), 'utf8')),
  };
  return sb;
}

const assertNeeds = (out, kind) => {
  assert.equal(out.needs, kind, JSON.stringify(out));
  assert.equal(typeof out.ask, 'string');
  assert.ok(out.ask.length > 10);
  assert.ok(Array.isArray(out.options));
  assert.equal(typeof out.then, 'string');
  assert.doesNotMatch(out.ask, /origin\/|--|fetch|detached|workspace\.js/i, 'the question is for a person');
};

// --- pure ------------------------------------------------------------------------------

test('URL normalisation: https, ssh and visualstudio.com forms of one repository give one key', () => {
  const key = 'https://dev.azure.com/Contoso/Platform/_git/Warehouse';
  for (const u of [
    key, `${key}/`, `${key}.git`,
    'https://Contoso@dev.azure.com/Contoso/Platform/_git/Warehouse',
    'git@ssh.dev.azure.com:v3/Contoso/Platform/Warehouse',
    'ssh://git@ssh.dev.azure.com/v3/Contoso/Platform/Warehouse',
    'https://Contoso.visualstudio.com/Platform/_git/Warehouse',
    'https://Contoso.visualstudio.com/DefaultCollection/Platform/_git/Warehouse',
    'Contoso@vs-ssh.visualstudio.com:v3/Contoso/Platform/Warehouse',
    'Contoso/Platform/Warehouse',
  ]) assert.equal(L.normaliseUrl(u), key, u);
  assert.equal(L.normaliseUrl('https://dev.azure.com/o/My%20Project/_git/r'), L.normaliseUrl('git@ssh.dev.azure.com:v3/o/My Project/r'));
  assert.equal(L.normaliseUrl('git@github.com:acme/tool.git'), 'https://github.com/acme/tool');
  assert.equal(L.normaliseUrl('https://github.com/acme/tool'), 'https://github.com/acme/tool');
  const p = L.parseRepoUrl(key);
  assert.equal(L.storePath('/ref', p), path.join('/ref', 'Contoso', 'Platform', 'Warehouse'));
});

test('needs payloads carry ask, options and then', () => {
  const home = '/h';
  for (const [kind, out] of [
    ['setup', L.needsSetup({ referenceRoot: '/h/Documents/Projects/.reference', home })],
    ['clone-consent', L.needsCloneConsent([{ name: 'Warehouse', url: 'u1' }, { name: 'Reports', url: 'u2' }], { referenceRoot: '/h/r', home, retry: 'search --text "x" --all' })],
    ['which-repos', L.needsWhichRepos([{ name: 'Warehouse' }], 'x')],
    ['reset-consent', L.needsResetConsent({ name: 'Warehouse', url: 'u', changes: true, commits: false })],
    ['board-choice', L.needsBoardChoice('Warehouse', ['Warehouse Team'])],
  ]) assertNeeds(out, kind);
  const c = L.needsCloneConsent([{ name: 'Warehouse', url: 'u1' }, { name: 'Reports', url: 'u2' }], { referenceRoot: '/h/r', home, retry: 'search --text "x" --all' });
  assert.match(c.ask, /Warehouse and Reports are not on this computer/);
  assert.equal(c.then, 'search --text "x" --all --approved');
});

test('throttle and merge: pure decisions', () => {
  const base = { fetchedAt: NOW, fetchedPath: '/a', target: '/a', minutes: 10 };
  assert.equal(L.shouldFetch({ ...base, now: later(5) }), false);
  assert.equal(L.shouldFetch({ ...base, now: later(5), fresh: true }), true);
  assert.equal(L.shouldFetch({ ...base, now: later(10) }), true);
  assert.equal(L.shouldFetch({ ...base, now: later(1), target: '/b' }), true);
  let m = L.mergeEntry({}, 'k', { name: 'R', paths: ['/a'], board: { org: 'o', project: 'p' } });
  m = L.mergeEntry(m, 'k', { paths: ['/b'], board: { team: 'T' } });
  assert.deepEqual(m.k.paths, ['/a', '/b']);
  assert.deepEqual(m.k.board, { org: 'o', project: 'p', team: 'T' });
  m = L.markStale(m, 'k', '/a');
  assert.deepEqual([m.k.paths, m.k.stale], [['/b'], ['/a']]);
  assert.deepEqual(L.mergeEntry(m, 'k', { paths: ['/a'] }).k.stale, []);
});

test('pool keeps order and never exceeds its cap', async () => {
  let live = 0, peak = 0;
  const out = await G.pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live--;
    return x * 2;
  });
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

// --- commands --------------------------------------------------------------------------

test('setup without arguments asks; with a folder writes the config and maps the working root', async () => {
  const sb = sandbox();
  assertNeeds(await sb.run('setup'), 'setup');
  const bare = sb.remote('Alpha');
  const work = sb.clone(bare, 'src/Alpha');
  const ref = path.join(sb.root, 'ref');
  const bad = await sb.run('setup', '--reference-root', path.join(work, 'x'), '--working-root', path.join(sb.root, 'src'));
  assert.match(bad.error, /separate folders/);
  const out = await sb.run('setup', '--reference-root', ref, '--working-root', path.join(sb.root, 'src'));
  assert.deepEqual(out.registered, [{ name: 'Alpha', path: work }]);
  assert.deepEqual(sb.map()[bare].paths, [work]);
  const where = await sb.run('where');
  assert.equal(where.referenceRoot, ref);
  assert.equal(where.repos[0].name, 'Alpha');
});

test('fetch on a mapped working copy leaves its files, index and branch unchanged', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  const work = sb.clone(bare, 'src/Alpha');
  git(work, 'switch', '-q', '-c', 'feature/x');
  fs.writeFileSync(path.join(work, 'a.txt'), 'edited, not staged\n');
  fs.writeFileSync(path.join(work, 'b.txt'), 'staged\n');
  git(work, 'add', 'b.txt');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  assert.equal((await sb.run('register', work)).paths[0], work);
  sb.commit(path.join(sb.root, 'seeds', 'Alpha'), { 'c.txt': 'new on the server\n' }, 'server change');

  const before = { head: git(work, 'rev-parse', 'HEAD'), branch: git(work, 'branch', '--show-current'), status: git(work, 'status', '--porcelain'), cached: git(work, 'diff', '--cached'), diff: git(work, 'diff') };
  const out = await sb.run('ensure', bare);
  assert.equal(out.copy, 'working');
  assert.equal(out.fetched, true);
  assert.equal(out.ref, 'origin/main');
  assert.deepEqual({ head: git(work, 'rev-parse', 'HEAD'), branch: git(work, 'branch', '--show-current'), status: git(work, 'status', '--porcelain'), cached: git(work, 'diff', '--cached'), diff: git(work, 'diff') }, before);
  assert.equal(fs.readFileSync(path.join(work, 'a.txt'), 'utf8'), 'edited, not staged\n');
  assert.equal(fs.existsSync(path.join(work, 'c.txt')), false);
  assert.equal(git(work, 'rev-parse', 'origin/main'), git(sb.root, '--git-dir', bare, 'rev-parse', 'main'));
  assert.equal(git(work, 'stash', 'list'), '');
});

test('search finds text on origin/<default> that is absent from the working tree', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  sb.commit(path.join(sb.root, 'seeds', 'Alpha'), { 'src/export.js': 'function x() {\n  return emptyExportBug;\n}\n' }, 'fix: emptyExportBug in export');
  const out = await sb.run('search', '--text', 'emptyExportBug', '--repos', 'Alpha');
  assert.equal(out.partial, false);
  const code = out.results.find((r) => r.kind === 'code');
  assert.deepEqual([code.repo, code.file, code.line], ['Alpha', 'src/export.js', 2]);
  const commit = out.results.find((r) => r.kind === 'commit');
  assert.deepEqual(commit.match.sort(), ['change', 'message']);
  assert.equal(commit.author, 'Ann Tester');
  assert.equal(fs.existsSync(path.join(work, 'src/export.js')), false, 'the working tree is untouched');
});

test('search without repositories asks which; missing ones ask consent once for all', async () => {
  const sb = sandbox();
  const a = sb.remote('Alpha'), b = sb.remote('Beta');
  assertNeeds(await sb.run('search', '--text', 'x'), 'setup');
  assertNeeds(await sb.run('search', '--text', 'x', '--repos', `${a},${b}`), 'setup');
  assertNeeds(await sb.run('ensure', a), 'setup');
  assert.equal((await sb.run('where')).needs, 'setup', 'where keeps working without config');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  assertNeeds(await sb.run('search', '--text', 'x'), 'which-repos');
  const out = await sb.run('search', '--text', 'x', '--repos', `${a},${b}`);
  assertNeeds(out, 'clone-consent');
  assert.deepEqual(out.repos.map((r) => r.name), ['Alpha', 'Beta']);
  assert.match(out.then, /--approved$/);
  assert.equal(fs.existsSync(path.join(sb.root, 'ref', 'local', 'Alpha')), false, 'nothing cloned before the yes');
});

test('a store copy with local changes or commits returns reset-consent and nothing is discarded', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'one\n' });
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const cloned = await sb.run('ensure', bare, '--approved');
  const store = cloned.path;
  assert.equal(cloned.copy, 'store');
  assert.equal(git(store, 'branch', '--show-current'), '', 'detached');
  assert.equal(git(store, 'rev-parse', 'HEAD'), git(sb.root, '--git-dir', bare, 'rev-parse', 'main'));

  fs.writeFileSync(path.join(store, 'a.txt'), 'local edit\n');
  const out = await sb.run('ensure', bare);
  assertNeeds(out, 'reset-consent');
  assert.match(out.then, /--reset/);
  assert.equal(fs.readFileSync(path.join(store, 'a.txt'), 'utf8'), 'local edit\n');

  git(store, 'commit', '-qam', 'local commit');
  const head = git(store, 'rev-parse', 'HEAD');
  assertNeeds(await sb.run('ensure', bare, '--fresh'), 'reset-consent');
  assert.equal(git(store, 'rev-parse', 'HEAD'), head);

  const reset = await sb.run('ensure', bare, '--reset');
  assert.equal(reset.copy, 'store');
  assert.equal(git(store, 'rev-parse', 'HEAD'), git(sb.root, '--git-dir', bare, 'rev-parse', 'main'));
  assert.equal(git(store, 'status', '--porcelain'), '');
});

test('throttle: a second ensure within the window does not fetch; --fresh does', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  const seed = path.join(sb.root, 'seeds', 'Alpha');
  assert.equal((await sb.run('ensure', 'Alpha')).fetched, true);

  sb.commit(seed, { 'n.txt': '1\n' }, 'second');
  sb.setNow(later(3));
  const second = await sb.run('ensure', 'Alpha');
  assert.equal(second.fetched, false);
  assert.equal(second.fetchedAt, NOW);
  assert.equal(second.ageMinutes, 3);
  assert.notEqual(git(work, 'rev-parse', 'origin/main'), git(sb.root, '--git-dir', bare, 'rev-parse', 'main'), 'no fetch happened');

  const fresh = await sb.run('ensure', 'Alpha', '--fresh');
  assert.equal(fresh.fetched, true);
  assert.equal(git(work, 'rev-parse', 'origin/main'), git(sb.root, '--git-dir', bare, 'rev-parse', 'main'));

  sb.setNow(later(20));
  assert.equal((await sb.run('ensure', 'Alpha')).fetched, true, 'the window has passed');
});

test('a moved path goes to stale and search uses the store', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'needle here\n' });
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  fs.renameSync(work, path.join(sb.root, 'src', 'Moved'));

  assertNeeds(await sb.run('search', '--text', 'needle', '--repos', 'Alpha'), 'clone-consent');
  assert.deepEqual(sb.map()[bare].stale, [work]);
  const out = await sb.run('search', '--text', 'needle', '--repos', 'Alpha', '--approved');
  assert.equal(out.repos[0].copy, 'store');
  assert.equal(out.repos[0].path, path.join(sb.root, 'ref', 'local', 'Alpha'));
  assert.equal(out.results.filter((r) => r.kind === 'code').length, 1);
  assert.deepEqual(sb.map()[bare].paths, []);
});

test('one failing repository leaves the others\' results and marks the result partial', async () => {
  const sb = sandbox();
  const good = sb.remote('Alpha', { 'a.txt': 'needle\n' });
  await sb.run('register', sb.clone(good, 'src/Alpha'));
  const gone = sb.remote('Gone');
  await sb.run('register', sb.clone(gone, 'src/Gone'));
  fs.rmSync(path.join(sb.root, 'src', 'Gone'), { recursive: true });
  fs.rmSync(gone, { recursive: true });
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));

  const out = await sb.run('search', '--text', 'needle', '--all', '--approved');
  assert.equal(out.partial, true);
  assert.deepEqual(out.failed.map((f) => f.repo), ['Gone']);
  assert.deepEqual(out.found, { in: 1, of: 2 });
  assert.ok(out.results.some((r) => r.repo === 'Alpha' && r.kind === 'code'));
});

test('offline: results come back with offline true and the age of the copy', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'needle\n' });
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  await sb.run('ensure', 'Alpha');
  fs.renameSync(bare, bare + '.away');
  sb.setNow(later(90));
  const out = await sb.run('search', '--text', 'needle', '--repos', 'Alpha');
  assert.equal(out.offline, true);
  assert.equal(out.partial, false);
  assert.equal(out.repos[0].offline, true);
  assert.equal(out.repos[0].ageMinutes, 90);
  assert.equal(out.results.filter((r) => r.kind === 'code').length, 1);
});

test('link-board: without a team lists the project\'s teams; with one saves it', async () => {
  const sb = sandbox();
  const url = 'https://dev.azure.com/Contoso/Platform/_git/Warehouse';
  const calls = [];
  const deps = {
    env: { ...sb.env, AZURE_DEVOPS_EXT_PAT: 'test-only' }, cwd: sb.root, now: () => NOW, runAz: () => { throw new Error('no az'); },
    fetch: async (u, init) => {
      calls.push([u, init.headers.Authorization.startsWith('Basic ')]);
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ value: [{ name: 'Warehouse Team' }, { name: 'Alpha Team' }] }) };
    },
  };
  const out = await W.run(['link-board', url], deps);
  assertNeeds(out, 'board-choice');
  assert.deepEqual(out.options, ['Alpha Team', 'Warehouse Team', 'none']);
  assert.match(calls[0][0], /^https:\/\/dev\.azure\.com\/Contoso\/_apis\/projects\/Platform\/teams\?/);
  assert.equal(calls[0][1], true);
  const saved = await W.run(['link-board', url, '--team', 'Warehouse Team'], deps);
  assert.deepEqual(saved.board, { org: 'Contoso', project: 'Platform', team: 'Warehouse Team' });
  assert.doesNotMatch(fs.readFileSync(path.join(sb.home, '.engineering-catalog', 'repos.json'), 'utf8'), /test-only|Basic/);
  assert.match((await W.run(['link-board', 'https://github.com/acme/tool'], deps)).error, /not in Azure DevOps/);
});

// --- bare repository names -------------------------------------------------------------

// Remotes named like Azure Repos reached through git insteadOf; returns the https URL base.
function adoRemotes(sb, org, project, names) {
  const base = `https://dev.azure.com/${org}/${project}/_git/`;
  for (const n of names) sb.remote(n, { 'src/main.js': `// ${n} CSV header\n` });
  const k = Number(sb.env.GIT_CONFIG_COUNT || 0);
  sb.env.GIT_CONFIG_COUNT = String(k + 1);
  sb.env[`GIT_CONFIG_KEY_${k}`] = `url.file://${path.join(sb.root, 'remotes')}/.insteadOf`;
  sb.env[`GIT_CONFIG_VALUE_${k}`] = base;
  return base;
}
function adoContext(sb, organization, project) {
  const dir = path.join(sb.home, '.ado-credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ activeContext: 'main', contexts: [{ name: 'main', organization, project }] }));
}

test('a bare name found in the map resolves case-insensitively', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'), '--working-root', path.join(sb.root, 'src'));
  const out = await sb.run('ensure', 'alpha');
  assert.equal(out.path, work);
});

test('a bare name with one candidate project becomes that project\'s URL and asks clone consent', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Org', 'Proj', ['Warehouse', 'Reports']);
  adoContext(sb, 'https://dev.azure.com/Org', 'Proj');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const out = await sb.run('search', '--text', 'CSV header', '--repos', 'Warehouse,Reports');
  assertNeeds(out, 'clone-consent');
  assert.deepEqual(out.repos.map((r) => r.url), ['https://dev.azure.com/Org/Proj/_git/Warehouse', 'https://dev.azure.com/Org/Proj/_git/Reports']);
  assert.match(out.then, /--approved$/);
  const done = await sb.run('search', '--text', 'CSV header', '--repos', 'Warehouse,Reports', '--approved');
  assert.equal(done.found.in, 2, JSON.stringify(done));
  assert.ok(fs.existsSync(path.join(sb.root, 'ref', 'Org', 'Proj', 'Warehouse')));
});

test('candidate projects are deduplicated across map boards, cwd origin and credentials', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Org', 'Proj', ['Warehouse']);
  adoContext(sb, 'Org', 'proj');
  const here = path.join(sb.root, 'here');
  fs.mkdirSync(here);
  git(here, 'init', '-q');
  git(here, 'remote', 'add', 'origin', 'https://dev.azure.com/Org/Proj/_git/Other');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const run = (...argv) => W.run(argv, { env: sb.env, cwd: here, now: () => NOW, runAz: () => { throw new Error('no az'); } });
  assertNeeds(await run('ensure', 'Warehouse'), 'clone-consent');
});

test('several candidate projects ask which; none asks for the link', async () => {
  const sb = sandbox();
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const none = await sb.run('ensure', 'Warehouse');
  assertNeeds(none, 'repo-link');
  assert.match(none.ask, /Warehouse/);
  adoContext(sb, 'Org', 'Proj');
  const run = (...argv) => W.run(argv, { env: sb.env, cwd: sb.root, now: () => NOW, runAz: () => 'organization = https://dev.azure.com/Org2\nproject = Other\n' });
  const many = await run('search', '--text', 'x', '--repos', 'Warehouse');
  assertNeeds(many, 'which-project');
  assert.deepEqual(many.options, ['Org/Proj', 'Org2/Other']);
});

test('with no context, a bare name resolves through ADO_ORG/ADO_PROJECT or the --org/--project the person named', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Contoso', 'Platform', ['Warehouse']);
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const url = 'https://dev.azure.com/Contoso/Platform/_git/Warehouse';

  const named = await sb.run('search', '--text', 'CSV header', '--repos', 'Warehouse', '--org', 'Contoso', '--project', 'Platform');
  assertNeeds(named, 'clone-consent');
  assert.deepEqual(named.repos.map((r) => r.url), [url]);
  assert.match(named.then, /--org "Contoso" --project "Platform" --approved$/);
  const ensured = await sb.run('ensure', 'Warehouse', '--org', 'https://dev.azure.com/Contoso/', '--project', 'Platform');
  assertNeeds(ensured, 'clone-consent');
  assert.equal(ensured.repos[0].url, url);

  sb.env.ADO_ORG = 'https://dev.azure.com/Contoso'; sb.env.ADO_PROJECT = 'Platform';
  const fromEnv = await sb.run('ensure', 'Warehouse');
  assertNeeds(fromEnv, 'clone-consent');
  assert.equal(fromEnv.repos[0].url, url);
});

test('the person\'s named project wins over other candidates; --project alone narrows them', async () => {
  const sb = sandbox();
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  adoContext(sb, 'Org', 'Proj');
  const run = (...argv) => W.run(argv, { env: sb.env, cwd: sb.root, now: () => NOW, runAz: () => 'organization = https://dev.azure.com/Org2\nproject = Other\n' });
  assertNeeds(await run('ensure', 'Warehouse'), 'which-project');
  const narrowed = await run('ensure', 'Warehouse', '--project', 'other');
  assertNeeds(narrowed, 'clone-consent');
  assert.equal(narrowed.repos[0].url, 'https://dev.azure.com/Org2/Other/_git/Warehouse');
  const named = await run('ensure', 'Warehouse', '--org', 'Org3', '--project', 'Third');
  assert.equal(named.repos[0].url, 'https://dev.azure.com/Org3/Third/_git/Warehouse');
});

test('a link in the same --repos list names the project of its bare siblings', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Org', 'Proj', ['Warehouse', 'Reports']);
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const repos = 'https://dev.azure.com/Org/Proj/_git/Warehouse,Reports';
  const out = await sb.run('search', '--text', 'CSV header', '--repos', repos);
  assertNeeds(out, 'clone-consent');
  assert.deepEqual(out.repos.map((r) => r.url), ['https://dev.azure.com/Org/Proj/_git/Warehouse', 'https://dev.azure.com/Org/Proj/_git/Reports']);
  const done = await sb.run('search', '--text', 'CSV header', '--repos', repos, '--approved');
  assert.equal(done.found.in, 2, JSON.stringify(done));
  // Links into two projects leave a bare sibling ambiguous between exactly those two.
  const two = await sb.run('search', '--text', 'x', '--repos', 'Org/Proj/Warehouse,Org2/Other/Thing,Sidecar');
  assertNeeds(two, 'which-project');
  assert.deepEqual(two.options, ['Org/Proj', 'Org2/Other']);
});

test('a bare name that does not exist in the project fails in plain words', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Org', 'Proj', ['Warehouse']);
  adoContext(sb, 'Org', 'Proj');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const out = await sb.run('ensure', 'Nope', '--approved');
  assert.match(out.error, /Nope.*Org\/Proj/);
});

test('a store copy is recognised when git rewrites its origin through insteadOf', async () => {
  const sb = sandbox();
  adoRemotes(sb, 'Org', 'Proj', ['Warehouse']);
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const url = 'https://dev.azure.com/Org/Proj/_git/Warehouse';
  assert.ok((await sb.run('ensure', url, '--approved')).path);
  const again = await sb.run('ensure', url, '--fresh');
  assert.equal(again.copy, 'store', JSON.stringify(again));
});

// --- review fixes ----------------------------------------------------------------------

const writeState = (sb, config, map) => {
  const dir = path.join(sb.home, '.engineering-catalog');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify(config));
  if (map) fs.writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(map));
};

test('a shared folder that is a symlink to the working folder is refused, and never treated as the store', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'one\n' });
  const src = path.join(sb.root, 'src');
  const work = sb.clone(bare, 'src/local/Alpha');
  git(work, 'switch', '-q', '-c', 'feature/x');
  const link = path.join(sb.root, 'ref');
  fs.symlinkSync(src, link);
  assert.match((await sb.run('setup', '--reference-root', link, '--working-root', src)).error, /separate folders/);
  assert.match((await sb.run('setup', '--reference-root', path.join(link, 'deeper'), '--working-root', src)).error, /separate folders/);
  assert.equal(fs.existsSync(path.join(sb.home, '.engineering-catalog', 'workspace.json')), false);

  // A config written before the check: the alias still never makes a working copy a store copy.
  writeState(sb, { referenceRoot: link, workingRoot: src });
  const reg = await sb.run('register', work);
  assert.deepEqual([reg.paths, reg.reference], [[work], undefined]);
  writeState(sb, { referenceRoot: link, workingRoot: src }, { [bare]: { name: 'Alpha', paths: [], stale: [], reference: path.join(link, 'local', 'Alpha') } });
  sb.commit(path.join(sb.root, 'seeds', 'Alpha'), { 'b.txt': 'server\n' }, 'server change');
  const out = await sb.run('ensure', 'Alpha', '--reset');
  assert.match(out.error, /refusing/, JSON.stringify(out));
  assert.equal(git(work, 'branch', '--show-current'), 'feature/x');
  assert.match(git(work, 'branch', '--list'), /feature\/x/);
});

test('a store copy is never inside a mapped working copy, and setup refuses a shared folder that overlaps one', async () => {
  const sb = sandbox();
  const parent = sb.remote('Parent');
  const childBare = sb.remote('Child', { 'a.txt': 'one\n' });
  const work = sb.clone(parent, 'work');
  const child = sb.clone(childBare, 'work/local/Child');
  git(child, 'switch', '-q', '-c', 'feature/developer');
  await sb.run('register', work);
  const link = path.join(sb.root, 'ref');
  fs.symlinkSync(work, link);
  assert.match((await sb.run('setup', '--reference-root', link)).error, /separate from your own projects/);
  fs.mkdirSync(path.join(sb.root, 'outer'));
  fs.symlinkSync(sb.root, path.join(sb.root, 'outer', 'all'));
  assert.match((await sb.run('setup', '--reference-root', path.join(sb.root, 'outer', 'all'))).error, /separate from your own projects/, 'a store holding a working copy');
  assert.equal(fs.existsSync(path.join(sb.home, '.engineering-catalog', 'workspace.json')), false);

  writeState(sb, { referenceRoot: link }, sb.map());
  sb.commit(path.join(sb.root, 'seeds', 'Child'), { 'b.txt': 'server\n' }, 'server change');
  const head = git(child, 'rev-parse', 'HEAD');
  const out = await sb.run('ensure', childBare, '--reset');
  assert.match(out.error || '', /refusing/, JSON.stringify(out));
  assert.equal(git(child, 'branch', '--show-current'), 'feature/developer');
  assert.equal(git(child, 'rev-parse', 'HEAD'), head);
});

test('an ignored file in the store copy asks before a checkout could overwrite it', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { '.gitignore': 'local.cfg\n' });
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const store = (await sb.run('ensure', bare, '--approved')).path;
  fs.writeFileSync(path.join(store, 'local.cfg'), 'mine\n');
  const seed = path.join(sb.root, 'seeds', 'Alpha');
  fs.writeFileSync(path.join(seed, 'local.cfg'), 'server\n');
  git(seed, 'add', '-f', 'local.cfg');
  git(seed, 'commit', '-q', '-m', 'track local.cfg');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');

  const out = await sb.run('ensure', bare, '--fresh');
  assertNeeds(out, 'reset-consent');
  assert.deepEqual(out.files, ['local.cfg']);
  assert.match(out.ask, /local\.cfg/);
  assert.equal(fs.readFileSync(path.join(store, 'local.cfg'), 'utf8'), 'mine\n');
  await sb.run('ensure', bare, '--reset');
  assert.equal(fs.readFileSync(path.join(store, 'local.cfg'), 'utf8'), 'server\n');
});

test('a local branch named origin/main does not shadow the server\'s branch', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'old\n' });
  const work = sb.clone(bare, 'src/Alpha');
  git(work, 'branch', 'origin/main');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  sb.commit(path.join(sb.root, 'seeds', 'Alpha'), { 'b.txt': 'shadowNeedle\n' }, 'add shadowNeedle');
  const out = await sb.run('search', '--text', 'shadowNeedle', '--repos', 'Alpha');
  assert.equal(out.repos[0].ref, 'origin/main');
  assert.deepEqual(out.results.filter((r) => r.kind === 'code').map((r) => r.file), ['b.txt']);
});

test('a store copy on a branch at the server\'s commit is detached', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const store = (await sb.run('ensure', bare, '--approved')).path;
  git(store, 'switch', '-q', '-c', 'main');
  const out = await sb.run('ensure', bare);
  assert.equal(out.copy, 'store', JSON.stringify(out));
  assert.equal(git(store, 'branch', '--show-current'), '');
  assert.equal(git(store, 'for-each-ref', 'refs/heads'), '');
});

test('a failed history check never authorises a reset: a corrupt ref keeps the store copy and asks', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'one\n' });
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const store = (await sb.run('ensure', bare, '--approved')).path;
  git(store, 'switch', '-q', '-c', 'local-work');
  fs.writeFileSync(path.join(store, 'a.txt'), 'unpublished\n');
  git(store, 'commit', '-qam', 'unpublished work');
  const head = git(store, 'rev-parse', 'HEAD');
  // A remote-tracking ref pointing at an object that does not exist makes rev-list fail.
  fs.mkdirSync(path.join(store, '.git', 'refs', 'remotes', 'backup'), { recursive: true });
  fs.writeFileSync(path.join(store, '.git', 'refs', 'remotes', 'backup', 'old-topic'), `${'0'.repeat(39)}1\n`);
  const out = await sb.run('ensure', bare, '--fresh');
  assert.notEqual(out.copy, 'store', JSON.stringify(out));
  assert.equal(git(store, 'rev-parse', 'HEAD'), head, 'the unpublished commit is still checked out');
  assert.equal(git(store, 'branch', '--show-current'), 'local-work');
});

test('board-choice continues with the repository link, so following it works for an unmapped repository', async () => {
  const sb = sandbox();
  const deps = {
    env: { ...sb.env, AZURE_DEVOPS_EXT_PAT: 'test-only' }, cwd: sb.root, now: () => NOW, runAz: () => { throw new Error('no az'); },
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ value: [{ name: 'Team A' }] }) }),
  };
  // Follows `then` the way the model does: its quoted and bare words become argv.
  const follow = (then, team) => W.run(then.replace('<team>', team).match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, '')), deps);
  const ado = await W.run(['link-board', 'https://dev.azure.com/Org/Proj/_git/Repo'], deps);
  assert.equal(ado.then, 'link-board "https://dev.azure.com/Org/Proj/_git/Repo" --team "<team>"');
  assert.deepEqual((await follow(ado.then, 'Team A')).board, { org: 'Org', project: 'Proj', team: 'Team A' });
  const gh = await W.run(['link-board', 'https://github.com/acme/tool', '--org', 'Org', '--project', 'Proj'], deps);
  assert.deepEqual((await follow(gh.then, 'Team A')).board, { org: 'Org', project: 'Proj', team: 'Team A' });
});

test('earlier QA-Workspaces copies come back as a needs decision, and following then moves them', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const old = path.join(sb.home, 'QA-Workspaces', 'ann', 'Alpha');
  git(sb.root, 'clone', '-q', bare, old);
  const ref = path.join(sb.root, 'ref');
  const out = await sb.run('setup', '--reference-root', ref);
  assertNeeds(out, 'move-qa-workspaces');
  assert.deepEqual(out.qaWorkspaces.map((q) => q.from), [old]);
  assert.ok(fs.existsSync(old), 'nothing moved before the yes');
  const skill = fs.readFileSync(path.join(DIR, '..', 'SKILL.md'), 'utf8');
  assert.match(skill, /^\| `move-qa-workspaces` \|/m);
  const moved = await sb.run(...out.then.match(/"[^"]*"|\S+/g).map((w) => w.replace(/^"|"$/g, '')));
  assert.deepEqual(moved.moved.map((q) => q.to), [path.join(ref, 'local', 'Alpha')]);
  assert.equal(moved.needs, undefined);
  assert.equal(fs.existsSync(old), false);
});

test('concurrent commands keep each other\'s registrations; a stale map lock is broken', async () => {
  const sb = sandbox();
  const work = ['Alpha', 'Beta', 'Gamma'].map((n) => sb.clone(sb.remote(n), `src/${n}`));
  const outs = await Promise.all(work.map((w) => sb.run('register', w)));
  for (const o of outs) assert.ok(o.url, JSON.stringify(o));
  assert.deepEqual(Object.values(sb.map()).map((e) => e.name).sort(), ['Alpha', 'Beta', 'Gamma']);
  const lock = path.join(sb.home, '.engineering-catalog', 'repos.json.lock');
  assert.equal(fs.existsSync(lock), false);

  fs.writeFileSync(lock, '');
  const old = new Date(Date.now() - 31000);
  fs.utimesSync(lock, old, old);
  const delta = sb.clone(sb.remote('Delta'), 'src/Delta');
  assert.ok((await sb.run('register', delta)).url);
  assert.equal(Object.keys(sb.map()).length, 4);
  assert.equal(fs.existsSync(lock), false);
});

test('a lock is owned: a live holder is never taken over, a dead one is; release and heartbeat honour the token', async () => {
  const sb = sandbox();
  const lock = path.join(sb.root, 'x.lock');
  const longAgo = new Date(Date.now() - 3600000).toISOString();
  const host = os.hostname();

  fs.writeFileSync(lock, JSON.stringify({ token: 'live', pid: process.pid, host, at: longAgo }));
  assert.equal(await W.acquireLock(lock, { staleMs: 1000 }), null, 'a live pid on this host keeps its lock however old');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'live');

  const dead = require('child_process').spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(lock, JSON.stringify({ token: 'dead', pid: dead, host, at: longAgo }));
  const release = await W.acquireLock(lock, { staleMs: 1000 });
  assert.ok(release, 'a stale lock of a dead pid is taken over');
  const mine = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(mine.pid, process.pid);
  assert.notEqual(mine.token, 'dead');

  await new Promise((r) => setTimeout(r, 700));
  assert.ok(Date.parse(JSON.parse(fs.readFileSync(lock, 'utf8')).at) > Date.parse(mine.at), 'the holder refreshes `at`');

  fs.writeFileSync(lock, JSON.stringify({ token: 'other', pid: process.pid, host, at: new Date().toISOString() }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).token, 'other', 'release leaves a lock it no longer owns');
});

test('two names for one repository download it once; a held download lock is respected, a stale one broken', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'aliasNeedle\n' });
  const ref = path.join(sb.root, 'ref');
  await sb.run('setup', '--reference-root', ref);
  writeState(sb, { referenceRoot: ref, fetchEveryMinutes: 10 }, { [bare]: { name: 'Alpha', paths: [], stale: [] } });
  const clones = [];
  const real = G.git;
  G.git = (args, opts) => { if (args[0] === 'clone') clones.push(args); return real(args, opts); };
  try {
    const out = await sb.run('search', '--text', 'aliasNeedle', '--repos', `Alpha,alpha,${bare}`, '--approved');
    assert.equal(clones.length, 1, JSON.stringify(clones));
    assert.equal(out.found.in, 1, JSON.stringify(out));
    assert.equal(out.partial, false);
  } finally { G.git = real; }

  const dest = path.join(ref, 'local', 'Beta');
  const betaBare = sb.remote('Beta');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(`${dest}.lock`, '');
  assert.match((await sb.run('ensure', betaBare, '--approved')).error, /being downloaded/);
  assert.equal(fs.existsSync(dest), false);
  assert.ok(fs.existsSync(`${dest}.lock`), 'another process\'s lock is left alone');
  const old = new Date(Date.now() - 11 * 60000);
  fs.utimesSync(`${dest}.lock`, old, old);
  assert.equal((await sb.run('ensure', betaBare, '--approved')).copy, 'store');
  assert.equal(fs.existsSync(`${dest}.lock`), false);

  // A failed download never deletes a folder this process did not create.
  const gone = path.join(ref, 'local', 'Gone');
  fs.mkdirSync(gone);
  assert.match((await sb.run('ensure', path.join(sb.root, 'remotes', 'Gone.git'), '--approved')).error, /could not download/);
  assert.ok(fs.existsSync(gone));
});

test('Windows handoff: a PAT only in the environment authenticates git and REST, and lands in no argv or file', async () => {
  const skill = fs.readFileSync(path.join(DIR, '..', 'SKILL.md'), 'utf8');
  const model = skill.slice(skill.indexOf('## Commands — for the model only'));
  assert.ok(model.includes('  $env:AZURE_DEVOPS_EXT_PAT = & "$env:USERPROFILE\\.ado-credentials\\get-pat.ps1" "Password"\n  node "<SKILL_DIR>/scripts/workspace.js" '), 'the copyable PowerShell handoff');

  const sb = sandbox();
  const base = adoRemotes(sb, 'Org', 'Proj', ['Warehouse']);
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const pat = 'pat-only-in-env-123';
  const secrets = [pat, Buffer.from(':' + pat).toString('base64')];
  const env = { ...sb.env, AZURE_DEVOPS_EXT_PAT: pat };
  const rest = [];
  const deps = {
    env, cwd: sb.root, now: () => NOW, runAz: () => { throw new Error('no az'); },
    fetch: async (u, init) => { rest.push(init.headers.Authorization); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{"value":[]}' }; },
  };
  const calls = [];
  const real = G.git;
  G.git = (args, opts = {}) => { calls.push({ args, env: opts.env || {} }); return real(args, opts); };
  try {
    const out = await W.run(['ensure', `${base}Warehouse`, '--approved'], deps);
    assert.equal(out.copy, 'store', JSON.stringify(out));
    await W.run(['link-board', `${base}Warehouse`], deps);
  } finally { G.git = real; }

  const clone = calls.find((c) => c.args[0] === 'clone');
  const n = Number(sb.env.GIT_CONFIG_COUNT);
  assert.equal(clone.env[`GIT_CONFIG_KEY_${n}`], 'http.extraHeader');
  assert.equal(clone.env[`GIT_CONFIG_VALUE_${n}`], `Authorization: Basic ${secrets[1]}`);
  assert.deepEqual(rest, [`Basic ${secrets[1]}`]);
  for (const c of calls) for (const s of secrets) assert.ok(!c.args.join(' ').includes(s), c.args.join(' '));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(sb.home), ...walk(path.join(sb.root, 'ref'))]) {
    const body = fs.readFileSync(f, 'latin1');
    for (const s of secrets) assert.ok(!body.includes(s), f);
  }
});

test('qa-ado-work-item refreshes no checkout when project-workspace is installed; the legacy pull is only a fallback', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills/qa/qa-ado-work-item/SKILL.md'), 'utf8');
  const step1 = skill.slice(skill.indexOf('## Step 1'), skill.indexOf('## Step 2'));
  const paragraphs = step1.split(/\n\s*\n/);
  const route = paragraphs.findIndex((p) => p.includes('sync-context.ps1'));
  assert.ok(route > 0, 'the legacy route is still described');
  assert.match(paragraphs[route - 1], /only when the `project-workspace` skill is not installed/i);
  assert.match(step1, /Do not refresh or pull any repository/);
  for (const line of skill.split('\n').filter((l) => /sync-context\.ps1/.test(l) && !l.includes('powershell'))) {
    assert.match(line, /not installed|legacy/i, line);
  }
});

test('eval first-run-asks-folder: the no-write grader sees a config the skill wrote to HOME', async () => {
  const { gradeFileExists } = require(path.join(__dirname, '..', 'scripts/eval/graders.js'));
  const sb = sandbox();
  const workdir = path.join(sb.root, 'work');
  fs.mkdirSync(workdir);
  const scaffold = path.join(__dirname, '..', 'evals/project-workspace/first-run-asks-folder/scaffold.sh');
  execFileSync('bash', [scaffold], { cwd: workdir, env: { ...sb.env, HOME: sb.home } });
  const grader = { type: 'file_exists', path: '.engineering-catalog/workspace.json', exists: false };
  assert.equal(gradeFileExists(grader, { workdir }).passed, true);
  const r = await sb.run('setup', '--reference-root', path.join(sb.root, 'store'));
  assert.ok(r.ok || !r.error, JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(sb.home, '.engineering-catalog', 'workspace.json')));
  assert.equal(gradeFileExists(grader, { workdir }).passed, false);
});

test('a configured forced refspec never moves a local branch of a working copy', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'one\n' });
  const work = sb.clone(bare, 'src/Alpha');
  git(work, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/heads/main');
  git(work, 'config', 'remote.origin.tagOpt', '--tags');
  sb.commit(work, { 'mine.txt': 'unpublished\n' }, 'local only');
  git(work, 'switch', '-q', '-c', 'feature/developer');
  const mine = git(work, 'rev-parse', 'main');
  writeState(sb, { referenceRoot: path.join(sb.root, 'ref') });
  await sb.run('register', work);
  sb.commit(path.join(sb.root, 'seeds', 'Alpha'), { 'b.txt': 'server\n' }, 'server change');
  git(path.join(sb.root, 'seeds', 'Alpha'), 'tag', 'v1');
  git(path.join(sb.root, 'seeds', 'Alpha'), 'push', '-q', 'origin', 'v1');
  const out = await sb.run('ensure', 'Alpha', '--fresh');
  assert.equal(out.copy, 'working', JSON.stringify(out));
  assert.equal(out.offline, false);
  assert.equal(git(work, 'rev-parse', 'main'), mine);
  assert.equal(git(work, 'tag', '--list'), '');
  assert.equal(git(work, 'branch', '--show-current'), 'feature/developer');
  assert.notEqual(git(work, 'rev-parse', 'origin/main'), mine);
});

test('a registration that lands during ensure is seen before the store copy is changed', async () => {
  const sb = sandbox();
  const parent = sb.remote('Parent');
  const childBare = sb.remote('Child', { 'a.txt': 'one\n' });
  const work = sb.clone(parent, 'work');
  const child = sb.clone(childBare, 'work/references/Child');
  git(child, 'switch', '-q', '-c', 'feature/developer');
  writeState(sb, { referenceRoot: path.join(work, 'references') }, { [childBare]: { name: 'Child', paths: [], stale: [], reference: child } });
  sb.commit(path.join(sb.root, 'seeds', 'Child'), { 'b.txt': 'server\n' }, 'server change');
  const head = git(child, 'rev-parse', 'HEAD');
  const out = await W.run(['ensure', childBare, '--fresh', '--reset'], {
    env: sb.env, cwd: sb.root, now: () => NOW,
    beforeDestructive: async () => { assert.ok((await sb.run('register', work)).url); },
  });
  assert.match(out.error || '', /refusing/, JSON.stringify(out));
  assert.equal(git(child, 'branch', '--show-current'), 'feature/developer');
  assert.equal(git(child, 'rev-parse', 'HEAD'), head);
});

test('concurrent registers of two clones of one origin keep both paths', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const [a, b] = [sb.clone(bare, 'src/one'), sb.clone(bare, 'src/two')];
  await Promise.all([sb.run('register', a), sb.run('register', b)]);
  assert.deepEqual(Object.values(sb.map())[0].paths.sort(), [a, b].sort());
  assert.deepEqual(L.mergeMapChanges({ k: { paths: ['/x', '/y/'] } }, { k: { paths: [] } }, { k: { paths: ['/z', '/X'] } }, (p) => p.toLowerCase().replace(/\/$/, '')).k.paths, ['/x', '/y/', '/z']);
});

test('a damaged repos.json or workspace.json is an error naming the file and is never overwritten', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha');
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  const dir = path.join(sb.home, '.engineering-catalog');
  for (const name of ['repos.json', 'workspace.json']) {
    const file = path.join(dir, name);
    const good = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '{ not json');
    for (const argv of [['register', work], ['ensure', 'Alpha'], ['search', '--text', 'x', '--repos', 'Alpha'], ['setup', '--reference-root', path.join(sb.root, 'ref2')]]) {
      const out = await sb.run(...argv);
      assert.match(out.error, new RegExp(`${name.replace('.', '\\.')} is damaged`), `${name}: ${argv[0]}`);
    }
    assert.equal(fs.readFileSync(file, 'utf8'), '{ not json', `${name} left as it was`);
    fs.writeFileSync(file, good);
  }
});

test('a state file that cannot be read (not a file) is an error, not an empty map', async () => {
  const sb = sandbox();
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const work = sb.clone(sb.remote('Alpha'), 'src/Alpha');
  const file = path.join(sb.home, '.engineering-catalog', 'repos.json');
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
  const out = await sb.run('register', work);
  assert.match(out.error, /could not read .*repos\.json/);
});

// The server drops its old default branch: origin/HEAD is left pointing at nothing.
function moveDefault(sb, bare) {
  const seed = path.join(sb.root, 'seeds', 'Alpha');
  git(seed, 'push', '-q', 'origin', 'HEAD:refs/heads/trunk');
  git(sb.root, '--git-dir', bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
  git(sb.root, '--git-dir', bare, 'branch', '-q', '-D', 'main');
}

test('a dangling origin/HEAD on a store copy is refreshed from the server', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'needle\n' });
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  assert.equal((await sb.run('ensure', bare, '--approved')).ref, 'origin/main');
  const store = sb.map()[bare].reference;
  git(store, 'config', 'remote.origin.followRemoteHEAD', 'never');
  moveDefault(sb, bare);
  sb.setNow(later(20));
  const out = await sb.run('ensure', bare);
  assert.equal(out.ref, 'origin/trunk');
  assert.equal(git(store, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/trunk');
  assert.equal((await sb.run('search', '--text', 'needle', '--repos', bare)).results.filter((r) => r.kind === 'code').length, 1);
});

test('a dangling origin/HEAD on a working copy resolves the server default without writing outside origin/*', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'needle\n' });
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  git(work, 'config', 'remote.origin.followRemoteHEAD', 'never');
  moveDefault(sb, bare);
  sb.setNow(later(20));
  const out = await sb.run('ensure', 'Alpha');
  assert.equal(out.ref, 'origin/trunk');
  assert.equal(git(work, 'symbolic-ref', 'refs/remotes/origin/HEAD'), 'refs/remotes/origin/main', 'origin/HEAD not rewritten');
  assert.equal(git(work, 'for-each-ref', '--format=%(refname)', 'refs/heads'), 'refs/heads/main');
});

test('every search result carries the age of the snapshot it read, online or not', async () => {
  const sb = sandbox();
  const bare = sb.remote('Alpha', { 'a.txt': 'needle\n' });
  const work = sb.clone(bare, 'src/Alpha');
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  await sb.run('register', work);
  await sb.run('ensure', 'Alpha');
  sb.setNow(later(4));
  const out = await sb.run('search', '--text', 'needle', '--repos', 'Alpha');
  assert.equal(out.offline, false);
  assert.equal(out.ageMinutes, 4);
  assert.equal(out.repos[0].ageMinutes, 4);
  assert.equal((await sb.run('search', '--text', 'needle', '--repos', 'Alpha', '--fresh')).ageMinutes, 0);
});

test('SKILL.md tells the model to use --fresh for just-pushed questions and to say the age', () => {
  const md = fs.readFileSync(path.join(DIR, '..', 'SKILL.md'), 'utf8');
  assert.match(md, /--fresh[^\n]*\n?[^\n]*just pushed/);
  assert.match(md, /right now/);
  assert.match(md, /how old/);
});

test('storePath refuses decoded segments that escape the reference store', () => {
  const root = path.join(os.tmpdir(), 'ref-root');
  for (const url of [
    'https://dev.azure.com/org/proj/_git/%2E%2E%2F%2E%2E%2Fevil',
    'https://dev.azure.com/org/%2E%2E/_git/repo',
    'https://dev.azure.com/org/proj/_git/a%5Cb',
    'https://dev.azure.com/%2E%2E/proj/_git/repo',
    'https://dev.azure.com/org/proj/_git/%2E',
    'https://dev.azure.com/org/proj/_git/a%00b',
  ]) {
    const parsed = L.parseRepoUrl(url);
    assert.throws(() => L.storePath(root, parsed), /unsafe repository location/, url);
  }
  assert.throws(() => L.storePath(root, { kind: 'github', org: '..', repo: 'x' }), /unsafe/);
  assert.equal(L.storePath(root, L.parseRepoUrl('https://dev.azure.com/o/My%20Project/_git/r')), path.join(root, 'o', 'My Project', 'r'));
});

test('ensure on an unsafe repository link is an error and clones nothing', async () => {
  const sb = sandbox();
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const out = await sb.run('ensure', 'https://dev.azure.com/org/proj/_git/%2E%2E%2F%2E%2E%2Fevil', '--approved');
  assert.match(out.error, /unsafe repository location/);
  assert.equal(fs.existsSync(path.join(sb.root, 'evil')), false);
});

test('link-board normalises a full organization URL before building the teams endpoint', async () => {
  const sb = sandbox();
  const calls = [];
  const deps = {
    env: { ...sb.env, AZURE_DEVOPS_EXT_PAT: 'test-only' }, cwd: sb.root, now: () => NOW, runAz: () => { throw new Error('no az'); },
    fetch: async (u) => { calls.push(u); return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ value: [{ name: 'T' }] }) }; },
  };
  const gh = 'https://github.com/acme/tool';
  for (const org of ['https://dev.azure.com/acme', 'https://acme.visualstudio.com']) {
    await W.run(['link-board', gh, '--org', org, '--project', 'P'], deps);
    assert.match(calls.pop(), /^https:\/\/dev\.azure\.com\/acme\/_apis\/projects\/P\/teams\?/, org);
  }
  const saved = await W.run(['link-board', gh, '--org', 'https://dev.azure.com/acme/', '--project', 'P', '--team', 'T'], deps);
  assert.equal(saved.board.org, 'acme');
});

test('SKILL.md forbids deciding for the person and text beside tool calls (live capture: a one-shot run downloaded without a yes)', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'shared', 'project-workspace', 'SKILL.md'), 'utf8');
  assert.match(skill, /Never decide for the person/);
  assert.match(skill, /do not pick the default\s+folder or download anyway/);
  assert.match(skill, /No text beside a tool call/);
});

test('a clone git refuses with 403 says the token lacks Code (Read)', async () => {
  const sb = sandbox();
  const bin = path.join(sb.root, 'fakebin');
  fs.mkdirSync(bin);
  const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = clone ]; then echo "fatal: unable to access 'https://dev.azure.com/Org/Proj/_git/R/': The requested URL returned error: 403" >&2; exit 128; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  sb.env.PATH = `${bin}${path.delimiter}${sb.env.PATH || process.env.PATH}`;
  await sb.run('setup', '--reference-root', path.join(sb.root, 'ref'));
  const out = await sb.run('ensure', 'https://dev.azure.com/Org/Proj/_git/R', '--approved');
  assert.match(out.error, /the token can sign in but is not allowed to read this repository: create a new PAT with Code \(Read\)/);
});
