'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { execFileSync, spawnSync } = require('child_process');

const {
  chooseState,
  discoverStates,
  moveWorkItem,
  reconcileBoard,
  parseBranchWorkItem,
  parsePullRequestWorkItem,
  requiredFieldName,
  resolveAdoContext,
  loadProjectState,
} = require('../skills/shared/ado-board/scripts/lib');

const SCRIPT = path.join(__dirname, '..', 'skills/shared/ado-board/scripts/ado-board.js');

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
};

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  }).trim();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

class FakeTransport {
  constructor({
    items = {},
    prs = [],
    activeIds = [],
    types = [],
    states = {},
    getErrors = {},
    failMove = null,
    failMoveById = {},
    listPrError = null,
  } = {}) {
    this.items = new Map(Object.entries(items).map(([id, item]) => [String(id), structuredClone(item)]));
    this.prs = structuredClone(prs);
    this.activeIds = activeIds.map(String);
    this.types = types;
    this.states = states;
    this.getErrors = new Map(Object.entries(getErrors).map(([id, error]) => [String(id), error]));
    this.failMove = failMove;
    this.failMoveById = new Map(Object.entries(failMoveById).map(([id, error]) => [String(id), error]));
    this.listPrError = listPrError;
    this.moves = [];
    this.prQueries = [];
  }

  async listWorkItemTypes() {
    return this.types;
  }

  async listWorkItemStates(_context, typeName) {
    return this.states[typeName] || [];
  }

  async getWorkItem(_context, id) {
    const key = String(id);
    if (this.getErrors.has(key)) throw this.getErrors.get(key);
    const item = this.items.get(key);
    if (!item) throw httpError(404, `unknown work item ${id}`);
    return structuredClone(item);
  }

  async moveWorkItemState(_context, { id, rev, state, comment }) {
    const key = String(id);
    if (this.failMoveById.has(key)) throw this.failMoveById.get(key);
    if (this.failMove) throw this.failMove;
    const item = this.items.get(key);
    item.rev = rev + 1;
    item.fields['System.State'] = state;
    this.moves.push({ id: key, state, comment });
    return structuredClone(item);
  }

  async listCompletedPullRequests(_context, options = {}) {
    if (this.listPrError) throw this.listPrError;
    this.prQueries.push(structuredClone(options));
    return this.prs
      .filter((pr) => !options.targetRefName || pr.targetRefName === options.targetRefName)
      .filter((pr) => !options.minTime || !pr.closedDate || new Date(pr.closedDate) >= new Date(options.minTime))
      .map((pr) => structuredClone(pr));
  }

  async listTrackedItemsInBuckets() {
    return this.activeIds.map((id) => structuredClone(this.items.get(String(id))));
  }
}

function createRepo(defaultBranch = 'main') {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-remote-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-repo-'));
  git(remote, 'init', '--bare', `--initial-branch=${defaultBranch}`);
  git(repo, 'init', `--initial-branch=${defaultBranch}`);
  fs.writeFileSync(path.join(repo, 'README.md'), 'root\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', defaultBranch);
  return { repo, remote };
}

function createPushedBranch(repo, branchName, fileName, content) {
  const base = git(repo, 'branch', '--show-current');
  git(repo, 'checkout', '-b', branchName);
  fs.writeFileSync(path.join(repo, fileName), `${content}\n`);
  git(repo, 'add', fileName);
  git(repo, 'commit', '-m', `add ${fileName}`);
  git(repo, 'push', '-u', 'origin', branchName);
  git(repo, 'checkout', base);
}

function writeAdoConfig(home, organization, project) {
  const dir = path.join(home, '.ado-credentials');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    activeContext: 'default',
    contexts: [{ name: 'default', organization, project }],
  }, null, 2));
}

