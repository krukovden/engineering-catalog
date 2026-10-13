'use strict';
require('./temp-cleanup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'skills/developers/ado-pr-feedback/scripts');
const FIX = path.join(__dirname, 'fixtures/ado-pr-feedback');
const fx = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const json = (n) => JSON.parse(fx(n));
const fe = require(path.join(DIR, 'failure-extraction.js'));
const ado = require(path.join(DIR, 'ado.js'));
const th = require(path.join(DIR, 'threads.js'));
const ci = require(path.join(DIR, 'ci-failures.js'));

test('classifyFailure: the four kinds', () => {
  assert.equal(fe.classifyFailure(fx('log-test.txt')).kind, 'test');
  assert.equal(fe.classifyFailure(fx('log-typecheck.txt')).kind, 'typecheck');
  assert.equal(fe.classifyFailure(fx('log-lint.txt')).kind, 'lint');
  assert.equal(fe.classifyFailure(fx('log-build.txt')).kind, 'build');
});

test('classifyFailure: strips ANSI, other test runners and coverage count as test', () => {
  assert.ok(!fe.classifyFailure(fx('log-test.txt')).block.includes('\u001b'));
  assert.equal(fe.classifyFailure('Failed!  - Failed: 2, Passed: 9').kind, 'test');
  assert.equal(fe.classifyFailure('FAILED tests/test_a.py::test_x - assert 1').kind, 'test');
  assert.equal(fe.classifyFailure('Coverage threshold for lines (80%) not met').kind, 'test');
});

test('extractGenericBlock: windows around ##[error], dedups, falls back to the tail', () => {
  const lines = ['a', 'b', 'c', 'd', '##[error]boom', 'e', 'f', 'g'];
  assert.deepEqual(fe.extractGenericBlock(lines), ['b', 'c', 'd', '##[error]boom', 'e', 'f']);
  assert.deepEqual(fe.extractGenericBlock(['##[error]Process completed with exit code 1']), ['##[error]Process completed with exit code 1']);
  const long = Array.from({ length: 40 }, (_, i) => 'l' + i);
  assert.equal(fe.extractGenericBlock(long).length, 20);
});

test('boundBlock caps lines and flags truncation', () => {
  assert.deepEqual(fe.boundBlock('a\nb', 5), { block: 'a\nb', truncated: false });
  assert.deepEqual(fe.boundBlock('a\nb\nc', 2), { block: 'a\nb', truncated: true });
});

test('failingBuilds: rejected/broken build policies, deduplicated, no buildId skipped', () => {
  assert.deepEqual(ci.failingBuilds(json('policy-evaluations.json')), [
    { buildId: 9001, policy: 'CI', status: 'rejected' },
    { buildId: 9003, policy: 'Build', status: 'broken' },
  ]);
  assert.deepEqual(ci.failingBuilds(null), []);
});

test('failedRecords: leaf failures only, errors from issues[]', () => {
  const r = ci.failedRecords(json('timeline.json'));
  assert.deepEqual(r.map((x) => x.name), ['Run unit tests', 'Compile']);
  assert.deepEqual(r[0].issues, ['Command failed with exit code 1']);
  assert.equal(r[0].logId, 7);
  assert.equal(r[1].logId, null);
});

test('classifyRecord: log first, then issues[], then step name', () => {
  const [t, c] = ci.failedRecords(json('timeline.json'));
  assert.equal(ci.classifyRecord(t, fx('log-test.txt')).kind, 'test');
  assert.equal(ci.classifyRecord(c, '').kind, 'typecheck');
  assert.equal(ci.classifyRecord({ name: 'ESLint', issues: [] }, '').kind, 'lint');
  assert.equal(ci.classifyRecord({ name: 'Publish', issues: [] }, '').kind, 'build');
  assert.equal(ci.classifyRecord({ name: 'Run unit tests', issues: [] }, '##[error]x').kind, 'test');
});

test('humanSummary', () => {
  assert.match(ci.humanSummary({ pr: 1, builds: [] }), /no failing build/);
  const out = ci.humanSummary({ pr: 1, builds: [{ buildId: 9, policy: 'CI', failures: [{ kind: 'lint', step: 'Lint', issues: ['bad'] }] }] });
  assert.match(out, /\[lint\] Lint: bad/);
});

test('simplifyThreads: drops deleted and system-only threads; resolved only with includeResolved', () => {
  const open = th.simplifyThreads(json('threads.json'));
  assert.deepEqual(open.map((t) => t.id), [11, 15]);
  assert.equal(open[0].file, '/src/Export.cs');
  assert.equal(open[0].line, 88);
  assert.equal(open[0].comments.length, 2);
  assert.equal(open[1].file, null);
  assert.deepEqual(th.simplifyThreads(json('threads.json'), { includeResolved: true }).map((t) => t.id), [11, 12, 15]);
});

test('statusPayload and replyPayload validate', () => {
  assert.deepEqual(th.statusPayload('wontFix'), { status: 'wontFix' });
  assert.throws(() => th.statusPayload('active'), /status must be/);
  assert.equal(th.replyPayload('Fixed in abc').parentCommentId, 1);
  assert.throws(() => th.replyPayload('  '), /empty/);
  assert.throws(() => th.requireApproved({}), /--approved/);
});

test('ado helpers: auth, configure parsing, context, url', () => {
  assert.equal(ado.basicAuthHeader('x'), 'Basic ' + Buffer.from(':x').toString('base64'));
  assert.equal(ado.resolveAuth({ ADO_PAT: 'p' }).source, 'ADO_PAT');
  assert.equal(ado.resolveAuth({}, () => 'tok\n').header, 'Bearer tok');
  assert.throws(() => ado.resolveAuth({}, () => { throw new Error('no az'); }), /no credential/);
  assert.deepEqual(ado.parseConfigureList('[defaults]\norganization = https://dev.azure.com/o\nproject = P\n'), { organization: 'https://dev.azure.com/o', project: 'P' });
  const cfg = { activeContext: 'b', contexts: [{ name: 'a', organization: 'oa', project: 'pa' }, { name: 'b', organization: 'ob', project: 'pb' }] };
  assert.deepEqual(ado.pickContext(cfg), { organization: 'ob', project: 'pb' });
  assert.deepEqual(ado.pickContext(cfg, 'a'), { organization: 'oa', project: 'pa' });
  assert.equal(ado.pickContext(cfg, 'zz'), null);
  assert.deepEqual(ado.resolveContext({ org: 'https://x/o/', project: 'P' }, {}), { org: 'https://x/o', project: 'P' });
  assert.equal(ado.apiUrl('https://x/o/', '_apis/a', { k: 'v' }), 'https://x/o/_apis/a?api-version=7.1&k=v');
  assert.equal(ado.apiUrl('https://x/o/t', ''), 'https://x/o/t?api-version=7.1');
});

// End to end over a recorded, offline fetch.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return { ok: false, status: 404, text: async () => '', headers: new Map() };
    const v = routes[key];
    return { ok: true, status: 200, text: async () => v, headers: new Map([['content-type', v.trim().startsWith('{') ? 'application/json' : 'text/plain']]) };
  };
  f.calls = calls;
  return f;
}

