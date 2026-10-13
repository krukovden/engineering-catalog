'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'skills/shared/ado-backlog-placement/scripts');
const FIX = path.join(__dirname, 'fixtures/ado-backlog-placement');
const json = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const L = require(path.join(DIR, 'placement-logic.js'));
const ado = require(path.join(DIR, 'ado.js'));
const P = require(path.join(DIR, 'placement.js'));

const NOW = '2026-10-12T12:00:00Z';
const ORG = 'https://dev.azure.com/acme';

function homeWith(config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-'));
  if (config) {
    fs.mkdirSync(path.join(home, '.ado-credentials'));
    fs.writeFileSync(path.join(home, '.ado-credentials', 'config.json'), JSON.stringify(config));
  }
  return home;
}

// --- context resolution ------------------------------------------------------------------

const azDefaults = () => 'organization = https://dev.azure.com/fromaz\nproject = AzProject\n';

test('context: the git remote wins over ado-credentials and az defaults', () => {
  const home = homeWith(json('credentials-config.json'));
  const c = ado.resolveContext({}, {}, { home, runAz: azDefaults, fallback: { org: 'https://dev.azure.com/acme', project: 'Vega' } });
  assert.deepEqual([c.org, c.project, c.source.org, c.source.project], [ORG, 'Vega', 'remote', 'remote']);
  // The active credentials context is Orion, so its team does not leak into Vega.
  assert.equal(c.team, null);
  assert.equal(c.source.team, 'project-default');
});

test('context: ado-credentials fills what the remote did not, with its team and area path', () => {
  const home = homeWith(json('credentials-config.json'));
  const c = ado.resolveContext({}, {}, { home, runAz: azDefaults });
  assert.deepEqual([c.org, c.project, c.team, c.areaPath], [ORG, 'Orion', 'Reporting', 'Orion\\Reporting']);
  assert.deepEqual(c.source, { org: 'credentials', project: 'credentials', team: 'credentials' });
});

test('context: az defaults come last; flags beat everything', () => {
  const c = ado.resolveContext({}, {}, { home: homeWith(null), runAz: azDefaults });
  assert.deepEqual([c.org, c.project, c.source.org], ['https://dev.azure.com/fromaz', 'AzProject', 'az']);
  const f = ado.resolveContext({ org: 'https://dev.azure.com/x/', project: 'P', team: 'T' }, {}, { home: homeWith(json('credentials-config.json')), runAz: azDefaults, fallback: { org: ORG, project: 'Orion' } });
  assert.deepEqual([f.org, f.project, f.team, f.source.org], ['https://dev.azure.com/x', 'P', 'T', 'flag']);
});

test('context command: nothing known asks the person to choose (exit 2), and reads no network', () => {
  const deps = { env: {}, home: homeWith(null), runAz: () => { throw new Error('no az'); }, git: () => { throw new Error('no git'); }, fetch: () => assert.fail('network') };
  const r = P.cmdContext({ _: [] }, deps);
  assert.equal(r.code, 2);
  assert.equal(r.out.outcome, 'needs-choice');
});

test('context command: the remote names the repository and the confirmation line', () => {
  const deps = { env: {}, home: homeWith(null), runAz: () => { throw new Error('no az'); }, git: () => 'git@ssh.dev.azure.com:v3/acme/Orion/api', fetch: () => assert.fail('network') };
  const r = P.cmdContext({ _: [] }, deps);
  assert.equal(r.code, 0);
  assert.equal(r.out.repository, 'api');
  assert.match(r.out.ask, /^Working in https:\/\/dev\.azure\.com\/acme \/ Orion \/ default team — right\?$/);
});

// --- scoring -------------------------------------------------------------------------------

const TEXT = 'I need to add CSV export to the report page';
const base = { id: 1, title: 'Unrelated', description: '', iterationPath: 'Orion', changedDate: '2020-01-01T00:00:00Z', relations: [] };
const score = (c, ctx = {}) => L.scoreCandidate({ ...base, ...c }, { queryTokens: L.tokenize(TEXT), nowMs: Date.parse(NOW), ...ctx });
const parts = (s) => Object.fromEntries(s.parts.map((p) => [p.part, p.points]));

test('tokenize: stop words and short words dropped, plurals folded, HTML stripped', () => {
  assert.deepEqual([...L.tokenize(TEXT)], ['csv', 'export', 'report', 'page']);
  assert.deepEqual([...L.tokenize('<div>Exports &amp; reports</div>')], ['export', 'report']);
  assert.ok(L.tokenize('access').has('access'));
});