function createStateMap() {
  return {
    'Product Backlog Item': {
      todo: 'New',
      doing: 'Committed',
      done: 'Done',
      removed: 'Removed',
      categories: {
        Proposed: ['New', 'Approved'],
        InProgress: ['Committed'],
        Completed: ['Done'],
        Removed: ['Removed', 'Cut'],
      },
    },
    Bug: {
      todo: 'New',
      doing: 'Active',
      done: 'Closed',
      removed: 'Removed',
      categories: {
        Proposed: ['New'],
        InProgress: ['Active'],
        Completed: ['Closed'],
        Removed: ['Removed'],
      },
    },
    Task: {
      todo: 'New',
      doing: 'Active',
      verify: 'Resolved',
      done: 'Closed',
      categories: {
        Proposed: ['New'],
        InProgress: ['Active'],
        Resolved: ['Resolved'],
        Completed: ['Closed'],
      },
    },
  };
}

function createStateFile(repo, state) {
  const file = path.join(repo, '.engineering-catalog', 'ado-board.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return file;
}

test('parseBranchWorkItem recognises feature, bug and pbi branches', () => {
  assert.deepEqual(parseBranchWorkItem('feature/ADO-123-example'), {
    id: '123',
    kind: 'feature',
    branch: 'feature/ADO-123-example',
  });
  assert.deepEqual(parseBranchWorkItem('bug/ADO-55-fix-it'), {
    id: '55',
    kind: 'bug',
    branch: 'bug/ADO-55-fix-it',
  });
  assert.deepEqual(parseBranchWorkItem('refs/remotes/origin/pbi/9-slice'), {
    id: '9',
    kind: 'pbi',
    branch: 'pbi/9-slice',
  });
  assert.equal(parseBranchWorkItem('chore/no-ticket'), null);
});

test('parsePullRequestWorkItem ignores stray #n references and keeps explicit work item refs', () => {
  assert.deepEqual(parsePullRequestWorkItem({
    title: 'feat(42): add board repair',
    description: 'Step #2 of the upgrade.',
  }), ['42']);
  assert.deepEqual(parsePullRequestWorkItem({
    title: 'chore: dependency update',
    description: 'Fixes #7 and AB#9 while Step #2 stays plain prose.',
  }).sort(), ['7', '9']);
  assert.deepEqual(parsePullRequestWorkItem({
    title: 'docs: plain note #2',
    description: 'still just Step #2',
  }), []);
});

test('discover writes the project state map and prompt text goes to the provided stream', async () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-state-')), 'ado-board.json');
  const transport = new FakeTransport({
    types: [{ name: 'Product Backlog Item' }, { name: 'Bug' }],
    states: {
      'Product Backlog Item': [
        { name: 'New', category: 'Proposed' },
        { name: 'Approved', category: 'Proposed' },
        { name: 'Committed', category: 'InProgress' },
        { name: 'Done', category: 'Completed' },
      ],
      Bug: [
        { name: 'New', category: 'Proposed' },
        { name: 'Active', category: 'InProgress' },
        { name: 'Resolved', category: 'Resolved' },
        { name: 'Closed', category: 'Completed' },
        { name: 'Removed', category: 'Removed' },
      ],
    },
  });

  const result = await discoverStates({
    transport,
    context: { organization: 'https://dev.azure.com/example', project: 'Catalog' },
    stateFile,
    choose: ['Product Backlog Item:todo=Approved'],
    nonInteractive: true,
  });

  assert.equal(result.ok, true);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.stateMap['Product Backlog Item'].todo, 'Approved');
  assert.deepEqual(saved.stateMap['Product Backlog Item'].categories.Proposed, ['New', 'Approved']);
  assert.deepEqual(saved.stateMap.Bug.categories.Removed, ['Removed']);

  const input = new PassThrough();
  input.isTTY = true;
  input.end('2\n');
  const output = new PassThrough();
  output.isTTY = true;
  let prompt = '';
  output.on('data', (chunk) => { prompt += chunk.toString('utf8'); });
  const choice = await chooseState({
    typeName: 'Product Backlog Item',
    bucket: 'todo',
    category: 'Proposed',
    states: ['New', 'Approved'],
    nonInteractive: false,
    chooseMap: {},
    input,
    output,
  });
  assert.equal(choice.state, 'Approved');
  assert.match(prompt, /Choose one:/);
});

