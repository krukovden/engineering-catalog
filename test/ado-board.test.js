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
  parseAzureReposRemote,
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

// Real /updates semantics: fields carry the change time (System.ChangedDate.newValue);
// revisedDate is when the revision was superseded — the next revision's change time,
// 9999-01-01 for the latest one. Fixtures may seed `revisedDate` as the change time; it is
// converted to a ChangedDate field here so tests never lean on the wrong meaning.
function realShapedUpdates(list) {
  const out = list.map((update) => {
    const copy = structuredClone(update);
    copy.fields = copy.fields || {};
    if (!copy.fields['System.ChangedDate']) copy.fields['System.ChangedDate'] = { newValue: copy.revisedDate };
    return copy;
  });
  out.forEach((update, index) => {
    update.revisedDate = index + 1 < out.length
      ? out[index + 1].fields['System.ChangedDate'].newValue
      : '9999-01-01T00:00:00Z';
  });
  return out;
}

class FakeTransport {
  constructor({
    items = {},
    updates = {},
    prs = [],
    activeIds = [],
    types = [],
    states = {},
    getErrors = {},
    getUpdatesErrors = {},
    failMove = null,
    failMoveById = {},
    listPrError = null,
    moveTimestamp = '2026-10-12T15:00:00.000Z',
  } = {}) {
    this.items = new Map(Object.entries(items).map(([id, item]) => [String(id), structuredClone(item)]));
    this.updates = new Map(Object.entries(updates).map(([id, itemUpdates]) => [String(id), realShapedUpdates(itemUpdates)]));
    this.prs = structuredClone(prs);
    this.activeIds = activeIds.map(String);
    this.types = types;
    this.states = states;
    this.getErrors = new Map(Object.entries(getErrors).map(([id, error]) => [String(id), error]));
    this.getUpdatesErrors = new Map(Object.entries(getUpdatesErrors).map(([id, error]) => [String(id), error]));
    this.failMove = failMove;
    this.failMoveById = new Map(Object.entries(failMoveById).map(([id, error]) => [String(id), error]));
    this.listPrError = listPrError;
    this.moveTimestamp = moveTimestamp;
    this.moveCount = 0;
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

  async getWorkItemUpdates(_context, id) {
    const key = String(id);
    if (this.getUpdatesErrors.has(key)) throw this.getUpdatesErrors.get(key);
    return structuredClone(this.updates.get(key) || []);
  }

  async moveWorkItemState(_context, { id, rev, state, comment }) {
    const key = String(id);
    if (this.failMoveById.has(key)) throw this.failMoveById.get(key);
    if (this.failMove) throw this.failMove;
    const item = this.items.get(key);
    const revisedDate = new Date(new Date(this.moveTimestamp).getTime() + (this.moveCount * 60000)).toISOString();
    this.moveCount += 1;
    item.rev = rev + 1;
    item.fields['System.State'] = state;
    item.fields['Microsoft.VSTS.Common.StateChangeDate'] = revisedDate;
    item.fields['System.ChangedDate'] = revisedDate;
    const itemUpdates = this.updates.get(key) || [];
    itemUpdates.push({
      revisedDate,
      revisedBy: { displayName: 'ado-board reconcile' },
      fields: {
        'System.ChangedDate': { newValue: revisedDate },
        'System.State': { newValue: state },
        'System.History': { newValue: comment },
      },
    });
    this.updates.set(key, realShapedUpdates(itemUpdates));
    this.moves.push({ id: key, state, comment });
    return structuredClone(item);
  }

  async listCompletedPullRequests(_context, options = {}) {
    if (this.listPrError) throw this.listPrError;
    this.prQueries.push(structuredClone(options));
    const timeField = options.queryTimeRangeType === 'closed' ? 'closedDate' : 'creationDate';
    return this.prs
      .filter((pr) => !options.targetRefName || pr.targetRefName === options.targetRefName)
      .filter((pr) => !options.minTime || !pr[timeField] || new Date(pr[timeField]) >= new Date(options.minTime))
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

test('parseAzureReposRemote recognises Azure HTTPS, userinfo, visualstudio, and ssh remotes', () => {
  assert.deepEqual(parseAzureReposRemote('https://dev.azure.com/hanwha/Catalog/_git/engineering-catalog'), {
    organization: 'https://dev.azure.com/hanwha',
    organizationId: 'hanwha',
    project: 'Catalog',
    repository: 'engineering-catalog',
  });
  assert.deepEqual(parseAzureReposRemote('https://HAL-TSS@dev.azure.com/HAL-TSS/TSS-Orion/_git/Repo'), {
    organization: 'https://dev.azure.com/HAL-TSS',
    organizationId: 'HAL-TSS',
    project: 'TSS-Orion',
    repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('https://hal.visualstudio.com/Catalog/_git/engineering-catalog'), {
    organization: 'https://hal.visualstudio.com',
    organizationId: 'hal',
    project: 'Catalog',
    repository: 'engineering-catalog',
  });
  assert.deepEqual(parseAzureReposRemote('https://hal@hal.visualstudio.com/Catalog/_git/Repo'), {
    organization: 'https://hal.visualstudio.com',
    organizationId: 'hal',
    project: 'Catalog',
    repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('https://hal.visualstudio.com/DefaultCollection/Catalog/_git/Repo'), {
    organization: 'https://hal.visualstudio.com',
    organizationId: 'hal',
    project: 'Catalog',
    repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('git@ssh.dev.azure.com:v3/HAL-TSS/TSS-Orion/Repo'), {
    organization: 'https://dev.azure.com/HAL-TSS',
    organizationId: 'HAL-TSS',
    project: 'TSS-Orion',
    repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('ssh://git@ssh.dev.azure.com/v3/HAL-TSS/TSS-Orion/Repo'), {
    organization: 'https://dev.azure.com/HAL-TSS',
    organizationId: 'HAL-TSS',
    project: 'TSS-Orion',
    repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('hal@vs-ssh.visualstudio.com:v3/hal/Catalog/Repo'), {
    organization: 'https://hal.visualstudio.com',
    organizationId: 'hal',
    project: 'Catalog',
    repository: 'Repo',
  });
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

test('move refuses backwards movement, reports required fields, and only allows idp-tagged items with explicit opt-in', async () => {
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

  const allowed = await moveWorkItem({
    transport: new FakeTransport({
      items: {
        14: {
          id: 14,
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
    id: 14,
    targetBucket: 'doing',
    allowIdp: true,
    comment: 'runner move',
  });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.to, 'doing');
});

test('CLI move passes --allow-idp through to the move command', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-cli-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-home-'));
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-bin-'));
  const stateFile = path.join(cwd, '.engineering-catalog', 'ado-board.json');
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  }, null, 2));
  writeAdoConfig(home, 'https://dev.azure.com/example', 'Catalog');
  fs.writeFileSync(path.join(bin, 'az'), `#!/bin/sh\nif [ \"$1\" = \"account\" ]; then\n  printf '{\"accessToken\":\"token\"}\\n'\n  exit 0\nfi\nexit 2\n`);
  fs.chmodSync(path.join(bin, 'az'), 0o755);
  const mockFetch = path.join(cwd, 'mock-fetch.js');
  fs.writeFileSync(mockFetch, `
global.fetch = async (url, options) => {
  const body = JSON.stringify({
    id: 14,
    rev: 2,
    fields: {
      "System.WorkItemType": "Product Backlog Item",
      "System.State": "Committed",
      "System.Tags": "idp:claimed",
      "System.Title": "Runner card",
      "Microsoft.VSTS.Common.StateChangeDate": "2026-10-12T16:00:00.000Z",
      "System.ChangedDate": "2026-10-12T16:00:00.000Z"
    }
  });
  if (String(url).includes('/workitems/14?')) {
    if ((options && options.method) === 'PATCH') return { ok: true, text: async () => body };
    return { ok: true, text: async () => JSON.stringify({
      id: 14,
      rev: 1,
      fields: {
        "System.WorkItemType": "Product Backlog Item",
        "System.State": "New",
        "System.Tags": "idp:claimed",
        "System.Title": "Runner card",
        "Microsoft.VSTS.Common.StateChangeDate": "2026-10-12T15:00:00.000Z",
        "System.ChangedDate": "2026-10-12T15:00:00.000Z"
      }
    }) };
  }
  throw new Error('unexpected url ' + url);
};
`);

  const result = spawnSync('node', [SCRIPT, 'move', '14', 'doing', '--allow-idp', '--json'], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ENGCAT_HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      NODE_OPTIONS: `--require ${mockFetch}`,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.to, 'doing');
});

test('resolveAdoContext derives Azure context from origin and refuses config or state mismatches', () => {
  const { repo } = createRepo();
  git(repo, 'remote', 'set-url', 'origin', 'https://hanwha@dev.azure.com/hanwha/Catalog/_git/engineering-catalog');
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
  writeAdoConfig(home, 'https://dev.azure.com/hanwha', 'Catalog');
  assert.throws(() => resolveAdoContext({
    env: { ...process.env, ENGCAT_HOME: home },
    cwd: repo,
    state: { organization: 'https://dev.azure.com/hal-tss', project: 'Catalog' },
  }), /state file/);
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

test('reconcile reports branch-loop getWorkItem 500 as move-error', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'one.txt', 'one');
  git(repo, 'fetch', 'origin');

  const result = await reconcileBoard({
    transport: new FakeTransport({
      getErrors: { 101: httpError(500, 'server exploded') },
    }),
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.equal(result.skipped[0].reason, 'move-error');
});

test('reconcile does not replay a completed PR onto an item changed after the PR closed', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');

  const transport = new FakeTransport({
    items: {
      303: {
        id: 303,
        rev: 6,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Human reopened item',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-12T14:00:00.000Z',
          'System.ChangedDate': '2026-10-12T14:00:00.000Z',
        },
      },
    },
    updates: {
      303: [{
        revisedDate: '2026-10-12T14:00:00.000Z',
        revisedBy: { displayName: 'QA Engineer' },
        fields: {
          'System.State': { newValue: 'Committed' },
          'System.History': { newValue: 'QA reopened after verification failed.' },
        },
      }],
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/feature/ADO-303-human-reopen',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(result.changed, []);
  assert.equal(result.skipped[0].reason, 'pr-replayed-after-manual-change');
  assert.equal(transport.items.get('303').fields['System.State'], 'Committed');
});

test('reconcile does not replay a branch onto an item moved back to todo after the branch commit', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'feature.txt', 'feature work');
  git(repo, 'fetch', 'origin');
  const branchCommittedAt = git(repo, 'for-each-ref', '--format=%(committerdate:iso-strict)', 'refs/remotes/origin/feature/ADO-101-catalog-sync');

  const transport = new FakeTransport({
    items: {
      101: {
        id: 101,
        rev: 2,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'New',
          'System.Tags': '',
          'System.Title': 'Human moved it back to todo',
          'Microsoft.VSTS.Common.StateChangeDate': new Date(new Date(branchCommittedAt).getTime() + 60000).toISOString(),
          'System.ChangedDate': new Date(new Date(branchCommittedAt).getTime() + 60000).toISOString(),
        },
      },
    },
    updates: {
      101: [{
        revisedDate: new Date(new Date(branchCommittedAt).getTime() + 60000).toISOString(),
        revisedBy: { displayName: 'Product Owner' },
        fields: {
          'System.State': { newValue: 'New' },
          'System.History': { newValue: 'Moved back to todo while scope changed.' },
        },
      }],
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

  assert.deepEqual(result.changed, []);
  assert.equal(result.skipped[0].reason, 'branch-replayed-after-manual-change');
  assert.equal(transport.items.get('101').fields['System.State'], 'New');
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

test('reconcile does not treat its own branch move as a manual reopen before the completed PR move', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-5-squash-merge', 'feature.txt', 'feature work');
  git(repo, 'fetch', 'origin');

  const transport = new FakeTransport({
    items: {
      5: {
        id: 5,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'New',
          'System.Tags': '',
          'System.Title': 'Squash merged item',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-12T13:00:00.000Z',
          'System.ChangedDate': '2026-10-12T13:00:00.000Z',
        },
      },
    },
    prs: [{
      pullRequestId: 10,
      sourceRefName: 'refs/heads/feature/ADO-5-squash-merge',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-12T13:00:00.000Z',
      closedDate: '2026-10-12T14:00:00.000Z',
      workItemRefs: [{ id: 5 }],
    }],
    moveTimestamp: '2026-10-12T15:00:00.000Z',
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: createStateMap(),
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    projectState: { stateMap: createStateMap() },
  });

  assert.deepEqual(result.changed.map((entry) => ({ id: entry.id, to: entry.to })), [
    { id: '5', to: 'doing' },
    { id: '5', to: 'done' },
  ]);
  assert.equal(transport.items.get('5').fields['System.State'], 'Done');
});

test('reconcile does not treat a prior ado-board branch move as a manual reopen on a later run', async () => {
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
      5: {
        id: 5,
        rev: 2,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Already doing from ado-board',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-12T15:00:00.000Z',
          'System.ChangedDate': '2026-10-12T15:00:00.000Z',
        },
      },
    },
    updates: {
      5: [{
        revisedDate: '2026-10-12T15:00:00.000Z',
        revisedBy: { displayName: 'ado-board reconcile' },
        fields: {
          'System.State': { newValue: 'Committed' },
          'System.History': { newValue: 'ado-board: moved to doing after pushed work on feature/ADO-5-squash-merge (1234567).' },
        },
      }],
    },
    prs: [{
      pullRequestId: 10,
      sourceRefName: 'refs/heads/feature/ADO-5-squash-merge',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-12T13:00:00.000Z',
      closedDate: '2026-10-12T14:00:00.000Z',
      workItemRefs: [{ id: 5 }],
    }],
  });

  const result = await reconcileBoard({
    transport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });

  assert.deepEqual(result.changed.map((entry) => ({ id: entry.id, to: entry.to })), [
    { id: '5', to: 'done' },
  ]);
  assert.equal(transport.items.get('5').fields['System.State'], 'Done');
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
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    prs: [
      {
        pullRequestId: 1,
        sourceRefName: 'refs/heads/feature/ADO-101-catalog-sync',
        targetRefName: 'refs/heads/release/1.0',
        creationDate: '2026-10-12T08:00:00.000Z',
        closedDate: '2026-10-12T10:00:00.000Z',
        workItemRefs: [{ id: 101 }],
      },
      {
        pullRequestId: 2,
        sourceRefName: 'refs/heads/feature/ADO-101-catalog-sync',
        targetRefName: 'refs/heads/main',
        creationDate: '2026-10-01T08:00:00.000Z',
        closedDate: '2026-10-12T09:00:00.000Z',
        workItemRefs: [{ id: 101 }],
      },
      {
        pullRequestId: 3,
        sourceRefName: 'refs/heads/feature/ADO-101-catalog-sync',
        targetRefName: 'refs/heads/main',
        creationDate: '2026-10-01T08:00:00.000Z',
        closedDate: '2026-10-12T10:00:00.000Z',
        workItemRefs: [{ id: 101 }],
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
    projectState: {
      stateMap: createStateMap(),
      reconcile: { processedPullRequests: [], lastCompletedPrClosedDate: '2026-10-12T09:30:00.000Z' },
    },
  });

  assert.deepEqual(result.changed.map((entry) => entry.id), ['101']);
  assert.deepEqual(transport.prQueries[0], {
    repository: 'engineering-catalog',
    targetRefName: 'refs/heads/main',
    minTime: '2026-10-12T09:30:00.000Z',
    queryTimeRangeType: 'closed',
    maxPages: 2,
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

test('reconcile retries a completed PR after a transient move error instead of marking it processed', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  };
  const stateFile = createStateFile(repo, initialState);
  const retryable = httpError(500, 'server exploded');

  const firstTransport = new FakeTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Retryable item',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    failMoveById: { 303: retryable },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/feature/ADO-303-retryable',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const first = await reconcileBoard({
    transport: firstTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });
  assert.equal(first.skipped[0].reason, 'move-error');
  const savedAfterFirst = loadProjectState(stateFile);
  assert.equal(savedAfterFirst.reconcile.retryablePullRequests[0].pullRequestId, '55');

  const secondTransport = new FakeTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Retryable item',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/feature/ADO-303-retryable',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const second = await reconcileBoard({
    transport: secondTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });
  assert.deepEqual(second.changed.map((entry) => entry.id), ['303']);
});

test('reconcile keeps retryable older PRs queryable even after a later PR succeeds', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  };
  const stateFile = createStateFile(repo, initialState);
  const retryable = httpError(500, 'server exploded');

  const firstTransport = new FakeTransport({
    items: {
      1: {
        id: 1,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Older retryable PR',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
      2: {
        id: 2,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Later successful PR',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    failMoveById: { 1: retryable },
    prs: [
      {
        pullRequestId: 1,
        sourceRefName: 'refs/heads/feature/ADO-1-retry',
        targetRefName: 'refs/heads/main',
        creationDate: '2026-10-10T09:00:00.000Z',
        closedDate: '2026-10-12T10:00:00.000Z',
        workItemRefs: [{ id: 1 }],
      },
      {
        pullRequestId: 2,
        sourceRefName: 'refs/heads/feature/ADO-2-success',
        targetRefName: 'refs/heads/main',
        creationDate: '2026-10-10T09:00:00.000Z',
        closedDate: '2026-10-12T11:00:00.000Z',
        workItemRefs: [{ id: 2 }],
      },
    ],
  });

  await reconcileBoard({
    transport: firstTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });

  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.lastCompletedPrClosedDate, null);
  assert.equal(saved.reconcile.retryablePullRequests[0].pullRequestId, '1');

  const secondTransport = new FakeTransport({
    items: {
      1: {
        id: 1,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Older retryable PR',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    prs: [{
      pullRequestId: 1,
      sourceRefName: 'refs/heads/feature/ADO-1-retry',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T10:00:00.000Z',
      workItemRefs: [{ id: 1 }],
    }],
  });

  const second = await reconcileBoard({
    transport: secondTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: saved,
  });

  assert.deepEqual(second.changed.map((entry) => entry.id), ['1']);
  assert.equal(secondTransport.prQueries[0].minTime, '2026-10-12T10:00:00.000Z');
});

test('reconcile retries a PR when getWorkItem fails with 500 in the completed-pr loop', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  };
  const stateFile = createStateFile(repo, initialState);

  const firstTransport = new FakeTransport({
    getErrors: { 303: httpError(500, 'server exploded') },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/feature/ADO-303-retryable',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const first = await reconcileBoard({
    transport: firstTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });
  assert.equal(first.skipped[0].reason, 'move-error');

  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.retryablePullRequests[0].pullRequestId, '55');

  const secondTransport = new FakeTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Committed',
          'System.Tags': '',
          'System.Title': 'Retryable item',
          'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z',
          'System.ChangedDate': '2026-10-01T00:00:00.000Z',
        },
      },
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/feature/ADO-303-retryable',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-10T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  const second = await reconcileBoard({
    transport: secondTransport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: saved,
  });

  assert.deepEqual(second.changed.map((entry) => entry.id), ['303']);
});

test('reconcile keeps the prior completed-PR watermark when the PR list is truncated', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
    reconcile: {
      lastCompletedPrClosedDate: '2026-10-01T00:00:00.000Z',
      processedPullRequests: [{
        key: 'engineering-catalog::1::refs/heads/main::2026-10-01T00:00:00.000Z',
        pullRequestId: '1',
        repository: 'engineering-catalog',
        targetRefName: 'refs/heads/main',
        sourceRefName: 'refs/heads/feature/ADO-1-older',
        closedDate: '2026-10-01T00:00:00.000Z',
        workItemIds: ['1'],
      }],
    },
  };
  const stateFile = createStateFile(repo, initialState);
  class TruncatedTransport extends FakeTransport {
    async listCompletedPullRequests(_context, options = {}) {
      const rows = await super.listCompletedPullRequests(_context, options);
      rows.truncated = true;
      return rows;
    }
  }

  const transport = new TruncatedTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': '',
          'System.Title': 'Truncated PR scan item',
        },
      },
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/bug/ADO-303-newer-window',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-12T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
      workItemRefs: [{ id: 303 }],
    }],
  });

  await reconcileBoard({
    transport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });

  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.lastCompletedPrClosedDate, '2026-10-01T00:00:00.000Z');
  assert.equal(saved.reconcile.processedPullRequests.length, 2);
});

