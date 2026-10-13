'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(__dirname, '..', 'skills/shared/ado-board/scripts');
const FIX = path.join(__dirname, 'fixtures/ado-board');
const json = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));
const L = require(path.join(DIR, 'board-logic.js'));
const board = require(path.join(DIR, 'board.js'));

const MAP = json('map.json');
const NOW = '2026-10-12T12:00:00Z';
const daysAgo = (n) => new Date(Date.parse(NOW) - n * 86400000).toISOString();
const item = (id, type, state, extra = {}) => ({ id, type, state, tags: '', title: `item ${id}`, stateChangeDate: daysAgo(1), ...extra });
const items = (...xs) => Object.fromEntries(xs.map((x) => [x.id, x]));

// --- states discover -------------------------------------------------------------------

test('mapType: categories map onto buckets; Resolved is verify; Removed is no target', () => {
  const t = L.mapType('Bug', json('states-bug-agile.json').value);
  assert.deepEqual(t.targets, { todo: 'New', doing: 'Active', verify: 'Resolved', done: 'Closed' });
  assert.equal(t.states.Resolved, 'verify');
  assert.equal(t.states.Removed, 'removed');
  assert.deepEqual(t.ambiguous, []);
});

test('mapType: a category holding two states asks once; a valid choice settles it', () => {
  const states = json('states-pbi-scrum.json').value;
  const open = L.mapType('Product Backlog Item', states);
  assert.deepEqual(open.ambiguous, [{ type: 'Product Backlog Item', bucket: 'todo', states: ['New', 'Approved'] }]);
  assert.equal(open.targets.todo, undefined);
  const chosen = L.mapType('Product Backlog Item', states, L.parseChoices('Product Backlog Item:todo=Approved'));
  assert.deepEqual(chosen.ambiguous, []);
  assert.equal(chosen.targets.todo, 'Approved');
  assert.equal(L.mapType('Product Backlog Item', states, { 'Product Backlog Item:todo': 'Bogus' }).ambiguous.length, 1);
});

test('parseChoices: several choices separated by ;', () => {
  assert.deepEqual(L.parseChoices('Bug:todo=New; User Story:doing = Active;junk'), { 'Bug:todo': 'New', 'User Story:doing': 'Active' });
});

test('buildMap: holds organization, project and states — never a credential or its path', () => {
  const { map, ambiguous } = L.buildMap({
    organization: 'https://dev.azure.com/acme', project: 'Orion', now: NOW,
    types: { Bug: json('states-bug-agile.json').value, 'Product Backlog Item': json('states-pbi-scrum.json').value },
  });
  assert.equal(ambiguous.length, 1);
  assert.equal(map.version, 1);
  assert.deepEqual(Object.keys(map.types), ['Bug', 'Product Backlog Item']);
  assert.doesNotMatch(JSON.stringify(map), /pat|token|ado-credentials|password/i);
});

test('boardTypes: drops disabled and non-board types', () => {
  assert.deepEqual(L.boardTypes(json('workitemtypes.json').value), ['Bug', 'Product Backlog Item']);
});

// --- move ------------------------------------------------------------------------------

test('checkMove: forward is allowed and names the target state', () => {
  const d = L.checkMove({ map: MAP, item: item(1, 'User Story', 'New'), bucket: 'doing' });
  assert.equal(d.ok, true);
  assert.equal(d.toState, 'Active');
});

test('checkMove: forward only — same bucket is a no-op, backwards is refused', () => {
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Bug', 'Active'), bucket: 'doing' }).code, 'same');
  const back = L.checkMove({ map: MAP, item: item(1, 'Bug', 'Resolved'), bucket: 'doing' });
  assert.equal(back.ok, false);
  assert.equal(back.code, 'backwards');
});

test('checkMove: Removed is never touched; idp: cards only with allowIdp', () => {
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Bug', 'Removed'), bucket: 'done' }).code, 'removed');
  const idp = item(2, 'User Story', 'New', { tags: 'frontend; IDP:phase-build' });
  assert.equal(L.checkMove({ map: MAP, item: idp, bucket: 'doing' }).code, 'idp');
  assert.equal(L.checkMove({ map: MAP, item: idp, bucket: 'doing', allowIdp: true }).ok, true);
});

test('checkMove: unknown type, unknown state, missing target, bad bucket', () => {
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Epic', 'New'), bucket: 'doing' }).code, 'unknown-type');
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Bug', 'Triaged'), bucket: 'doing' }).code, 'unknown-state');
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Task', 'In Progress'), bucket: 'verify' }).code, 'no-target');
  assert.equal(L.checkMove({ map: MAP, item: item(1, 'Task', 'To Do'), bucket: 'closed' }).code, 'bad-bucket');
});

test('movePatch: revision test first, then state and evidence comment in one json-patch', () => {
  assert.deepEqual(L.movePatch(7, 'Active', 'branch x'), [
    { op: 'test', path: '/rev', value: 7 },
    { op: 'add', path: '/fields/System.State', value: 'Active' },
    { op: 'add', path: '/fields/System.History', value: 'branch x' },
  ]);
});

test('requiredFieldFromError: names the field; other errors give null', () => {
  assert.deepEqual(L.requiredFieldFromError(json('rule-error-required.json')), { field: 'Microsoft.VSTS.Common.ResolvedReason', name: 'Resolved Reason' });
  assert.deepEqual(L.requiredFieldFromError({ message: 'TF401320: Rule Error for field Severity. Error code: Required, InvalidEmpty.' }), { field: null, name: 'Severity' });
  assert.equal(L.requiredFieldFromError({ message: 'TF401347: Invalid tree name given for work item -1, field System.AreaPath.' }), null);
  assert.equal(L.requiredFieldFromError('oops'), null);
});

// --- git and PR facts ------------------------------------------------------------------

test('branchWorkItemId / titleWorkItemIds', () => {
  assert.equal(L.branchWorkItemId('refs/heads/feature/ADO-123-add-export'), 123);
  assert.equal(L.branchWorkItemId('bug/ado-77-crash'), 77);
  assert.equal(L.branchWorkItemId('feature/ADO-123'), 123);
  assert.equal(L.branchWorkItemId('feature/ADO-123x'), null);
  assert.equal(L.branchWorkItemId('hotfix/ADO-1-x'), null);
  assert.equal(L.branchWorkItemId('main'), null);
  assert.deepEqual(L.titleWorkItemIds('feat(123): add export'), [123]);
  assert.deepEqual(L.titleWorkItemIds('fix(5, 6): two'), [5, 6]);
  assert.deepEqual(L.titleWorkItemIds('chore: bump'), []);
});