test('requiredFieldName matches real TF401320 required fields and ignores invalid state errors', () => {
  assert.equal(
    requiredFieldName(new Error('TF401320: Rule Error for field Remaining Work. Error code: Required, InvalidEmpty.')),
    'Remaining Work',
  );
  assert.equal(
    requiredFieldName(new Error("The field 'System.State' contains value 'Foo' that is not in the list of supported values.")),
    null,
  );
});

test('move refuses backwards movement, reports required fields, and rejects idp-tagged items', async () => {
  const stateMap = createStateMap();

  await assert.rejects(() => moveWorkItem({
    transport: new FakeTransport({
      items: {
        11: {
          id: 11,
          rev: 3,
          fields: {
            'System.WorkItemType': 'Task',
            'System.State': 'Active',
            'System.Tags': '',
            'System.Title': 'Task',
          },
        },
      },
    }),
    context: {},
    stateMap,
    id: 11,
    targetBucket: 'todo',
  }), /backwards/);

  const required = await moveWorkItem({
    transport: new FakeTransport({
      items: {
        12: {
          id: 12,
          rev: 1,
          fields: {
            'System.WorkItemType': 'Task',
            'System.State': 'Active',
            'System.Tags': '',
            'System.Title': 'Task',
          },
        },
      },
      failMove: new Error('TF401320: Rule Error for field Remaining Work. Error code: Required, InvalidEmpty.'),
    }),
    context: {},
    stateMap,
    id: 12,
    targetBucket: 'verify',
    comment: 'evidence',
  });
  assert.deepEqual(required, {
    ok: false,
    id: '12',
    error: 'required-field',
    field: 'Remaining Work',
    message: 'TF401320: Rule Error for field Remaining Work. Error code: Required, InvalidEmpty.',
  });

  const idp = await moveWorkItem({
    transport: new FakeTransport({
      items: {
        13: {
          id: 13,
          rev: 1,
          fields: {
            'System.WorkItemType': 'Product Backlog Item',
            'System.State': 'New',
            'System.Tags': 'idp:claimed',
            'System.Title': 'Runner card',
          },
        },
      },
    }),
    context: {},
    stateMap,
    id: 13,
    targetBucket: 'doing',
  });
  assert.equal(idp.ok, false);
  assert.equal(idp.error, 'idp-tagged');
});

test('resolveAdoContext derives Azure context from origin and refuses mismatches', () => {
  const { repo } = createRepo();
  git(repo, 'remote', 'set-url', 'origin', 'https://dev.azure.com/hanwha/Catalog/_git/engineering-catalog');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-home-'));

  writeAdoConfig(home, 'https://dev.azure.com/hanwha', 'Catalog');
  const context = resolveAdoContext({
    env: { ...process.env, ENGCAT_HOME: home },
    cwd: repo,
    state: { organization: 'https://dev.azure.com/hanwha', project: 'Catalog' },
  });
  assert.equal(context.organization, 'https://dev.azure.com/hanwha');
  assert.equal(context.project, 'Catalog');
  assert.equal(context.repository, 'engineering-catalog');

  writeAdoConfig(home, 'https://dev.azure.com/hal-tss', 'Catalog');
  assert.throws(() => resolveAdoContext({
    env: { ...process.env, ENGCAT_HOME: home },
    cwd: repo,
  }), /repository origin/);
});