test('reconcile does not mark a PR processed when fetching its work-item links fails', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
  };
  const stateFile = createStateFile(repo, initialState);

  class LinkFetchFailureTransport extends FakeTransport {
    async listCompletedPullRequests(_context, options = {}) {
      const rows = await super.listCompletedPullRequests(_context, options);
      return rows.map((pr) => ({ ...pr, workItemRefs: [], workItemRefsError: true }));
    }
  }

  const transport = new LinkFetchFailureTransport({
    items: {
      303: {
        id: 303,
        rev: 5,
        fields: {
          'System.WorkItemType': 'Bug',
          'System.State': 'Active',
          'System.Tags': '',
          'System.Title': 'Link fetch failure item',
        },
      },
    },
    prs: [{
      pullRequestId: 55,
      sourceRefName: 'refs/heads/bug/ADO-303-link-fetch',
      targetRefName: 'refs/heads/main',
      creationDate: '2026-10-12T09:00:00.000Z',
      closedDate: '2026-10-12T13:00:00.000Z',
    }],
  });

  await reconcileBoard({
    transport,
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });

  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.processedPullRequests.length, 0);
  assert.equal(saved.reconcile.retryablePullRequests[0].pullRequestId, '55');
});

test('listTrackedItemsInBuckets splits large item lists into 200-id batches', async () => {
  const batches = [];
  const transport = new (require('../skills/shared/ado-board/scripts/lib').HttpAzureDevOpsTransport)({
    context: { organization: 'https://dev.azure.com/example', project: 'Catalog' },
    authHeader: 'Basic test',
    fetchImpl: async (url, options) => {
      if (String(url).includes('/_apis/wit/wiql')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            workItems: Array.from({ length: 201 }, (_, index) => ({ id: index + 1 })),
          }),
        };
      }
      if (String(url).includes('/_apis/wit/workitemsbatch')) {
        const body = JSON.parse(options.body);
        batches.push(body.ids);
        return {
          ok: true,
          text: async () => JSON.stringify({
            value: body.ids.map((id) => ({
              id,
              fields: {
                'System.WorkItemType': 'Task',
                'System.State': 'Active',
                'System.Tags': '',
                'System.Title': `Item ${id}`,
              },
            })),
          }),
        };
      }
      throw new Error(`unexpected url ${url}`);
    },
  });

  const stateMap = {
    Task: {
      doing: 'Active',
      verify: 'Resolved',
      done: 'Closed',
      categories: {
        InProgress: ['Active'],
        Resolved: ['Resolved'],
        Completed: ['Closed'],
      },
    },
  };

  const result = await transport.listTrackedItemsInBuckets({}, stateMap, ['doing', 'verify']);
  assert.equal(result.length, 201);
  assert.deepEqual(batches.map((batch) => batch.length), [200, 1]);
});

