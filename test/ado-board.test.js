'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  discoverStates,
  moveWorkItem,
  reconcileBoard,
  parseBranchWorkItem,
} = require('../skills/shared/ado-board/scripts/lib');

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

class FakeTransport {
  constructor({ items = {}, prs = [], activeIds = [], types = [], states = {}, failMove = null } = {}) {
    this.items = new Map(Object.entries(items).map(([id, item]) => [String(id), structuredClone(item)]));
    this.prs = prs;
    this.activeIds = activeIds.map(String);
    this.types = types;
    this.states = states;
    this.failMove = failMove;
    this.moves = [];
  }

  async listWorkItemTypes() {
    return this.types;
  }

  async listWorkItemStates(_context, typeName) {
    return this.states[typeName] || [];
  }

  async getWorkItem(_context, id) {
    const item = this.items.get(String(id));
    if (!item) throw new Error(`unknown work item ${id}`);
    return structuredClone(item);
  }

  async moveWorkItemState(_context, { id, rev, state, comment }) {
    if (this.failMove) throw this.failMove;
    const key = String(id);
    const item = this.items.get(key);
    item.rev = rev + 1;
    item.fields['System.State'] = state;
    this.moves.push({ id: key, state, comment });
    return structuredClone(item);
  }

  async listCompletedPullRequests() {
    return structuredClone(this.prs);
  }

  async listTrackedItemsInBuckets() {
    return this.activeIds.map((id) => structuredClone(this.items.get(String(id))));
  }
}

function createRepo() {
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-remote-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-board-repo-'));
  git(remote, 'init', '--bare', '--initial-branch=main');
  git(repo, 'init', '--initial-branch=main');
  fs.writeFileSync(path.join(repo, 'README.md'), 'root\n');
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-u', 'origin', 'main');
  return { repo, remote };
}

function createPushedBranch(repo, branchName, fileName, content) {
  git(repo, 'checkout', '-b', branchName);
  fs.writeFileSync(path.join(repo, fileName), `${content}\n`);
  git(repo, 'add', fileName);
  git(repo, 'commit', '-m', `add ${fileName}`);
  git(repo, 'push', '-u', 'origin', branchName);
  git(repo, 'checkout', 'main');
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

test('discover writes the project state map and records ambiguous choices', async () => {
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
  assert.deepEqual(result.resolved, [{
    type: 'Product Backlog Item',
    bucket: 'todo',
    category: 'Proposed',
    chosen: 'Approved',
    options: ['New', 'Approved'],
    via: 'flag',
  }]);
  const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.stateMap['Product Backlog Item'].todo, 'Approved');
  assert.equal(saved.stateMap.Bug.verify, 'Resolved');
  assert.equal(saved.stateMap.Bug.removed, 'Removed');
});

test('move refuses backwards movement and names a required field on transition refusal', async () => {
  const stateMap = {
    Task: {
      todo: 'New',
      doing: 'Active',
      verify: 'Resolved',
      done: 'Closed',
    },
  };

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
      failMove: new Error("Field 'Microsoft.VSTS.Common.ResolvedReason' must be set."),
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
    field: 'Microsoft.VSTS.Common.ResolvedReason',
    message: "Field 'Microsoft.VSTS.Common.ResolvedReason' must be set.",
  });
});

test('reconcile is idempotent, leaves idp cards untouched, and sends Bugs to verify', async () => {
  const { repo } = createRepo();
  createPushedBranch(repo, 'feature/ADO-101-catalog-sync', 'feature.txt', 'feature work');
  createPushedBranch(repo, 'feature/ADO-202-runner-only', 'runner.txt', 'runner work');
  createPushedBranch(repo, 'chore/no-ticket', 'chore.txt', 'untracked');
  git(repo, 'fetch', 'origin');

  const stateMap = {
    'Product Backlog Item': { todo: 'New', doing: 'Committed', done: 'Done' },
    Bug: { todo: 'New', doing: 'Active', verify: 'Resolved', done: 'Closed' },
  };
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
      202: {
        id: 202,
        rev: 1,
        fields: {
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'New',
          'System.Tags': 'idp:claimed',
          'System.Title': 'Runner-owned item',
        },
      },
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
      workItemRefs: [{ id: 303 }],
    }],
  });

  const first = await reconcileBoard({
    transport,
    context: {},
    stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(first.changed.map((entry) => ({ id: entry.id, from: entry.from, to: entry.to, reason: entry.reason })), [
    { id: '101', from: 'todo', to: 'doing', reason: 'branch-pushed' },
    { id: '303', from: 'doing', to: 'verify', reason: 'completed-pr' },
  ]);
  assert.equal(transport.items.get('101').fields['System.State'], 'Committed');
  assert.equal(transport.items.get('202').fields['System.State'], 'New');
  assert.equal(transport.items.get('303').fields['System.State'], 'Resolved');
  assert.deepEqual(first.report.untrackedBranches.map((entry) => entry.branch), ['origin/chore/no-ticket']);

  const second = await reconcileBoard({
    transport,
    context: {},
    stateMap,
    cwd: repo,
    staleDays: 30,
    throttleHours: 0,
  });

  assert.deepEqual(second.changed, []);
  assert.equal(second.report.untrackedBranches.length, 1);
});