test('score: title words count double, description words once, never both for one word', () => {
  const s = score({ title: 'Report exports', description: 'export as CSV' });
  assert.deepEqual(parts(s), { title: 4, description: 1 });
  assert.equal(s.fits, true);
});

test('score: each bonus counts on its own', () => {
  const t = { title: 'Report' };
  assert.deepEqual(parts(score({ ...t, iterationPath: 'Orion\\Sprint 41\\Week 1' }, { iterationPath: 'Orion\\Sprint 41' })), { title: 2, iteration: 2 });
  assert.deepEqual(parts(score({ ...t, iterationPath: 'Orion\\Sprint 410' }, { iterationPath: 'Orion\\Sprint 41' })), { title: 2 });
  const rel = [{ rel: 'ArtifactLink', url: 'vstfs:///Git/Ref/p-1%2FRepo-API%2FGBmain' }];
  assert.deepEqual(parts(score({ ...t, relations: rel }, { repoId: 'repo-api' })), { title: 2, repository: 2 });
  assert.deepEqual(parts(score({ ...t, relations: rel }, { repoId: 'other' })), { title: 2 });
  assert.deepEqual(parts(score({ ...t, changedDate: '2026-10-01T00:00:00Z' })), { title: 2, recent: 1 });
  assert.deepEqual(parts(score({ ...t, changedDate: '2026-10-01T00:00:00Z' }, { recentDays: 5 })), { title: 2 });
});

test('rank: bonuses order candidates but never qualify one with no shared word', () => {
  const items = json('features.json').value.map((w) => require(path.join(DIR, 'placement-rest.js')).toItem(w));
  const r = L.rankCandidates(TEXT, items, { iterationPath: 'Orion\\Sprint 41', repoId: 'repo-api', nowMs: Date.parse(NOW) });
  assert.deepEqual(r.ranked.map((x) => x.id), [4120, 4133]);
  assert.deepEqual(parts(r.ranked[0]), { title: 6, description: 1, iteration: 2, repository: 2, recent: 1 });
  assert.equal(L.rankCandidates('rotate the signing keys', items, { nowMs: Date.parse(NOW) }).ranked.length, 0);
});

test('pickItemType: PBI first, then the process equivalent, Task last', () => {
  assert.equal(L.pickItemType(['Bug', 'Task', 'Product Backlog Item', 'Feature']), 'Product Backlog Item');
  assert.equal(L.pickItemType(['Bug', 'User Story', 'Task']), 'User Story');
  assert.equal(L.pickItemType(['Bug', 'Task']), 'Task');
});

// --- duplicates ----------------------------------------------------------------------------

test('duplicates: credible at half the task words and at least two of them', () => {
  const q = L.tokenize(TEXT);
  assert.equal(L.isDuplicate(q, L.tokenize('CSV export')).credible, true);
  assert.equal(L.isDuplicate(q, L.tokenize('Export settings')).credible, false);
  assert.equal(L.isDuplicate(L.tokenize('flaky login'), L.tokenize('login')).credible, false);
  assert.equal(L.isDuplicate(L.tokenize('login'), L.tokenize('login timeout')).credible, true);
  const found = L.findDuplicates(TEXT, [
    { id: 7, type: 'Task', state: 'New', title: 'Export settings', description: '' },
    { id: 9, type: 'Product Backlog Item', state: 'Approved', title: 'Report page: CSV', description: 'export button' },
  ]);
  assert.deepEqual(found.map((x) => x.id), [9]);
});

test('wiqlOpen: open items of the types in the team areas, quotes escaped', () => {
  const w = L.wiqlOpen({ types: ['Feature'], closedStates: ['Done', 'Removed'], areas: [{ value: "Orion\\O'Brien", includeChildren: true }, { value: 'Orion', includeChildren: false }] });
  assert.match(w, /\[System\.WorkItemType\] IN \('Feature'\)/);
  assert.match(w, /\[System\.State\] NOT IN \('Done', 'Removed'\)/);
  assert.match(w, /\(\[System\.AreaPath\] UNDER 'Orion\\O''Brien' OR \[System\.AreaPath\] = 'Orion'\)/);
});

// --- approval hash -------------------------------------------------------------------------