test('reconcile does not rewrite the state file when no reconcile markers change', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = {
    version: 1,
    organization: 'https://dev.azure.com/example',
    project: 'Catalog',
    stateMap: createStateMap(),
    reconcile: {
      lastCompletedPrClosedDate: '2026-10-12T13:00:00.000Z',
      processedPullRequests: [{
        key: 'engineering-catalog::55::refs/heads/main::2026-10-12T13:00:00.000Z',
        pullRequestId: '55',
        repository: 'engineering-catalog',
        targetRefName: 'refs/heads/main',
        sourceRefName: 'refs/heads/feature/ADO-303-retryable',
        closedDate: '2026-10-12T13:00:00.000Z',
        workItemIds: ['303'],
      }],
    },
  };
  const stateFile = createStateFile(repo, initialState);
  const before = fs.readFileSync(stateFile, 'utf8');

  await reconcileBoard({
    transport: new FakeTransport(),
    context: {},
    stateMap: initialState.stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
    stateFile,
    projectState: initialState,
  });

  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
});

function prItem(id, extra = {}) {
  return {
    id,
    rev: 2,
    fields: {
      'System.WorkItemType': 'Product Backlog Item',
      'System.State': 'Committed',
      'System.Tags': '',
      'System.Title': `Item ${id}`,
      'Microsoft.VSTS.Common.StateChangeDate': '2026-10-12T15:00:00.000Z',
      'System.ChangedDate': '2026-10-12T15:00:00.000Z',
      ...extra,
    },
  };
}