test('parseRemoteUrl: https, visualstudio.com and ssh forms', () => {
  const want = { org: 'https://dev.azure.com/acme', project: 'Orion Space', repo: 'api' };
  assert.deepEqual(L.parseRemoteUrl('https://acme@dev.azure.com/acme/Orion%20Space/_git/api'), want);
  assert.deepEqual(L.parseRemoteUrl('https://acme.visualstudio.com/DefaultCollection/Orion%20Space/_git/api'), want);
  assert.deepEqual(L.parseRemoteUrl('git@ssh.dev.azure.com:v3/acme/Orion%20Space/api'), want);
  assert.equal(L.parseRemoteUrl('git@github.com:acme/api.git'), null);
});

// --- reconcile planner -----------------------------------------------------------------

const pr = (id, extra = {}) => ({ id, title: `PR ${id}`, sourceRefName: 'refs/heads/topic', closedDate: daysAgo(1), workItemIds: [], transitionWorkItems: false, ...extra });

test('reconcile: a pushed branch moves a todo item to doing', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    branches: [{ name: 'refs/heads/feature/ADO-10-x', ahead: 2, date: daysAgo(0), commit: 'abcdef1234' }],
    items: items(item(10, 'User Story', 'New')),
  });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to, m.toState]), [[10, 'doing', 'Active']]);
  assert.match(plan.moves[0].evidence, /feature\/ADO-10-x has 2 pushed commit\(s\) \(abcdef1\)/);
});

test('reconcile: a branch with no pushed commits moves nothing', () => {
  const plan = L.planReconcile({ map: MAP, now: NOW, branches: [{ name: 'feature/ADO-10-x', ahead: 0, date: daysAgo(0) }], items: items(item(10, 'User Story', 'New')) });
  assert.deepEqual(plan.moves, []);
});

test('reconcile: a completed PR moves its linked item to done', () => {
  const plan = L.planReconcile({ map: MAP, now: NOW, prs: [pr(7, { workItemIds: [20] })], items: items(item(20, 'User Story', 'Active')) });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to, m.toState, m.source]), [[20, 'done', 'Closed', 'pr']]);
});

test('reconcile: a completed PR moves a Bug to verify, not done', () => {
  const plan = L.planReconcile({ map: MAP, now: NOW, prs: [pr(8, { workItemIds: [30] })], items: items(item(30, 'Bug', 'Active')) });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to, m.toState]), [[30, 'verify', 'Resolved']]);
});

test('reconcile: a Bug whose type has no verify state goes to done', () => {
  const map = JSON.parse(JSON.stringify(MAP));
  delete map.types.Bug.targets.verify;
  const plan = L.planReconcile({ map, now: NOW, prs: [pr(8, { workItemIds: [30] })], items: items(item(30, 'Bug', 'Active')) });
  assert.equal(plan.moves[0].to, 'done');
});

test('reconcile: ids also come from the PR title and source branch', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    prs: [pr(9, { title: 'feat(40): x', sourceRefName: 'refs/heads/feature/ADO-41-y' })],
    items: items(item(40, 'User Story', 'Active'), item(41, 'Task', 'In Progress')),
  });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.toState]), [[40, 'Closed'], [41, 'Done']]);
});

test('reconcile: never moves a card carrying an idp: tag', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    branches: [{ name: 'feature/ADO-50-x', ahead: 1, date: daysAgo(0) }],
    prs: [pr(10, { workItemIds: [51] })],
    items: items(item(50, 'User Story', 'New', { tags: 'idp:phase-build' }), item(51, 'Bug', 'Active', { tags: 'ui; idp:claimed' })),
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.skipped.map((s) => [s.id, s.code]), [[50, 'idp'], [51, 'idp']]);
});

test('reconcile: never moves backwards and never touches Removed', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    branches: [{ name: 'feature/ADO-60-x', ahead: 3, date: daysAgo(0) }, { name: 'bug/ADO-61-y', ahead: 1, date: daysAgo(0) }],
    items: items(item(60, 'User Story', 'Closed'), item(61, 'Bug', 'Removed')),
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.observed.map((o) => o.id), [60]);
  assert.deepEqual(plan.skipped.map((s) => [s.id, s.code]), [[61, 'removed']]);
});

test('reconcile: when the server already moved the item, it observes and does nothing', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    prs: [pr(11, { workItemIds: [70, 71], transitionWorkItems: true, closedDate: daysAgo(2) })],
    items: items(item(70, 'User Story', 'Closed'), item(71, 'Bug', 'Resolved')),
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.observed.map((o) => o.id), [70, 71]);
});

test('reconcile: a PR completed inside the grace window with server transition on is left to the server', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW, graceMinutes: 10,
    branches: [{ name: 'feature/ADO-80-x', ahead: 1, date: daysAgo(0) }],
    prs: [pr(12, { workItemIds: [80], transitionWorkItems: true, closedDate: new Date(Date.parse(NOW) - 60000).toISOString() })],
    items: items(item(80, 'User Story', 'New')),
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.waiting.map((w) => w.id), [80]);
});

test('reconcile: the highest claim wins — branch and PR on one todo item go straight to done', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW,
    branches: [{ name: 'feature/ADO-90-x', ahead: 1, date: daysAgo(0) }],
    prs: [pr(13, { workItemIds: [90] })],
    items: items(item(90, 'User Story', 'New')),
  });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to]), [[90, 'done']]);
});

test('reconcile: idempotent — applying the plan and planning again moves nothing', () => {
  const input = {
    map: MAP, now: NOW,
    branches: [{ name: 'feature/ADO-10-x', ahead: 2, date: daysAgo(0) }],
    prs: [pr(7, { workItemIds: [20, 30] })],
    items: items(item(10, 'User Story', 'New'), item(20, 'User Story', 'Active'), item(30, 'Bug', 'Active')),
  };
  const first = L.planReconcile(input);
  assert.equal(first.moves.length, 3);
  const after = JSON.parse(JSON.stringify(input.items));
  for (const m of first.moves) after[m.id].state = m.toState;
  const second = L.planReconcile({ ...input, items: after });
  assert.deepEqual(second.moves, []);
  assert.equal(second.observed.length, 3);
});