const PARITY = json('publish-parity.json');
const hashOf = (over = {}) => {
  const d = { org: PARITY.organization, project: PARITY.project, type: PARITY.draft.type, parentId: PARITY.draft.parentId, fields: PARITY.draft.fields, ...over };
  return L.draftHash({ ...d, patch: L.buildPatch(d.org, d.fields, d.parentId) });
};

test('hash: binds organization, project, parent, type and every field', () => {
  const h = hashOf();
  assert.match(h, /^[0-9a-f]{16}$/);
  assert.notEqual(hashOf({ org: 'https://dev.azure.com/other' }), h);
  assert.notEqual(hashOf({ project: 'Vega' }), h);
  assert.notEqual(hashOf({ parentId: 4133 }), h);
  assert.notEqual(hashOf({ parentId: null }), h);
  assert.notEqual(hashOf({ type: 'Task' }), h);
  assert.notEqual(hashOf({ fields: { ...PARITY.draft.fields, 'System.Title': 'CSV export on the report page.' } }), h);
  // Project case and a trailing slash on the organization name the same destination.
  assert.equal(hashOf({ org: `${PARITY.organization}/`, project: 'ORION' }), h);
});

// --- publish parity with qa-ado-work-item (spec §5) ---------------------------------------

test('parity: the Node patch and canonical string follow the shared fixture', () => {
  const patch = L.buildPatch(PARITY.organization, PARITY.draft.fields, PARITY.draft.parentId);
  assert.deepEqual(patch, PARITY.patch);
  const c = L.canonical({ org: PARITY.organization, project: PARITY.project, type: PARITY.draft.type, parentId: PARITY.draft.parentId, patch });
  assert.ok(c.startsWith(PARITY.canonicalPrefix), c);
  assert.equal(c.slice(PARITY.canonicalPrefix.length), JSON.stringify(PARITY.patch));
});