function closedPr(pullRequestId, workItemId, closedDate = '2026-10-12T14:00:00.000Z') {
  return {
    pullRequestId,
    sourceRefName: `refs/heads/feature/ADO-${workItemId}-x`,
    targetRefName: 'refs/heads/main',
    creationDate: '2026-10-12T13:00:00.000Z',
    closedDate,
    workItemRefs: [{ id: workItemId }],
  };
}

const reconcileArgs = (repo, transport, extra = {}) => ({
  transport,
  context: {},
  stateMap: createStateMap(),
  cwd: repo,
  staleDays: 30,
  throttleHours: 0,
  ...extra,
});

test('RX1 real-shaped updates: a human creation revision superseded by an own move is not a manual change after the PR closed', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({
    items: { 5: prItem(5) },
    updates: {
      5: [
        { revisedBy: { displayName: 'Product Owner' }, revisedDate: '2026-10-01T09:00:00.000Z', fields: { 'System.State': { newValue: 'New' } } },
        {
          revisedBy: { displayName: 'ado-board reconcile' },
          revisedDate: '2026-10-12T15:00:00.000Z',
          fields: {
            'System.State': { newValue: 'Committed' },
            'System.History': { newValue: 'ado-board: moved to doing after pushed work on feature/ADO-5-x (1234567).' },
          },
        },
      ],
    },
    prs: [closedPr(10, 5)],
  });
  // the fake must emit the real shape: rev 1 is superseded at the own move, the last rev is 9999
  const served = await transport.getWorkItemUpdates({}, 5);
  assert.equal(served[0].revisedDate, '2026-10-12T15:00:00.000Z');
  assert.equal(served[1].revisedDate, '9999-01-01T00:00:00Z');

  const result = await reconcileBoard(reconcileArgs(repo, transport));
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.changed.map((entry) => ({ id: entry.id, to: entry.to })), [{ id: '5', to: 'done' }]);
});