test('reconcile: missing item is skipped', () => {
  const plan = L.planReconcile({ map: MAP, now: NOW, branches: [{ name: 'feature/ADO-99-x', ahead: 1, date: daysAgo(0) }], items: {} });
  assert.deepEqual(plan.skipped.map((s) => [s.id, s.code]), [[99, 'not-found']]);
});

test('reconcile reports: doing with no pushed commit for N days; pushed work naming no item', () => {
  const plan = L.planReconcile({
    map: MAP, now: NOW, staleDays: 5, defaultBranch: 'main',
    branches: [
      { name: 'refs/heads/feature/ADO-101-x', ahead: 1, date: daysAgo(9) },
      { name: 'refs/heads/feature/ADO-102-y', ahead: 1, date: daysAgo(1) },
      { name: 'refs/heads/spike-cache', ahead: 4, date: daysAgo(2) },
      { name: 'refs/heads/main', ahead: 0, date: daysAgo(0) },
    ],
    items: items(
      item(101, 'User Story', 'Active', { stateChangeDate: daysAgo(10) }),
      item(102, 'User Story', 'Active', { stateChangeDate: daysAgo(10) }),
      item(103, 'Task', 'In Progress', { stateChangeDate: daysAgo(30) }),
      item(104, 'Task', 'In Progress', { stateChangeDate: daysAgo(2) }),
      item(105, 'Task', 'In Progress', { stateChangeDate: daysAgo(30), tags: 'idp:run' }),
    ),
  });
  assert.deepEqual(plan.reports.staleDoing.map((s) => s.id), [101, 103]);
  assert.deepEqual(plan.reports.unlinkedBranches, [{ branch: 'spike-cache', ahead: 4, date: daysAgo(2) }]);
});

// --- testing states: a completed PR is not tested work ---------------------------------

const TESTING_CHOICES = 'Bug:todo=New;Bug:testing=Ready for Testing;Task:testing=Ready for Testing';
function testingMap() {
  const { map, ambiguous } = L.buildMap({
    organization: MAP.organization, project: MAP.project, now: NOW,
    types: { Bug: json('states-bug-testing.json').value, Task: json('states-task-testing.json').value, 'User Story': json('states-bug-agile.json').value },
    choices: L.parseChoices(TESTING_CHOICES),
  });
  assert.deepEqual(ambiguous, []);
  return map;
}

test('mapType: states named for testing or acceptance form a testing bucket the person chooses', () => {
  const states = json('states-bug-testing.json').value;
  const open = L.mapType('Bug', states, { 'Bug:todo': 'New' });
  assert.deepEqual(open.ambiguous, [{ type: 'Bug', bucket: 'testing', states: ['Ready for Testing', 'In Testing', 'Ready for Acceptance'] }]);
  assert.equal(open.targets.doing, 'Committed');
  assert.equal(open.targets.verify, undefined);
  const t = testingMap().types.Bug;
  assert.equal(t.targets.testing, 'Ready for Testing');
  assert.equal(t.targets.done, 'Done');
  assert.equal(t.states['Ready for Acceptance'], 'testing');
  assert.equal(L.mapType('Bug', json('states-bug-agile.json').value).states.Resolved, 'verify');
});

test('reconcile: items already in a testing state stay there — Task 101535, Bugs 103768 and 103826', () => {
  const plan = L.planReconcile({
    map: testingMap(), now: NOW,
    prs: [pr(201, { workItemIds: [101535] }), pr(202, { workItemIds: [103768] }), pr(203, { title: 'fix(103826): x' })],
    items: items(item(101535, 'Task', 'Ready for Testing'), item(103768, 'Bug', 'Ready for Testing'), item(103826, 'Bug', 'In Testing')),
  });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual(plan.observed.map((o) => [o.id, o.bucket]), [[101535, 'testing'], [103768, 'testing'], [103826, 'testing']]);
  assert.match(plan.observed[0].reason, /a person moves it on/);
});

test('reconcile: a completed PR moves work before testing to the first testing state, never to done', () => {
  const plan = L.planReconcile({
    map: testingMap(), now: NOW,
    branches: [{ name: 'feature/ADO-301-x', ahead: 1, date: daysAgo(0) }],
    prs: [pr(204, { workItemIds: [300, 301, 302] })],
    items: items(item(300, 'Bug', 'Committed'), item(301, 'Task', 'To Do'), item(302, 'Bug', 'Ready for Acceptance')),
  });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to, m.toState, m.source]), [[300, 'testing', 'Ready for Testing', 'pr'], [301, 'testing', 'Ready for Testing', 'pr']]);
  assert.deepEqual(plan.observed.map((o) => o.id), [302]);
  assert.match(plan.moves[0].evidence, /PR 204/);
});

test('reconcile: a type without testing states still goes to done; a person may still move done', () => {
  const map = testingMap();
  const plan = L.planReconcile({ map, now: NOW, prs: [pr(205, { workItemIds: [400] })], items: items(item(400, 'User Story', 'Active')) });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to, m.toState]), [[400, 'done', 'Closed']]);
  const d = L.checkMove({ map, item: item(101535, 'Task', 'Ready for Testing'), bucket: 'done' });
  assert.equal(d.ok, true);
  assert.equal(d.toState, 'Done');
  assert.equal(L.checkMove({ map, item: item(101535, 'Task', 'In Testing'), bucket: 'doing' }).code, 'backwards');
});

test('reconcile: an old map without testing never closes a testing-looking item on a PR', () => {
  const old = JSON.parse(JSON.stringify(MAP));
  old.types.Bug = {
    states: { New: 'todo', Approved: 'todo', Committed: 'doing', 'Ready for Testing': 'doing', 'In Testing': 'doing', 'Ready for Acceptance': 'verify', Done: 'done', Removed: 'removed' },
    targets: { todo: 'New', doing: 'Committed', verify: 'Ready for Acceptance', done: 'Done' },
  };
  const plan = L.planReconcile({
    map: old, now: NOW,
    branches: [{ name: 'bug/ADO-502-x', ahead: 1, date: daysAgo(0) }],
    prs: [pr(206, { workItemIds: [103768, 501, 41] })],
    items: items(item(103768, 'Bug', 'Ready for Testing'), item(501, 'Bug', 'Committed'), item(502, 'Bug', 'New'), item(41, 'Task', 'In Progress')),
  });
  assert.deepEqual(plan.moves.map((m) => [m.id, m.to]), [[41, 'done'], [502, 'doing']]);
  assert.deepEqual(plan.skipped.map((s) => [s.id, s.code]), [[501, 'stale-map'], [103768, 'stale-map']]);
  assert.match(plan.skipped[0].reason, /run states discover/);
});