test('reconcile --allow-unconfigured exits before any auth or git context work', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-no-state-'));
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-bin-'));
  const marker = path.join(cwd, 'az-called');
  fs.writeFileSync(path.join(fakeBin, 'az'), `#!/bin/sh\necho called > "${marker}"\nexit 42\n`);
  fs.chmodSync(path.join(fakeBin, 'az'), 0o755);

  const result = spawnSync('node', [SCRIPT, 'reconcile', '--allow-unconfigured', '--json'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    command: 'reconcile',
    skipped: 'state-map-missing',
  });
  assert.equal(fs.existsSync(marker), false);
});

test('reconcile uses master when the repository base branch is not main', async () => {
  const { repo } = createRepo('master');
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'feature.txt', 'feature work');
  git(repo, 'fetch', 'origin');

  const transport = new FakeTransport({
    items: {
      101: {
        id: 101,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'New',
          'System.Tags': '',
          'System.Title': 'Track pushed work',
        },
      },
    },
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(result.changed.map((entry) => entry.id), ['101']);
});

test('reconcile reports base-not-found when no remote base can be resolved', async () => {
  const { repo } = createRepo('trunk');
  git(repo, 'fetch', 'origin');
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'feature.txt', 'feature work');
  git(repo, 'update-ref', '-d', 'refs/remotes/origin/HEAD');

  const result = await reconcileBoard({
    transport: new FakeTransport(),
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(result.changed, []);
  assert.equal(result.report.warnings[0].code, 'base-not-found');
});

test('reconcile records per-item skips, keeps earlier moves, maps alternate states, and falls back from verify to done', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'one.txt', 'one');
  createPushedBranch(repo, 'feature/ADO-202-approved-work', 'two.txt', 'two');
  git(repo, 'fetch', 'origin');

  const transport = new FakeTransport({
    items: {
      101: {
        id: 101,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'New',
          'System.Tags': '',
          'System.Title': 'Todo item',
        },
      },
      202: {
        id: 202,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Approved',
          'System.Tags': '',
          'System.Title': 'Approved item',
        },
      },
      303: {
        id: 303,
        rev: 4,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': '',
          'System.Title': 'Bug without verify state',
        },
      },
      505: {
        id: 505,
        rev: 9,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.State': 'Closed',
          'System.Tags': '',
          'System.Title': 'Already done bug',
        },
      },
      606: {
        id: 606,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Removed',
          'System.Tags': '',
          'System.Title': 'Removed item',
        },
      },
      707: {
        id: 707,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Custom',
          'System.Tags': '',
          'System.Title': 'Unknown state item',
        },
      },
    },
    getErrors: {
      404: httpError(404, 'Not found'),
    },
    prs: [
      {
        pullRequestId: 1,
        sourceRefName: 'refs/heads/bug/ADO-303-awaiting-verification',
        targetRefName: 'refs/heads/main',
        closedDate: '2026-10-12T12:00:00.000Z',
        workItemRefs: [{ id: 303 }],
      },
      {
        pullRequestId: 2,
        sourceRefName: 'refs/heads/bug/ADO-505-already-closed',
        targetRefName: 'refs/heads/main',
        closedDate: '2026-10-12T12:05:00.000Z',
        workItemRefs: [{ id: 505 }],
      },
      {
        pullRequestId: 3,
        sourceRefName: 'refs/heads/feature/ADO-606-removed',
        targetRefName: 'refs/heads/main',
        closedDate: '2026-10-12T12:10:00.000Z',
        workItemRefs: [{ id: 606 }],
      },
      {
        pullRequestId: 4,
        sourceRefName: 'refs/heads/feature/ADO-404-missing',
        targetRefName: 'refs/heads/main',
        closedDate: '2026-10-12T12:15:00.000Z',
        workItemRefs: [{ id: 404 }, { id: 707 }],
      },
    ],
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(result.changed.map((entry) => ({ id: entry.id, to: entry.to })), [
    { id: '101', to: 'doing' },
    { id: '202', to: 'doing' },
    { id: '303', to: 'done' },
  ]);
  assert.equal(transport.items.get('101').fields['System.State'], 'Committed');
  assert.equal(transport.items.get('202').fields['System.State'], 'Committed');
  assert.equal(transport.items.get('303').fields['System.State'], 'Closed');
  assert.deepEqual(result.skipped.map((entry) => entry.reason).sort(), [
    'noop',
    'removed',
    'state-unmapped',
    'work-item-missing',
  ]);
});