test('RX1b a genuine human state change after the PR closed still blocks the replay under real-shaped updates', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({
    items: { 5: prItem(5) },
    updates: {
      5: [
        { revisedDate: '2026-10-01T09:00:00.000Z', fields: { 'System.State': { newValue: 'New' } } },
        { revisedDate: '2026-10-12T15:00:00.000Z', revisedBy: { displayName: 'QA' }, fields: { 'System.State': { newValue: 'Committed' }, 'System.History': { newValue: 'reopened' } } },
      ],
    },
    prs: [closedPr(10, 5)],
  });
  const result = await reconcileBoard(reconcileArgs(repo, transport));
  assert.deepEqual(result.changed, []);
  assert.equal(result.skipped[0].reason, 'pr-replayed-after-manual-change');
});

test('RX2 a failing /updates call on a PR item is a retryable move-error, not an exception', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = { version: 1, organization: 'https://dev.azure.com/example', project: 'Catalog', stateMap: createStateMap() };
  const stateFile = createStateFile(repo, initialState);
  const transport = new FakeTransport({
    items: { 5: prItem(5), 6: prItem(6, { 'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z', 'System.ChangedDate': '2026-10-01T00:00:00.000Z' }) },
    getUpdatesErrors: { 5: httpError(500, 'boom') },
    prs: [closedPr(10, 5), closedPr(11, 6, '2026-10-12T14:30:00.000Z')],
  });
  const result = await reconcileBoard(reconcileArgs(repo, transport, { stateFile, projectState: initialState }));
  assert.deepEqual(result.skipped.map((entry) => [entry.id, entry.reason]), [['5', 'move-error']]);
  assert.deepEqual(result.changed.map((entry) => entry.id), ['6']);
  assert.equal(transport.items.get('6').fields['System.State'], 'Done');
  const saved = loadProjectState(stateFile);
  assert.deepEqual(saved.reconcile.retryablePullRequests.map((entry) => entry.pullRequestId), ['10']);
});