test('ci-failures run: policy → timeline → log → classified JSON', async () => {
  const f = fakeFetch({
    '/_apis/git/pullrequests/4821': fx('pull-request.json'),
    '/_apis/policy/evaluations': JSON.stringify({ value: [json('policy-evaluations.json').value[0]] }),
    '/builds/9001/timeline': fx('timeline.json'),
    '/builds/9001/logs/7': fx('log-test.txt'),
  });
  const out = await ci.run(['--pr', '4821', '--org', 'https://dev.azure.com/o', '--project', 'Acme'], { ADO_PAT: 'secret' }, f);
  assert.equal(out.builds.length, 1);
  assert.deepEqual(out.builds[0].failures.map((x) => x.kind), ['test', 'typecheck']);
  assert.ok(f.calls.every((c) => !c.url.includes('secret')));
  assert.match(f.calls.find((c) => c.url.includes('evaluations')).url, /artifactId=vstfs%3A%2F%2F%2FCodeReview%2FCodeReviewId%2Fproj-guid%2F4821/);
});

test('ci-failures run: log fetch errors stay visible as partial evidence', async () => {
  const f = fakeFetch({
    '/_apis/git/pullrequests/4821': fx('pull-request.json'),
    '/_apis/policy/evaluations': JSON.stringify({ value: [json('policy-evaluations.json').value[0]] }),
    '/builds/9001/timeline': fx('timeline.json'),
  });
  const out = await ci.run(['--pr', '4821', '--org', 'https://dev.azure.com/o', '--project', 'Acme'], { ADO_PAT: 'secret' }, f);
  assert.equal(out.partial, true);
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0].message, /HTTP 404/);
  assert.equal(out.errors[0].buildId, 9001);
  assert.equal(out.errors[0].logId, 7);
  assert.match(ci.humanSummary(out), /NOTE: evidence is partial/);
  assert.match(ci.humanSummary(out), /log 7 unavailable/);
});