test('states discover: testing states reach the map once the person chose the target', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const { deps } = fakeDeps({ home, routes: [{ method: 'GET', match: /workitemtypes\/Bug\/states/, body: json('states-bug-testing.json') }] });
  const ask = await board.cmdDiscover({ _: [], types: 'Bug', choose: 'Bug:todo=New' }, deps);
  assert.equal(ask.code, 2);
  assert.match(ask.out.next, /Bug:testing=Ready for Testing/);
  const done = await board.cmdDiscover({ _: [], types: 'Bug', choose: 'Bug:todo=New;Bug:testing=Ready for Testing' }, deps);
  assert.equal(done.code, 0, JSON.stringify(done.out));
  assert.equal(done.out.types.Bug.testing, 'Ready for Testing');
});

// --- nudge -----------------------------------------------------------------------------

test('isDue and nudgeLine', () => {
  const now = Date.parse(NOW);
  assert.equal(L.isDue({}, 'k', now, 24), true);
  assert.equal(L.isDue({ k: { lastChecked: daysAgo(0.5) } }, 'k', now, 24), false);
  assert.equal(L.isDue({ k: { lastChecked: daysAgo(2) } }, 'k', now, 24), true);
  assert.equal(L.nudgeLine([], 5), '');
  assert.match(L.nudgeLine([{ id: 1 }, { id: 2 }], 5), /^2 items have not moved: #1, #2 \(doing, no pushed commit for 5 days\)/);
  assert.match(L.nudgeLine([{ id: 1 }], 5), /^1 item has not moved/);
});

// --- I/O wiring, with a fake fetch and a fake git --------------------------------------

function fakeDeps({ routes, git = {}, home }) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, contentType: init.headers['Content-Type'] });
    const route = routes.find((r) => r.method === init.method && r.match.test(url));
    if (!route) return { ok: false, status: 404, text: async () => '{}', headers: { get: () => 'application/json' } };
    // `replies` answers in order, the last one repeating; `body` may be a function of the URL.
    const reply = route.replies ? (route.replies.length > 1 ? route.replies.shift() : route.replies[0]) : route;
    const body = typeof reply.body === 'function' ? reply.body(new URL(url)) : reply.body;
    return { ok: (reply.status || 200) < 400, status: reply.status || 200, text: async () => JSON.stringify(body), headers: { get: () => 'application/json' } };
  };
  const gitAnswers = { 'rev-parse --show-toplevel': '/repo', 'remote get-url origin': 'https://dev.azure.com/acme/Orion/_git/api', 'rev-parse --abbrev-ref HEAD': 'feature/ADO-10-x', 'rev-parse HEAD': 'abcdef1234567', ...git };
  return {
    calls,
    deps: {
      fetch, now: () => NOW, home,
      env: { ENGCAT_HOME: home, AZURE_DEVOPS_EXT_PAT: 'x' },
      runAz: () => { throw new Error('no az'); },
      git: (args) => { const v = gitAnswers[args.join(' ')]; if (v === undefined) throw new Error('no'); return v; },
    },
  };
}

function homeWithMap() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const file = board.mapPaths({ org: MAP.organization, project: MAP.project }, { ENGCAT_HOME: home }).home;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(MAP));
  return home;
}

const wi = (id, type, state, tags = '', rev = 1) => ({ id, rev, fields: { 'System.WorkItemType': type, 'System.State': state, 'System.Tags': tags, 'System.Title': `t${id}` } });

test('map lives under ENGCAT_HOME/.engineering-catalog/ado-board, outside the repository', () => {
  const p = board.mapPaths({ org: 'https://dev.azure.com/acme', project: 'Orion Space' }, { ENGCAT_HOME: '/h' }, '/repo');
  assert.equal(p.home, path.join('/h', '.engineering-catalog', 'ado-board', 'dev.azure.com-acme', 'orion-space.json'));
  assert.equal(p.repo, path.join('/repo', '.engineering-catalog', 'ado-board.json'));
});

test('states discover: asks when ambiguous, writes the map once chosen', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const routes = [
    { method: 'GET', match: /workitemtypes\/Bug\/states/, body: json('states-bug-agile.json') },
    { method: 'GET', match: /workitemtypes\/Product%20Backlog%20Item\/states/, body: json('states-pbi-scrum.json') },
    { method: 'GET', match: /workitemtypes\?/, body: json('workitemtypes.json') },
  ];
  const { deps } = fakeDeps({ routes, home });
  const ask = await board.cmdDiscover({ _: [] }, deps);
  assert.equal(ask.code, 2);
  assert.equal(ask.out.outcome, 'needs-choice');
  const done = await board.cmdDiscover({ _: [], choose: 'Product Backlog Item:todo=New' }, deps);
  assert.equal(done.code, 0);
  assert.ok(done.out.path.startsWith(home));
  const saved = JSON.parse(fs.readFileSync(done.out.path, 'utf8'));
  assert.equal(saved.types['Product Backlog Item'].targets.todo, 'New');
  assert.doesNotMatch(JSON.stringify(saved), /AZURE_DEVOPS_EXT_PAT|\bx\b/);
});

test('states discover: legacy map upgrades to the current version; current map is kept', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const file = board.mapPaths({ org: MAP.organization, project: MAP.project }, { ENGCAT_HOME: home }).home;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const legacy = { organization: MAP.organization, project: MAP.project, discovered: '2026-01-01T00:00:00Z', types: MAP.types };
  fs.writeFileSync(file, JSON.stringify(legacy, null, 2) + '\n');
  const routes = [
    { method: 'GET', match: /workitemtypes\/Bug\/states/, body: json('states-bug-agile.json') },
    { method: 'GET', match: /workitemtypes\/Product%20Backlog%20Item\/states/, body: json('states-pbi-scrum.json') },
    { method: 'GET', match: /workitemtypes\?/, body: json('workitemtypes.json') },
  ];
  const { deps } = fakeDeps({ routes, home });
  const upgraded = await board.cmdDiscover({ _: [], choose: 'Product Backlog Item:todo=New' }, deps);
  assert.equal(upgraded.out.outcome, 'written');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, L.MAP_VERSION);
  const kept = await board.cmdDiscover({ _: [], choose: 'Product Backlog Item:todo=New' }, deps);
  assert.deepEqual([kept.code, kept.out.outcome, kept.out.path], [0, 'kept', file]);
  assert.ok(kept.out.stateMap.Bug, 'a kept map still answers with its stateMap');
});