test('RX2b a failing /updates call on a branch item is a move-error, not an exception', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-5-catalog-sync', 'a.txt', 'a');
  createPushedBranch(repo, 'feature/ADO-6-other', 'b.txt', 'b');
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({
    items: {
      5: prItem(5, { 'System.State': 'New', 'Microsoft.VSTS.Common.StateChangeDate': '2099-01-01T00:00:00.000Z', 'System.ChangedDate': '2099-01-01T00:00:00.000Z' }),
      6: prItem(6, { 'System.State': 'New', 'Microsoft.VSTS.Common.StateChangeDate': '2026-01-01T00:00:00.000Z', 'System.ChangedDate': '2026-01-01T00:00:00.000Z' }),
    },
    getUpdatesErrors: { 5: httpError(503, 'unavailable') },
  });
  const result = await reconcileBoard(reconcileArgs(repo, transport));
  assert.deepEqual(result.skipped.map((entry) => [entry.id, entry.reason, entry.source]), [['5', 'move-error', 'branch-pushed']]);
  assert.deepEqual(result.changed.map((entry) => entry.id), ['6']);
});

test('L-i a permanent required-field failure is a terminal per-item report and does not pin minTime', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = { version: 1, organization: 'https://dev.azure.com/example', project: 'Catalog', stateMap: createStateMap() };
  const stateFile = createStateFile(repo, initialState);
  const transport = new FakeTransport({
    items: { 5: prItem(5, { 'Microsoft.VSTS.Common.StateChangeDate': '2026-10-01T00:00:00.000Z', 'System.ChangedDate': '2026-10-01T00:00:00.000Z' }) },
    failMoveById: { 5: new Error('TF401320: Rule Error for field Remaining Work. Error code: Required, InvalidEmpty.') },
    prs: [closedPr(10, 5)],
  });
  const result = await reconcileBoard(reconcileArgs(repo, transport, { stateFile, projectState: initialState }));
  assert.equal(result.skipped[0].reason, 'required-field');
  const saved = loadProjectState(stateFile);
  assert.equal(saved.reconcile.retryablePullRequests, undefined);
  assert.deepEqual(saved.reconcile.processedPullRequests.map((entry) => entry.pullRequestId), ['10']);
  assert.equal(saved.reconcile.lastCompletedPrClosedDate, '2026-10-12T14:00:00.000Z');
});

