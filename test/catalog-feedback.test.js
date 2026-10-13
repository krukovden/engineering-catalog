'use strict';
require('./temp-cleanup');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const feedback = require('../skills/shared/catalog-feedback/scripts/feedback.js');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('buildPreview attaches platform and receipt version automatically', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-cwd-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-home-'));
  write(path.join(cwd, '.engineering-catalog', 'receipt.json'), JSON.stringify({
    schema: 1,
    installs: [{ target: 'copilot', scope: 'local', catalogVersion: '1.0.6', source: 'https://github.com/krukovden/engineering-catalog' }],
  }));
  const preview = feedback.buildPreview(
    { org: feedback.DEFAULT_ORG, project: feedback.DEFAULT_PROJECT, type: 'Task', cwd, home },
    { unit: 'catalog-doctor', title: 'Doctor warning should cite the path', details: 'The warning is correct, but the fix should cite the exact config file.' },
    { COPILOT_PROJECT_DIR: cwd },
  );
  assert.equal(preview.platform, 'copilot');
  assert.equal(preview.receiptVersion, '1.0.6');
  assert.match(preview.fields.description, /<strong>Unit<\/strong>: catalog-doctor/);
  assert.match(preview.fields.description, /<strong>Receipt version<\/strong>: 1\.0\.6/);
  assert.match(preview.fields.tags, /unit:catalog-doctor/);
});

test('commit refuses when the approved hash no longer matches', async () => {
  await assert.rejects(
    feedback.commit(
      { org: feedback.DEFAULT_ORG, project: feedback.DEFAULT_PROJECT, type: 'Task', cwd: process.cwd(), home: os.homedir(), approvedHash: 'deadbeefdeadbeef' },
      { unit: 'memory', title: 'Title', details: 'Details' },
      {},
      async () => { throw new Error('should not post'); },
    ),
    /does not match current draft/,
  );
});

test('commit posts a task to the configured Azure DevOps project', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        id: 4123,
        fields: { 'System.WorkItemType': 'Task', 'System.Title': 'Feedback title', 'System.State': 'New' },
        _links: { html: { href: 'https://dev.azure.com/Contoso/Platform/_workitems/edit/4123' } },
      }),
      headers: new Map([['content-type', 'application/json']]),
    };
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-home-'));
  const args = { org: feedback.DEFAULT_ORG, project: feedback.DEFAULT_PROJECT, type: 'Task', cwd: home, home };
  const preview = feedback.buildPreview(args, { unit: 'catalog-feedback', title: 'Feedback title', details: 'Details' }, {});
  const result = await feedback.commit({ ...args, approvedHash: preview.draftHash }, { unit: 'catalog-feedback', title: 'Feedback title', details: 'Details' }, { ADO_PAT: 'secret' }, fakeFetch);
  assert.equal(result.id, 4123);
  assert.match(calls[0].url, /Platform\/_apis\/wit\/workitems\/\$Task/);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(String(calls[0].init.body), /System\.Description/);
});

function draftArgs() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-home-'));
  const args = { org: feedback.DEFAULT_ORG, project: feedback.DEFAULT_PROJECT, type: 'Task', cwd: home, home };
  const draft = { unit: 'catalog-feedback', title: 'Feedback title', details: 'Details' };
  return { args: { ...args, approvedHash: feedback.buildPreview(args, draft, {}).draftHash }, draft };
}

const created = async () => ({
  ok: true, status: 200, headers: new Map([['content-type', 'application/json']]),
  text: async () => JSON.stringify({ id: 4123, _links: { html: { href: 'https://x/_workitems/edit/4123' } } }),
});

test('commit never files the same approved draft twice', async () => {
  const { args, draft } = draftArgs();
  let posts = 0;
  const f = async (...a) => { posts++; return created(...a); };
  await feedback.commit(args, draft, { ADO_PAT: 'secret' }, f);
  const again = await feedback.commit(args, draft, { ADO_PAT: 'secret' }, f);
  assert.equal(posts, 1);
  assert.equal(again.mode, 'ALREADY-PUBLISHED');
  assert.equal(again.id, 4123);
});

test('commit keeps the receipt when the outcome is unknown and refuses the retry', async () => {
  const { args, draft } = draftArgs();
  let posts = 0;
  const lost = async () => { posts++; throw new Error('socket hang up'); };
  await assert.rejects(feedback.commit(args, draft, { ADO_PAT: 'secret' }, lost), /socket hang up.*check the board/);
  await assert.rejects(feedback.commit(args, draft, { ADO_PAT: 'secret' }, created), /may have created the item/);
  assert.equal(posts, 1);
});

test('commit releases the receipt after a definitive rejection, so a fixed retry can post', async () => {
  const { args, draft } = draftArgs();
  const rejected = async () => ({ ok: false, status: 400, headers: new Map(), text: async () => '' });
  await assert.rejects(feedback.commit(args, draft, { ADO_PAT: 'secret' }, rejected), /HTTP 400/);
  const ok = await feedback.commit(args, draft, { ADO_PAT: 'secret' }, created);
  assert.equal(ok.mode, 'COMMITTED');
});