test('parity: the PowerShell twin builds the same patch and canonical fields in the same order', () => {
  const ps = fs.readFileSync(path.join(__dirname, '..', 'skills/qa/qa-ado-work-item/scripts/publish-work-item.ps1'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  assert.ok(ps.includes('$canonical = "$($organization.TrimEnd(\'/\').ToLowerInvariant())|$($project.ToLowerInvariant())|$type|$parentId|$patchJson"'));
  assert.match(ps, /\.Substring\(0, 16\)/);
  assert.match(ps, /SHA256/);
  // Fields in draft order, empty values dropped, then the parent relation with the same shape.
  assert.match(ps, /if \(\$null -ne \$property\.Value -and "\$\(\$property\.Value\)" -ne ""\)/);
  assert.match(ps, /rel\s+= "System\.LinkTypes\.Hierarchy-Reverse"/);
  assert.match(ps, /url\s+= "\$\(\$organization\.TrimEnd\('\/'\)\)\/_apis\/wit\/workItems\/\$parentId"/);
  assert.match(ps, /attributes = @\{ comment = "Parent" \}/);
  // Receipt: exclusive, the same three states, 4xx releases it.
  assert.match(ps, /\[IO\.FileMode\]::CreateNew/);
  for (const s of ['in-flight', 'created', 'failed']) assert.ok(ps.includes(`state = "${s}"`), s);
  const codes = /HTTP \(([\d|]+)\)/.exec(ps)[1].split('|').map(Number);
  assert.deepEqual(codes, [400, 401, 403, 404, 422]);
  for (const c of codes) assert.equal(L.isDefinitiveRejection(c), true);
  assert.equal(L.isDefinitiveRejection(500), false);
});

// --- create, end to end with a fake Azure DevOps ------------------------------------------

function fakeAdo({ postStatus = 200, readBackTitle } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
  const fetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const u = new URL(url);
    if (init.method === 'POST' && /_apis\/wit\/workitems\/\$/.test(u.pathname)) return postStatus < 400 ? reply(200, { id: 5001 }) : reply(postStatus, { message: 'nope' });
    if (/workitemtypes\/[^/]+\/fields$/.test(u.pathname)) return reply(200, { value: ['System.Title', 'System.Description', 'System.AreaPath', 'Microsoft.VSTS.Common.AcceptanceCriteria'].map((referenceName) => ({ referenceName })) });
    if (/workitemtypes$/.test(u.pathname)) return reply(200, { value: [{ name: 'Product Backlog Item' }, { name: 'Feature' }, { name: 'Task' }] });
    if (/workitems\/4120$/.test(u.pathname)) return reply(200, { id: 4120, fields: { 'System.TeamProject': 'Orion', 'System.WorkItemType': 'Feature', 'System.Title': 'Report page exports' } });
    if (/workitems\/5001$/.test(u.pathname)) {
      return reply(200, {
        id: 5001,
        fields: { ...PARITY.draft.fields, 'System.Title': readBackTitle || PARITY.draft.fields['System.Title'], 'System.Description': '<div><p>Export what the page shows.</p></div>', 'System.WorkItemType': 'Product Backlog Item', 'System.State': 'New' },
        relations: [{ rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ORG}/_apis/wit/workItems/4120` }],
      });
    }
    return reply(404, {});
  };
  const deps = { fetch, env: { AZURE_DEVOPS_EXT_PAT: 'x' }, home: homeWith(null), now: () => NOW, runAz: () => { throw new Error('no az'); }, git: () => { throw new Error('no git'); } };
  return { calls, deps, posts: () => calls.filter((c) => c.method === 'POST').length };
}

function draftFile(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'placement-draft-'));
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify({ organization: ORG, project: 'Orion', ...PARITY.draft, ...over }, null, 2));
  return file;
}

test('create: preview validates and sends nothing; no approval, no create', async () => {
  const { deps, posts } = fakeAdo();
  const file = draftFile();
  const r = await P.cmdCreate({ _: [], draft: file }, deps);
  assert.equal(r.code, 0);
  assert.equal(r.out.mode, 'PREVIEW');
  assert.equal(r.out.valid, true);
  assert.equal(r.out.parent, 'Feature 4120 - Report page exports');
  assert.match(r.out.draftHash, /^[0-9a-f]{16}$/);
  assert.equal(posts(), 0);
  assert.equal(fs.existsSync(`${file}.receipt.json`), false);
});

test('create: a stale or foreign hash is refused (exit 3) and nothing is sent', async () => {
  const { deps, posts } = fakeAdo();
  const file = draftFile();
  const { out } = await P.cmdCreate({ _: [], draft: file }, deps);
  // The user approved this preview, then the draft was pointed at another parent.
  fs.writeFileSync(file, JSON.stringify({ organization: ORG, project: 'Orion', ...PARITY.draft, parentId: null }));
  const r = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
  assert.equal(r.code, 3);
  assert.equal(posts(), 0);
  assert.equal(fs.existsSync(`${file}.receipt.json`), false);
});

test('create: publishes once with the approved hash; a second run is refused by the receipt', async () => {
  const { deps, posts } = fakeAdo();
  const file = draftFile();
  const { out } = await P.cmdCreate({ _: [], draft: file }, deps);
  const first = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
  assert.equal(first.code, 0, JSON.stringify(first.out));
  assert.equal(first.out.id, 5001);
  assert.equal(first.out.url, `${ORG}/Orion/_workitems/edit/5001`);
  assert.equal(first.out.verification.verdict, 'verified');
  assert.deepEqual(first.out.verification.fields.find((f) => f.field === 'System.Description'), { field: 'System.Description', verdict: 'normalized' });
  const receipt = JSON.parse(fs.readFileSync(`${file}.receipt.json`, 'utf8'));
  assert.equal(receipt.state, 'created');
  assert.doesNotMatch(JSON.stringify(receipt), /AZURE_DEVOPS|pat|token/i);
  const second = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
  assert.equal(second.code, 3);
  assert.equal(second.out.mode, 'ALREADY-PUBLISHED');
  assert.equal(posts(), 1);
});

test('create: the POST carries the patch the preview showed, with the parent link', async () => {
  const { deps, calls } = fakeAdo();
  const file = draftFile({ organization: `${ORG}/` });
  const { out } = await P.cmdCreate({ _: [], draft: file }, deps);
  await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
  const post = calls.find((c) => c.method === 'POST');
  assert.match(post.url, /\/Orion\/_apis\/wit\/workitems\/\$Product%20Backlog%20Item\?/);
  assert.deepEqual(JSON.parse(post.body), out.patch);
  assert.equal(JSON.parse(post.body).at(-1).value.url, `${ORG}/_apis/wit/workItems/4120`);
});

test('create: a definitive 4xx releases the receipt; an ambiguous failure keeps it', async () => {
  for (const [status, kept] of [[400, false], [503, true]]) {
    const { deps } = fakeAdo({ postStatus: status });
    const file = draftFile();
    const { out } = await P.cmdCreate({ _: [], draft: file }, deps);
    const r = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
    assert.equal(r.code, 1);
    assert.equal(fs.existsSync(`${file}.receipt.json`), kept, String(status));
    if (kept) {
      const again = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
      assert.equal(again.code, 3);
      assert.match(again.out.detail, /failed at/);
    }
  }
});

test('create: a read-back that differs exits 5', async () => {
  const { deps } = fakeAdo({ readBackTitle: 'Something else' });
  const file = draftFile();
  const { out } = await P.cmdCreate({ _: [], draft: file }, deps);
  const r = await P.cmdCreate({ _: [], draft: file, approved: out.draftHash }, deps);
  assert.equal(r.code, 5);
  assert.deepEqual(r.out.verification.mismatches, ['System.Title']);
});

test('create: an invalid draft is never sent', async () => {
  const { deps, posts } = fakeAdo();
  const file = draftFile({ fields: { 'System.Title': 'x'.repeat(101), 'Custom.Nope': 'y' } });
  const p = await P.cmdCreate({ _: [], draft: file }, deps);
  assert.equal(p.code, 1);
  assert.deepEqual(p.out.problems.map((x) => x.split(' - ')[0]), ['title-length', 'fields-exist-on-type']);
  const r = await P.cmdCreate({ _: [], draft: file, approved: p.out.draftHash }, deps);
  assert.equal(r.code, 1);
  assert.equal(posts(), 0);
});

test('receipt: exclusive creation — of two claims exactly one wins', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'placement-r-')), 'd.json.receipt.json');
  assert.equal(P.claimReceipt(file, { state: 'in-flight' }), true);
  assert.equal(P.claimReceipt(file, { state: 'in-flight' }), false);
});

// --- candidates, end to end ----------------------------------------------------------------

test('candidates: ranks the fixture features in the team area and suggests the item type', async () => {
  const calls = [];
  const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } });
  const fetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const u = new URL(url);
    if (/\/_apis\/projects\/Orion$/.test(u.pathname)) return reply({ id: 'p-1', defaultTeam: { name: 'Orion Team' } });
    if (/teamfieldvalues$/.test(u.pathname)) return reply({ values: [{ value: 'Orion\\Reporting', includeChildren: true }] });
    if (/teamsettings\/iterations$/.test(u.pathname)) return reply({ value: [{ path: 'Orion\\Sprint 41' }] });
    if (/workitemtypes\/Feature\/states$/.test(u.pathname)) return reply({ value: [{ name: 'New', category: 'Proposed' }, { name: 'Done', category: 'Completed' }, { name: 'Removed', category: 'Removed' }] });
    if (/workitemtypes$/.test(u.pathname)) return reply({ value: [{ name: 'Feature' }, { name: 'Product Backlog Item' }, { name: 'Task' }, { name: 'Old', isDisabled: true }] });
    if (/wiql$/.test(u.pathname)) return reply({ workItems: [{ id: 4120 }, { id: 4133 }, { id: 4150 }] });
    if (/git\/repositories\/api$/.test(u.pathname)) return reply({ id: 'repo-api' });
    if (/wit\/workitems$/.test(u.pathname)) return reply(json('features.json'));
    return { ok: false, status: 404, text: async () => '{}', headers: { get: () => 'application/json' } };
  };
  const deps = { fetch, env: { AZURE_DEVOPS_EXT_PAT: 'x' }, home: homeWith(null), now: () => NOW, runAz: () => { throw new Error('no az'); }, git: () => 'https://dev.azure.com/acme/Orion/_git/api' };
  const r = await P.cmdCandidates({ _: [], text: TEXT }, deps);
  assert.equal(r.code, 0);
  assert.equal(r.out.outcome, 'candidates');
  assert.equal(r.out.team, 'Orion Team');
  assert.equal(r.out.suggestedItemType, 'Product Backlog Item');
  assert.equal(r.out.iterationPath, 'Orion\\Sprint 41');
  assert.deepEqual(r.out.candidates.map((c) => c.id), [4120, 4133]);
  const query = JSON.parse(calls.find((c) => /wiql/.test(c.url)).body).query;
  assert.match(query, /NOT IN \('Done', 'Removed'\)/);
  assert.match(query, /UNDER 'Orion\\Reporting'/);
  assert.equal(calls.filter((c) => c.method !== 'GET' && !/wiql/.test(c.url)).length, 0, 'candidates never writes');
  const none = await P.cmdCandidates({ _: [], text: 'rotate the signing keys' }, deps);
  assert.equal(none.out.outcome, 'none-fits');
});