// chmod cannot make a directory read-only for root (the self-hosted CI agent runs as root).
test('states discover: a write failure leaves the legacy map in place', { skip: process.platform === 'win32' || process.getuid() === 0 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const file = board.mapPaths({ org: MAP.organization, project: MAP.project }, { ENGCAT_HOME: home }).home;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ organization: MAP.organization, project: MAP.project, types: MAP.types }, null, 2) + '\n');
  fs.chmodSync(path.dirname(file), 0o555);
  try {
    const routes = [
      { method: 'GET', match: /workitemtypes\/Bug\/states/, body: json('states-bug-agile.json') },
      { method: 'GET', match: /workitemtypes\/Product%20Backlog%20Item\/states/, body: json('states-pbi-scrum.json') },
      { method: 'GET', match: /workitemtypes\?/, body: json('workitemtypes.json') },
    ];
    const { deps } = fakeDeps({ routes, home });
    await assert.rejects(() => board.cmdDiscover({ _: [], choose: 'Product Backlog Item:todo=New' }, deps));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, undefined);
  } finally {
    fs.chmodSync(path.dirname(file), 0o755);
  }
});

test('move: a transition refused for a required field stops and names the field', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/30\?/, body: wi(30, 'Bug', 'Active') },
    { method: 'PATCH', match: /workitems\/30\?/, status: 400, body: json('rule-error-required.json') },
  ] });
  const r = await board.cmdMove({ _: ['move', '30', 'verify'], comment: 'PR 12 completed' }, deps);
  assert.equal(r.code, 2);
  assert.equal(r.out.outcome, 'field-required');
  assert.equal(r.out.field, 'Microsoft.VSTS.Common.ResolvedReason');
  assert.match(r.out.detail, /Resolved Reason/);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.equal(patch.contentType, 'application/json-patch+json');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 1);
  assert.match(JSON.parse(patch.body).find((o) => o.path === '/fields/System.History').value, /Evidence: PR 12 completed/);
});

test('move: backwards is refused without a PATCH; idp needs --idp', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/31\?/, body: wi(31, 'Bug', 'Closed') },
    { method: 'GET', match: /workitems\/32\?/, body: wi(32, 'User Story', 'New', 'idp:run') },
    { method: 'PATCH', match: /workitems\/32\?/, body: {} },
  ] });
  const back = await board.cmdMove({ _: ['move', '31', 'doing'] }, deps);
  assert.equal(back.code, 3);
  assert.equal(back.out.code, 'backwards');
  assert.equal((await board.cmdMove({ _: ['move', '32', 'doing'] }, deps)).out.code, 'idp');
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  const ok = await board.cmdMove({ _: ['move', '32', 'doing'], idp: true }, deps);
  assert.equal(ok.out.outcome, 'moved');
});

function reconcileRoutes(itemsBody = { value: [wi(10, 'User Story', 'New'), wi(20, 'Task', 'In Progress'), wi(30, 'Bug', 'Active')] }) {
  return [
    { method: 'GET', match: /_git|git\/repositories\/api\?/, body: { id: 'r1', defaultBranch: 'refs/heads/main' } },
    { method: 'GET', match: /repositories\/r1\/stats\/branches/, body: { value: [
      { name: 'feature/ADO-10-x', aheadCount: 2, commit: { commitId: 'abc1234', committer: { date: daysAgo(0) } } },
      { name: 'main', aheadCount: 0, commit: { commitId: 'fff', committer: { date: daysAgo(0) } } },
    ] } },
    { method: 'GET', match: /repositories\/r1\/pullrequests\?/, body: { value: [
      { pullRequestId: 5, title: 'fix(30): crash', sourceRefName: 'refs/heads/bug/ADO-30-crash', closedDate: daysAgo(1), completionOptions: { transitionWorkItems: false } },
    ] } },
    { method: 'GET', match: /pullRequests\/5\/workitems/, body: { value: [{ id: '30' }] } },
    { method: 'POST', match: /_apis\/wit\/wiql/, body: { workItems: [{ id: 20 }] } },
    { method: 'GET', match: /_apis\/wit\/workitems\?/, body: itemsBody },
    { method: 'PATCH', match: /workitems\/\d+\?/, body: {} },
  ];
}

test('reconcile --dry-run: reads the PR API and the board, prints the plan, writes nothing', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: reconcileRoutes() });
  const r = await board.cmdReconcile({ _: ['reconcile'], 'dry-run': true }, deps);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.moves.map((m) => [m.id, m.toState]), [[10, 'Active'], [30, 'Resolved']]);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('reconcile: applies each move with an evidence comment', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: reconcileRoutes() });
  const r = await board.cmdReconcile({ _: ['reconcile'] }, deps);
  assert.equal(r.code, 0);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2);
  assert.match(JSON.parse(patches[1].body).find((o) => o.path === '/fields/System.History').value, /PR 5 "fix\(30\): crash" completed/);
});

test('nudge: silent with no map, then at most once per N hours', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  assert.equal((await board.cmdNudge({ _: [] }, fakeDeps({ home: empty, routes: [] }).deps)).out, null);
  const home = homeWithMap();
  const routes = reconcileRoutes({ value: [{ id: 20, fields: { 'System.WorkItemType': 'Task', 'System.State': 'In Progress', 'Microsoft.VSTS.Common.StateChangeDate': daysAgo(20) } }] });
  const { deps } = fakeDeps({ home, routes });
  const first = await board.cmdNudge({ _: [] }, deps);
  assert.match(first.out, /^1 item has not moved: #20/);
  assert.equal((await board.cmdNudge({ _: [] }, deps)).out, null);
});

// --- states discover merges into the existing map ---------------------------------------

const discoverRoutes = () => [
  { method: 'GET', match: /workitemtypes\/Bug\/states/, body: json('states-bug-agile.json') },
  { method: 'GET', match: /workitemtypes\/Product%20Backlog%20Item\/states/, body: json('states-pbi-scrum.json') },
  { method: 'GET', match: /workitemtypes\?/, body: json('workitemtypes.json') },
];

function homeWithFile(map) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const file = board.mapPaths({ org: MAP.organization, project: MAP.project }, { ENGCAT_HOME: home }).home;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
  return { home, file };
}