test('L-j the HTTP transport pages /updates and completed pull requests', async () => {
  const { HttpAzureDevOpsTransport } = require('../skills/shared/ado-board/scripts/lib');
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const parsed = new URL(url);
    const top = Number(parsed.searchParams.get('$top'));
    const skip = Number(parsed.searchParams.get('$skip') || 0);
    const total = parsed.pathname.includes('/updates') ? 250 : 130;
    const value = Array.from({ length: Math.max(0, Math.min(top, total - skip)) }, (_, i) => (
      parsed.pathname.includes('/updates') ? { id: skip + i } : { pullRequestId: skip + i, workItemRefs: [] }
    ));
    return { ok: true, status: 200, text: async () => JSON.stringify({ value }) };
  };
  const transport = new HttpAzureDevOpsTransport({
    context: { organization: 'https://dev.azure.com/example', project: 'Catalog' },
    authHeader: 'Basic x',
    fetchImpl,
  });
  const updates = await transport.getWorkItemUpdates({}, 5);
  assert.equal(updates.length, 250);
  assert.equal(new Set(updates.map((u) => u.id)).size, 250);
  const prs = await transport.listCompletedPullRequests({}, { repository: 'repo' });
  assert.equal(prs.length, 130);
  assert.equal(new Set(prs.map((p) => p.pullRequestId)).size, 130);
});

test('L-k a revisedBy named ado-board without the marker is not an own transition', () => {
  const { isOwnStateTransitionUpdate } = require('../skills/shared/ado-board/scripts/lib');
  assert.equal(isOwnStateTransitionUpdate({
    revisedBy: { displayName: 'ado-board reconcile' },
    fields: { 'System.State': { newValue: 'Done' }, 'System.History': { newValue: 'plain human note' } },
  }), false);
});