test('reconcile records processed pull requests and does not reapply them after a reopen', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  };
  const stateFile = createStateFile(repo, initialState);

  const transport = new FakeTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': '',
          'System.Title': 'Awaiting verification',
        },
      },
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/bug/ADO-303-awaiting-verification',
      targetRefName: 'refs/heads/main',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const first = await reconcileBoard({
    transport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });
  assert.deepEqual(first.changed.map((entry) => entry.id), ['303']);

  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.processedPullRequests.length, 1);
  transport.items.get('303').fields['System.State'] = 'Active';

  const second = await reconcileBoard({
    transport,
    context: {},
    stateMap: saved.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: saved,
  });

  assert.deepEqual(second.changed, []);
  assert.equal(transport.items.get('303').fields['System.State'], 'Active');
});

test('reconcile filters completed PRs to the repo base branch and only asks for newer ones', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  git(repo, 'remote', 'set-url', 'origin', 'https://dev.azure.com/example/Catalog/_git/engineering-catalog');
  const transport = new FakeTransport({
    items: {
      101: {
        id: 101,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Should stay doing',
        },
      },
    },
    prs: [
      {
        pullRequestId: 1,
        sourceRefName: 'refs/heads/feature/ADO-101-catalog-sync',
        targetRefName: 'refs/heads/release/1.0',
        closedDate: '2026-10-12T10:00:00.000Z',
        workItemRefs: [{ id: 101 }],
      },
      {
        pullRequestId: 2,
        sourceRefName: 'refs/heads/feature/ADO-101-catalog-sync',
        targetRefName: 'refs/heads/main',
        closedDate: '2026-10-12T09:00:00.000Z',
        workItemRefs: [{ id: 101 }],
      },
    ],
  });

  await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    projectState: {
      stateMap: createStateMap(),
      reconcile: { processedPullRequests: [], lastCompletedPrClosedDate: '2026-10-12T09:30:00.000Z' },
    },
  });

  assert.deepEqual(transport.prQueries[0], {
    repository: 'engineering-catalog',
    targetRefName: 'refs/heads/main',
    minTime: '2026-10-12T09:30:00.000Z',
  });
});

test('reconcile reports verify items separately from stale doing work', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({
    items: {
      111: {
        id: 111,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Doing item',
        },
      },
      222: {
        id: 222,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Task',
          'System.State': 'Resolved',
          'System.Tags': '',
          'System.Title': 'Waiting for QA',
        },
      },
    },
    activeIds: [111, 222],
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 0,
    throttleHours: 0,
  });

  assert.deepEqual(result.report.doingWithNoPushedCommit.map((entry) => entry.id), ['111']);
  assert.deepEqual(result.report.verifyWaitingForQa.map((entry) => entry.id), ['222']);
});

test('reconcile writes the throttle stamp only after a successful run', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-home-'));
  const env = { ...process.env, ENGCAT_HOME: home };
  const failing = new FakeTransport({
    listPrError: new Error('network down'),
  });

  await assert.rejects(() => reconcileBoard({
    transport: failing,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 12,
    env,
  }), /network down/);

  assert.equal(fs.existsSync(path.join(home, '.engineering-catalog', 'ado-board-reconcile.json')), false);

  const passing = new FakeTransport();
  const first = await reconcileBoard({
    transport: passing,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 12,
    env,
  });
  assert.equal(first.throttled, false);

  const second = await reconcileBoard({
    transport: passing,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 12,
    env,
  });
  assert.equal(second.throttled, true);
});