test('states discover: reuses the earlier choice, keeps types not rediscovered and unknown fields', async () => {
  const pbi = L.mapType('Product Backlog Item', json('states-pbi-scrum.json').value, { 'Product Backlog Item:todo': 'Approved' });
  const { home, file } = homeWithFile({
    ...MAP, team: 'keep me',
    types: { ...MAP.types, 'Product Backlog Item': { states: pbi.states, targets: pbi.targets, note: 'keep me too' } },
  });
  const { deps } = fakeDeps({ routes: discoverRoutes(), home });
  const r = await board.cmdDiscover({ _: [], types: 'Product Backlog Item' }, deps);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.outcome, 'kept');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.types['Product Backlog Item'].targets.todo, 'Approved');
  assert.deepEqual(Object.keys(saved.types).sort(), ['Bug', 'Product Backlog Item', 'Task', 'User Story']);
  assert.equal(saved.team, 'keep me');
  assert.equal(saved.types['Product Backlog Item'].note, 'keep me too');
});

test('states discover: --choose overrides an earlier choice; other types and fields survive', async () => {
  const pbi = L.mapType('Product Backlog Item', json('states-pbi-scrum.json').value, { 'Product Backlog Item:todo': 'Approved' });
  const { home, file } = homeWithFile({ ...MAP, team: 'keep me', types: { ...MAP.types, 'Product Backlog Item': { states: pbi.states, targets: pbi.targets } } });
  const { deps } = fakeDeps({ routes: discoverRoutes(), home });
  const r = await board.cmdDiscover({ _: [], types: 'Product Backlog Item', choose: 'Product Backlog Item:todo=New' }, deps);
  assert.equal(r.out.outcome, 'written');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.types['Product Backlog Item'].targets.todo, 'New');
  assert.ok(saved.types['User Story'] && saved.types.Task);
  assert.equal(saved.team, 'keep me');
});

test('states discover: a version bump migrates — unknown fields and other types survive', async () => {
  const { version, ...legacy } = MAP;
  const { home, file } = homeWithFile({ ...legacy, team: 'keep me' });
  const { deps } = fakeDeps({ routes: discoverRoutes(), home });
  const r = await board.cmdDiscover({ _: [], types: 'Bug' }, deps);
  assert.equal(r.out.outcome, 'written');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.version, L.MAP_VERSION);
  assert.equal(saved.team, 'keep me');
  assert.deepEqual(Object.keys(saved.types).sort(), ['Bug', 'Task', 'User Story']);
});

// --- writes carry the revision they were decided on --------------------------------------

const patches = (calls) => calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));

test('move: the PATCH tests /rev from the GET first', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/40\?/, body: wi(40, 'User Story', 'New', '', 7) },
    { method: 'PATCH', match: /workitems\/40\?/, body: {} },
  ] });
  const r = await board.cmdMove({ _: ['move', '40', 'doing'], comment: 'branch x' }, deps);
  assert.equal(r.out.outcome, 'moved');
  assert.deepEqual(patches(calls)[0][0], { op: 'test', path: '/rev', value: 7 });
});

test('move: a revision conflict re-reads and re-plans once, against the fresh revision', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/41\?/, replies: [{ body: wi(41, 'User Story', 'New', '', 3) }, { body: wi(41, 'User Story', 'New', 'frontend', 4) }] },
    { method: 'PATCH', match: /workitems\/41\?/, replies: [{ status: 412, body: { message: 'precondition failed' } }, { body: {} }] },
  ] });
  const r = await board.cmdMove({ _: ['move', '41', 'doing'], comment: 'branch x' }, deps);
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.outcome, 'moved');
  assert.deepEqual(patches(calls).map((p) => p[0].value), [3, 4]);
});

test('move: after a conflict the fresh read is checked again — idp: and backwards refuse', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/42\?/, replies: [{ body: wi(42, 'User Story', 'New', '', 1) }, { body: wi(42, 'User Story', 'New', 'idp:run', 2) }] },
    { method: 'GET', match: /workitems\/43\?/, replies: [{ body: wi(43, 'Bug', 'New', '', 1) }, { body: wi(43, 'Bug', 'Closed', '', 2) }] },
    { method: 'PATCH', match: /workitems\/4[23]\?/, status: 409, body: { message: 'conflict' } },
  ] });
  const idp = await board.cmdMove({ _: ['move', '42', 'doing'], comment: 'branch x' }, deps);
  assert.equal(idp.code, 3);
  assert.equal(idp.out.code, 'idp');
  const back = await board.cmdMove({ _: ['move', '43', 'doing'], comment: 'branch x' }, deps);
  assert.equal(back.code, 3);
  assert.equal(back.out.code, 'backwards');
  assert.equal(patches(calls).length, 2);
});

test('move: a second conflict refuses with a clear message and writes nothing more', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/44\?/, replies: [{ body: wi(44, 'User Story', 'New', '', 1) }, { body: wi(44, 'User Story', 'New', '', 2) }] },
    { method: 'PATCH', match: /workitems\/44\?/, status: 412, body: { message: 'precondition failed' } },
  ] });
  const r = await board.cmdMove({ _: ['move', '44', 'doing'], comment: 'branch x' }, deps);
  assert.equal(r.code, 3);
  assert.equal(r.out.outcome, 'conflict');
  assert.match(r.out.detail, /changed again/);
  assert.equal(patches(calls).length, 2);
});

test('reconcile: each PATCH tests the revision the plan read; a conflict re-plans that item', async () => {
  const home = homeWithMap();
  const routes = reconcileRoutes({ value: [wi(10, 'User Story', 'New', '', 5), wi(20, 'Task', 'In Progress'), wi(30, 'Bug', 'Active', '', 9)] });
  routes.unshift(
    { method: 'GET', match: /workitems\/30\?/, body: wi(30, 'Bug', 'Resolved', '', 10) },
    { method: 'PATCH', match: /workitems\/30\?/, status: 412, body: { message: 'precondition failed' } },
  );
  const { deps, calls } = fakeDeps({ home, routes });
  const r = await board.cmdReconcile({ _: ['reconcile'] }, deps);
  assert.deepEqual(patches(calls).map((p) => p[0]), [{ op: 'test', path: '/rev', value: 5 }, { op: 'test', path: '/rev', value: 9 }]);
  assert.deepEqual(r.out.applied.map((a) => [a.id, a.outcome]), [[10, 'moved'], [30, 'unchanged']]);
  assert.equal(r.code, 0);
});