test('threads run: list reads, writes need --approved and PATCH/POST the right routes', async () => {
  const f = fakeFetch({
    '/_apis/git/pullrequests/4821': fx('pull-request.json'),
    '/threads/11/comments': '{"id":3}',
    '/threads/11': '{"id":11,"status":"fixed"}',
    '/threads': fx('threads.json'),
  });
  const env = { ADO_PAT: 'p' };
  const base = ['--pr', '4821', '--org', 'https://dev.azure.com/o', '--project', 'Acme'];
  const listed = await th.run(['list', ...base], env, f);
  assert.deepEqual(listed.threads.map((t) => t.id), [11, 15]);
  await assert.rejects(th.run(['set-status', ...base, '--thread', '11', '--status', 'fixed'], env, f), /--approved/);
  assert.equal(f.calls.filter((c) => c.method !== 'GET').length, 0);
  const s = await th.run(['set-status', ...base, '--thread', '11', '--status', 'fixed', '--approved'], env, f);
  assert.equal(s.status, 'fixed');
  const r = await th.run(['reply', ...base, '--thread', '11', '--text', 'Fixed in abc', '--approved'], env, f);
  assert.equal(r.commentId, 3);
  const [patch, post] = f.calls.filter((c) => c.method !== 'GET');
  assert.equal(patch.method, 'PATCH');
  assert.match(patch.url, /repositories\/repo-guid\/pullRequests\/4821\/threads\/11\?/);
  assert.equal(post.method, 'POST');
  assert.match(post.body, /Fixed in abc/);
});

test('ci-failures run: a missing timeline is partial evidence, not a crash, and later builds still load', async () => {
  const two = json('policy-evaluations.json').value[0];
  const second = JSON.parse(JSON.stringify(two));
  second.context.buildId = 9002;
  const f = fakeFetch({
    '/_apis/git/pullrequests/4821': fx('pull-request.json'),
    '/_apis/policy/evaluations': JSON.stringify({ value: [second, two] }),
    '/builds/9001/timeline': fx('timeline.json'),
    '/builds/9001/logs/7': fx('log-test.txt'),
  });
  const out = await ci.run(['--pr', '4821', '--org', 'https://dev.azure.com/o', '--project', 'Acme'], { ADO_PAT: 'secret' }, f);
  assert.equal(out.partial, true);
  assert.deepEqual(out.builds.map((b) => b.buildId), [9002, 9001]);
  assert.match(out.builds[0].timelineError, /HTTP 404/);
  assert.equal(out.builds[1].failures.length, 2);
  assert.match(ci.humanSummary(out), /timeline unavailable/);
});

test('SKILL.md: a thread is not marked fixed until the fix is pushed and contained in the PR source branch', () => {
  const md = fs.readFileSync(path.join(DIR, '..', 'SKILL.md'), 'utf8');
  const step = md.slice(md.indexOf('## Step 5'), md.indexOf('## Scripts'));
  assert.doesNotMatch(step, /push if the user/i);
  assert.match(step, /never answered "fixed"/);
  assert.match(step, /git ls-remote/);
  assert.match(step, /merge-base --is-ancestor/);
  assert.match(step, /declines to push[\s\S]*do\s+\*\*not\*\*\s+reply "fixed"[\s\S]*do\s+\*\*not\*\*\s+resolve/);
});