test('L-l parseAzureReposRemote accepts explicit ssh ports and project-less legacy visualstudio URLs', () => {
  assert.deepEqual(parseAzureReposRemote('ssh://git@ssh.dev.azure.com:22/v3/HAL-TSS/TSS-Orion/Repo'), {
    organization: 'https://dev.azure.com/HAL-TSS', organizationId: 'HAL-TSS', project: 'TSS-Orion', repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('ssh://hal@vs-ssh.visualstudio.com:22/v3/hal/Catalog/Repo'), {
    organization: 'https://hal.visualstudio.com', organizationId: 'hal', project: 'Catalog', repository: 'Repo',
  });
  assert.deepEqual(parseAzureReposRemote('https://hal.visualstudio.com/DefaultCollection/_git/Repo'), {
    organization: 'https://hal.visualstudio.com', organizationId: 'hal', project: 'Repo', repository: 'Repo',
  });
});

test('N10 the first reconcile has a bounded floor and a page budget; the CLI can widen both', async () => {
  const { reconcileQueryMinTime, DEFAULT_FIRST_RUN_DAYS, DEFAULT_MAX_PR_PAGES } = require('../skills/shared/ado-board/scripts/lib');
  const now = new Date('2026-10-12T12:00:00.000Z');
  assert.equal(reconcileQueryMinTime(null, { now }), '2026-09-28T12:00:00.000Z');
  assert.equal(reconcileQueryMinTime({}, { now, firstRunDays: 30 }), '2026-09-12T12:00:00.000Z');
  assert.equal(reconcileQueryMinTime({ reconcile: { lastCompletedPrClosedDate: '2026-10-01T00:00:00.000Z' } }, { now }), '2026-10-01T00:00:00.000Z');

  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({ items: { 5: prItem(5) }, prs: [closedPr(10, 5)] });
  await reconcileBoard(reconcileArgs(repo, transport));
  assert.ok(transport.prQueries[0].minTime, 'first run must send a minTime');
  const ageDays = (Date.now() - new Date(transport.prQueries[0].minTime).getTime()) / 86400000;
  assert.ok(Math.abs(ageDays - DEFAULT_FIRST_RUN_DAYS) < 0.01);
  assert.equal(transport.prQueries[0].maxPages, DEFAULT_MAX_PR_PAGES);
});

test('N10/L-n the HTTP transport honours maxPages and flags truncation', async () => {
  const { HttpAzureDevOpsTransport } = require('../skills/shared/ado-board/scripts/lib');
  let listCalls = 0;
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/pullrequests')) listCalls += 1;
    const skip = Number(parsed.searchParams.get('$skip') || 0);
    const value = parsed.pathname.endsWith('/pullrequests')
      ? Array.from({ length: 100 }, (_, i) => ({ pullRequestId: skip + i, workItemRefs: [] }))
      : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ value }) };
  };
  const transport = new HttpAzureDevOpsTransport({
    context: { organization: 'https://dev.azure.com/example', project: 'Catalog' },
    authHeader: 'Basic x',
    fetchImpl,
  });
  const prs = await transport.listCompletedPullRequests({}, { repository: 'repo', maxPages: 2 });
  assert.equal(listCalls, 2);
  assert.equal(prs.length, 200);
  assert.equal(prs.truncated, true);
});

test('L-n a truncated PR list is reported as a pr-list-truncated warning', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const transport = new FakeTransport({ items: { 5: prItem(5) }, prs: [closedPr(10, 5)] });
  const listed = transport.listCompletedPullRequests.bind(transport);
  transport.listCompletedPullRequests = async (...args) => Object.assign(await listed(...args), { truncated: true });
  const result = await reconcileBoard(reconcileArgs(repo, transport));
  assert.deepEqual(result.report.warnings.map((w) => w.code), ['pr-list-truncated']);
  const clean = await reconcileBoard(reconcileArgs(repo, new FakeTransport({ items: { 5: prItem(5) }, prs: [closedPr(10, 5)] })));
  assert.deepEqual(clean.report.warnings.filter((w) => w.code === 'pr-list-truncated'), []);
});

test('L-m a PR returned on two pages is handled once and strands no retry entry', async () => {
  const { repo } = createRepo();
  git(repo, 'fetch', 'origin');
  const initialState = { version: 1, organization: 'https://dev.azure.com/example', project: 'Catalog', stateMap: createStateMap() };
  const stateFile = createStateFile(repo, initialState);
  const transport = new FakeTransport({ items: { 5: prItem(5) }, prs: [closedPr(10, 5), closedPr(10, 5)] });
  // first lookup fails transiently, later ones succeed
  const getWorkItem = transport.getWorkItem.bind(transport);
  let calls = 0;
  transport.getWorkItem = async (...args) => {
    calls += 1;
    if (calls === 1) throw httpError(503, 'blip');
    return getWorkItem(...args);
  };
  const result = await reconcileBoard(reconcileArgs(repo, transport, { stateFile, projectState: initialState }));
  assert.equal(result.skipped.filter((s) => s.reason === 'move-error').length, 1);
  const saved = loadProjectState(stateFile);
  assert.deepEqual(saved.reconcile.retryablePullRequests.map((e) => e.pullRequestId), ['10']);
  assert.equal(saved.reconcile.processedPullRequests.length, 0);
});