test('reconcile: a type change between read and write refuses — a Bug is never closed past verify', async () => {
  const home = homeWithMap();
  const routes = reconcileRoutes({ value: [wi(10, 'User Story', 'New', '', 5), wi(20, 'Task', 'In Progress'), wi(30, 'User Story', 'Active', '', 9)] });
  routes.unshift(
    { method: 'GET', match: /workitems\/30\?/, body: wi(30, 'Bug', 'Active', '', 10) },
    { method: 'PATCH', match: /workitems\/30\?/, status: 412, body: { message: 'precondition failed' } },
  );
  const { deps, calls } = fakeDeps({ home, routes });
  const r = await board.cmdReconcile({ _: ['reconcile'] }, deps);
  assert.equal(r.out.moves.find((m) => m.id === 30).to, 'done');
  assert.deepEqual(patches(calls).map((p) => p[0].value), [5, 9]);
  const a = r.out.applied.find((x) => x.id === 30);
  assert.equal(a.outcome, 'refused');
  assert.equal(a.code, 'type-changed');
  assert.match(a.reason, /User Story → Bug/);
  assert.equal(r.code, 3);
});

// --- completed PRs: every page in the interval, or an explicit gap ------------------------

const completedPr = (id, title, closedDate) => ({ pullRequestId: id, title, sourceRefName: `refs/heads/chore-${id}`, closedDate, completionOptions: {} });

test('reconcile: pages through completed PRs inside the interval', async () => {
  const home = homeWithMap();
  const routes = reconcileRoutes();
  const i = routes.findIndex((r) => /pullrequests/.test(String(r.match)));
  routes[i] = { method: 'GET', match: /repositories\/r1\/pullrequests\?/, body: (u) => {
    const skip = Number(u.searchParams.get('$skip') || 0);
    if (skip === 0) return { value: Array.from({ length: 100 }, (_, k) => completedPr(1000 + k, 'chore: tidy', daysAgo(2))) };
    if (skip === 100) return { value: [completedPr(5, 'fix(30): crash', daysAgo(1))] };
    return { value: [] };
  } };
  routes.push({ method: 'GET', match: /pullRequests\/\d+\/workitems/, body: { value: [] } });
  const { deps, calls } = fakeDeps({ home, routes });
  const r = await board.cmdReconcile({ _: ['reconcile'], 'dry-run': true }, deps);
  assert.deepEqual(r.out.moves.map((m) => m.id), [10, 30]);
  assert.equal(r.out.coverage.pullRequests.complete, true);
  assert.equal(r.out.coverage.pullRequests.read, 101);
  const first = new URL(calls.find((c) => /pullrequests\?/.test(c.url)).url);
  assert.equal(first.searchParams.get('searchCriteria.queryTimeRangeType'), 'closed');
  assert.ok(first.searchParams.get('searchCriteria.minTime'));
});

test('reconcile: says so when it could not read every completed PR in the interval', async () => {
  const home = homeWithMap();
  const routes = reconcileRoutes();
  const i = routes.findIndex((r) => /pullrequests/.test(String(r.match)));
  routes[i] = { method: 'GET', match: /repositories\/r1\/pullrequests\?/, body: (u) => {
    const skip = Number(u.searchParams.get('$skip') || 0);
    return { value: Array.from({ length: 100 }, (_, k) => completedPr(skip + k + 1, 'chore: old', daysAgo(90))) };
  } };
  const { deps } = fakeDeps({ home, routes });
  const r = await board.cmdReconcile({ _: ['reconcile'], 'dry-run': true }, deps);
  assert.equal(r.out.coverage.pullRequests.complete, false);
  assert.match(r.out.coverage.pullRequests.warning, /not every completed pull request/i);
});

// --- the platform runner's contract (ai-sdlc-platform scripts/phase3/states.py, docker/calculator/scenario.py)

const { spawnSync } = require('child_process');
const CLI = path.join(DIR, 'ado-board.js');
const scrum = {
  Epic: [{ name: 'New', category: 'Proposed' }, { name: 'In Progress', category: 'InProgress' }, { name: 'Done', category: 'Completed' }, { name: 'Removed', category: 'Removed' }],
  Task: [{ name: 'To Do', category: 'Proposed' }, { name: 'In Progress', category: 'InProgress' }, { name: 'Done', category: 'Completed' }, { name: 'Removed', category: 'Removed' }],
};
scrum.Feature = scrum.Epic;
const scrumRoutes = () => [
  { method: 'GET', match: /workitemtypes\/Product%20Backlog%20Item\/states/, body: json('states-pbi-scrum.json') },
  ...['Epic', 'Feature', 'Task'].map((t) => ({ method: 'GET', match: new RegExp(`workitemtypes/${t}/states`), body: { value: scrum[t] } })),
  { method: 'GET', match: /workitemtypes\?/, body: { value: ['Epic', 'Feature', 'Product Backlog Item', 'Task', 'Test Case'].map((name) => ({ name, isDisabled: false })) } },
];

test('stateMap: todo, doing, verify (the testing state, else Resolved), done per type', () => {
  const map = { types: {
    Bug: { targets: { todo: 'New', doing: 'Active', testing: 'Ready for Testing', verify: 'Resolved', done: 'Closed' } },
    'User Story': { targets: { todo: 'New', doing: 'Active', verify: 'Resolved', done: 'Closed' } },
    Task: { targets: { todo: 'To Do', doing: 'In Progress', done: 'Done' } },
  } };
  assert.deepEqual(L.stateMap(map), {
    Bug: { todo: 'New', doing: 'Active', verify: 'Ready for Testing', done: 'Closed' },
    'User Story': { todo: 'New', doing: 'Active', verify: 'Resolved', done: 'Closed' },
    Task: { todo: 'To Do', doing: 'In Progress', done: 'Done' },
  });
});

test('move verify: the testing state for a type with testing and no Resolved state, else Resolved', () => {
  const map = { types: {
    PBI: { states: { New: 'todo', Committed: 'doing', 'In Testing': 'testing', Done: 'done' }, targets: { todo: 'New', doing: 'Committed', testing: 'In Testing', done: 'Done' } },
    Bug: MAP.types.Bug,
  } };
  const pbi = L.checkMove({ map, item: item(1, 'PBI', 'Committed'), bucket: 'verify' });
  assert.deepEqual([pbi.ok, pbi.to, pbi.toState], [true, 'testing', 'In Testing']);
  const bug = L.checkMove({ map, item: item(2, 'Bug', 'Active'), bucket: 'verify' });
  assert.deepEqual([bug.ok, bug.to, bug.toState], [true, 'verify', 'Resolved']);
});

test('reconcile: an idp: card is a skip with reason idp-owned', () => {
  const plan = L.planReconcile({ map: MAP, now: NOW, branches: [{ name: 'feature/ADO-50-x', ahead: 1, date: daysAgo(0) }], items: items(item(50, 'User Story', 'New', { tags: 'idp:owner' })) });
  assert.deepEqual(plan.moves, []);
  assert.deepEqual([plan.skipped[0].code, plan.skipped[0].reason], ['idp', 'idp-owned']);
});

test('states discover: without --types finds Epic, Feature, the PBI type and Task; answers stateMap and types', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const { deps } = fakeDeps({ routes: scrumRoutes(), home });
  const r = await board.cmdDiscover({ _: [], json: true, 'non-interactive': true, choose: ['Product Backlog Item:todo=New'] }, deps);
  assert.equal(r.code, 0);
  assert.deepEqual(Object.keys(r.out.stateMap).sort(), ['Epic', 'Feature', 'Product Backlog Item', 'Task']);
  assert.deepEqual(r.out.stateMap.Task, { todo: 'To Do', doing: 'In Progress', done: 'Done' });
  assert.equal(r.out.stateMap['Product Backlog Item'].todo, 'New');
  assert.equal(r.out.types.Task.done, 'Done');
});

test('move: --allow-idp moves an idp: card; without it the move is refused, non-zero', async () => {
  const home = homeWithMap();
  const { deps, calls } = fakeDeps({ home, routes: [
    { method: 'GET', match: /workitems\/32\?/, body: wi(32, 'User Story', 'New', 'idp:owner') },
    { method: 'PATCH', match: /workitems\/32\?/, body: {} },
  ] });
  const no = await board.cmdMove({ _: ['move', '32', 'doing'], comment: 'x', json: true }, deps);
  assert.deepEqual([no.code, no.out.outcome, no.out.code], [3, 'refused', 'idp']);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  const ok = await board.cmdMove({ _: ['move', '32', 'doing'], comment: 'x', 'allow-idp': true, json: true }, deps);
  assert.deepEqual([ok.code, ok.out.outcome], [0, 'moved']);
});

// Runs ado-board.js as the runner does — a child process, argv copied from the runner — with
// fetch stubbed by a preload and a scratch git repository; stdout must parse as JSON.
function runCli(argv, { routes, home, cwd }) {
  const stub = path.join(home, 'stub-fetch.js');
  fs.writeFileSync(stub, `'use strict';
const routes = ${JSON.stringify(routes.map((r) => ({ ...r, match: r.match.source })))};
globalThis.fetch = async (url, init) => {
  const r = routes.find((x) => x.method === init.method && new RegExp(x.match).test(url));
  const status = r ? (r.status || 200) : 404;
  const body = JSON.stringify(r ? r.body : {});
  return { ok: status < 400, status, text: async () => body, headers: { get: () => 'application/json' } };
};
`);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ENGCAT_HOME: home, AZURE_DEVOPS_EXT_PAT: 'x' };
  const r = spawnSync(process.execPath, ['--require', stub, CLI, ...argv], { cwd, env, encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, data: JSON.parse(r.stdout) };
}

test('runner contract: the exact argv of states.py and scenario.py, stdout is JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'adoboard-'));
  const cwd = path.join(home, 'repo');
  fs.mkdirSync(cwd);
  const git = (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('remote', 'add', 'origin', 'https://dev.azure.com/acme/Orion/_git/api');

  // scenario.py: states discover --json --non-interactive, one --choose per IDP_ADO_STATE_CHOICES entry.
  const ask = runCli(['states', 'discover', '--json', '--non-interactive'], { routes: scrumRoutes(), home, cwd });
  assert.equal(ask.code, 2);
  assert.equal(ask.data.outcome, 'needs-choice');
  const choices = ['Product Backlog Item:todo=New', 'Epic:todo=New'];
  const discover = runCli(['states', 'discover', '--json', '--non-interactive', ...choices.flatMap((c) => ['--choose', c])], { routes: scrumRoutes(), home, cwd });
  assert.equal(discover.code, 0, discover.stderr);
  assert.equal(discover.data.stateMap['Product Backlog Item'].todo, 'New', 'every --choose counts, not only the last');
  for (const t of ['Feature', 'Product Backlog Item', 'Task']) assert.ok(discover.data.stateMap[t].done, t);

  // states.py CatalogStates.move: move <id> <bucket> --comment TEXT --allow-idp --json
  const moveRoutes = [
    { method: 'GET', match: /workitems\/7\?/, body: wi(7, 'Task', 'To Do', 'idp:owner') },
    { method: 'PATCH', match: /workitems\/7\?/, body: {} },
  ];
  const move = runCli(['move', '7', 'doing', '--comment', 'phase build started', '--allow-idp', '--json'], { routes: moveRoutes, home, cwd });
  assert.equal(move.code, 0, move.stderr);
  assert.deepEqual([move.data.outcome, move.data.to], ['moved', 'In Progress']);

  // states.py Reconciler: reconcile --json; an idp: card is never moved.
  const recent = new Date().toISOString();
  const reconcileRoutes = [
    { method: 'GET', match: /git\/repositories\/api\?/, body: { id: 'r1', defaultBranch: 'refs/heads/main' } },
    { method: 'GET', match: /repositories\/r1\/stats\/branches/, body: { value: [{ name: 'feature/ADO-7-x', aheadCount: 1, commit: { commitId: 'abc1234', committer: { date: recent } } }] } },
    { method: 'GET', match: /repositories\/r1\/pullrequests\?/, body: { value: [] } },
    { method: 'POST', match: /_apis\/wit\/wiql/, body: { workItems: [] } },
    { method: 'GET', match: /_apis\/wit\/workitems\?/, body: { value: [wi(7, 'Task', 'To Do', 'idp:owner')] } },
  ];
  const reconcile = runCli(['reconcile', '--json'], { routes: reconcileRoutes, home, cwd });
  assert.equal(reconcile.code, 0, reconcile.stderr);
  assert.deepEqual(reconcile.data.moves, []);
  assert.deepEqual(reconcile.data.skipped.map((s) => [s.id, s.reason]), [[7, 'idp-owned']]);

  // board.js stays an alias of the same CLI.
  const alias = spawnSync(process.execPath, [path.join(DIR, 'board.js'), 'nope'], { encoding: 'utf8' });
  assert.equal(alias.status, 1);
  assert.match(alias.stderr, /usage: ado-board\.js/);
});
