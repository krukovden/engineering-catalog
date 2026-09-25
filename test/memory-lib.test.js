'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../skills/shared/memory/scripts/memory-lib');

const INDEX = `<!-- memory:index -->\n# proj — memory index\n\nreconciled-sha: abc123\nstore: committed\n\n## Units\n| Unit | Summary |\n|---|---|\n| [[auth]] | Login flow |\n\n## Rejected at project level\n- No ORM (e-20260101-aaaa)\n`;
const UNIT = `<!-- memory:unit auth — chain -->\n# Auth\n\n## Entries\n\n### e-20260101-aaaa Sessions over JWT\n- status: superseded\n- evidence: confirmed\n- pr: 12\n- sha-at-write: 111111\n- merged-sha: 222222\n- supersedes: none\n- superseded-by: e-20260201-bbbb\n- date: 2026-01-01\n\nChose sessions. See [[storage]].\n\n### e-20260201-bbbb JWT after all\n- status: active\n- evidence: inferred\n- pr: none\n- sha-at-write: 333333\n- merged-sha: none\n- supersedes: e-20260101-aaaa\n- superseded-by: none\n- date: 2026-02-01\n\nRequirement changed.\n`;

test('parseIndex', () => {
  const i = m.parseIndex(INDEX);
  assert.equal(i.reconciledSha, 'abc123');
  assert.equal(i.store, 'committed');
  assert.deepEqual(i.units, [{ slug: 'auth', summary: 'Login flow' }]);
  assert.deepEqual(i.rejected, ['No ORM (e-20260101-aaaa)']);
  assert.equal(m.parseIndex('# x\n\nreconciled-sha: none\n').reconciledSha, null);
});

test('parseUnitFile and renderEntry round-trip', () => {
  const u = m.parseUnitFile(UNIT);
  assert.equal(u.slug, 'auth');
  assert.equal(u.entries.length, 2);
  const [a, b] = u.entries;
  assert.equal(a.id, 'e-20260101-aaaa');
  assert.equal(a.title, 'Sessions over JWT');
  assert.equal(a.status, 'superseded');
  assert.equal(a.pr, '12');
  assert.equal(b.pr, null);
  assert.equal(a.supersededBy, 'e-20260201-bbbb');
  assert.deepEqual(a.links, ['storage']);
  assert.equal(a.body, 'Chose sessions. See [[storage]].');
  assert.deepEqual(m.parseUnitFile(m.renderEntry(a)).entries[0], { ...a, links: ['storage'] });
});

test('validateEntry and supersede links both ways', () => {
  const u = m.parseUnitFile(UNIT);
  assert.deepEqual(m.validateEntry(u.entries[0]), []);
  assert.ok(m.validateEntry({ ...u.entries[0], status: 'done' }).some((e) => e.includes('status')));
  assert.deepEqual(m.checkSupersedeLinks([u]), []);
  const broken = m.parseUnitFile(UNIT.replace('- superseded-by: e-20260201-bbbb', '- superseded-by: none'));
  assert.ok(m.checkSupersedeLinks([broken]).some((e) => e.includes('does not name')));
});

test('upsertIndexRow updates only its own row; setReconciledSha', () => {
  const once = m.upsertIndexRow(INDEX, 'billing', 'Invoices');
  assert.ok(once.includes('| [[auth]] | Login flow |') && once.includes('| [[billing]] | Invoices |'));
  const twice = m.upsertIndexRow(once, 'auth', 'Login and SSO');
  assert.ok(twice.includes('| [[auth]] | Login and SSO |') && !twice.includes('Login flow |'));
  assert.ok(m.setReconciledSha(twice, 'deadbeef').includes('reconciled-sha: deadbeef'));
});

test('pending queue and reconciliation arithmetic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-'));
  const f = path.join(dir, '.pending');
  m.writePending(f, ['a', 'b', 'a', 'c']);
  assert.deepEqual(m.readPending(f), ['a', 'b', 'c']);
  assert.deepEqual(m.computeUnrecorded({ pending: ['c', 'a', 'zzz'], reachable: ['a', 'b', 'c'] }), { queued: ['a', 'c'], unqueued: ['b'] });
  assert.match(m.mintEntryId(new Date('2026-09-14T00:00:00Z')), /^e-20260914-[0-9a-f]{4}$/);
});

test('reconcile.js lists unrecorded commits in a real repo and --mark advances', () => {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'first');
  const first = g('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(repo, 'memory/units'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'memory/index.md'), INDEX.replace('abc123', first));
  fs.writeFileSync(path.join(repo, 'a'), '2'); g('add', '.'); g('commit', '-qm', 'second');
  const second = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'memory/.pending'), `${second}\n`);
  const script = path.join(__dirname, '..', 'skills/shared/memory/scripts/reconcile.js');
  const out = JSON.parse(execFileSync('node', [script, '--memory', path.join(repo, 'memory'), '--repo', repo, '--json']).toString());
  assert.deepEqual(out.commits.map((c) => [c.sha, c.subject, c.queued]), [[second, 'second', true]]);
  execFileSync('node', [script, '--memory', path.join(repo, 'memory'), '--repo', repo, '--mark', second]);
  assert.ok(fs.readFileSync(path.join(repo, 'memory/index.md'), 'utf8').includes(`reconciled-sha: ${second}`));
  assert.equal(fs.readFileSync(path.join(repo, 'memory/.pending'), 'utf8').trim(), '');
});

// Regression: parseUnitFile used to split on ANY "### " line, so an H3 heading
// inside an entry body truncated the entry and produced a spurious id:null one.
test('parseUnitFile keeps an H3 heading inside the entry body (regression)', () => {
  const withHeading = UNIT.replace(
    'Chose sessions. See [[storage]].',
    'Chose sessions. See [[storage]].\n\n### Background\nMore context here.',
  );
  const u = m.parseUnitFile(withHeading);
  assert.equal(u.entries.length, 2);
  assert.equal(u.entries[0].id, 'e-20260101-aaaa');
  assert.ok(u.entries[0].body.includes('### Background'));
  assert.ok(u.entries[0].body.includes('More context here.'));
  assert.equal(u.entries[1].id, 'e-20260201-bbbb');
});

// Regression: the field loop used to consume ANY "- key: value" line after the
// header, silently dropping unknown keys instead of leaving them in the body.
test('parseUnitFile stops at the first unrecognised field; it starts the body (regression)', () => {
  const withRisk = UNIT.replace('- date: 2026-01-01\n\nChose sessions.', '- date: 2026-01-01\n- risk: high\n\nChose sessions.');
  const u = m.parseUnitFile(withRisk);
  const a = u.entries[0];
  assert.equal(a.date, '2026-01-01');
  assert.ok(a.body.startsWith('- risk: high'));
  assert.ok(a.body.includes('Chose sessions. See [[storage]].'));
});

// Regression: reconcile.js --mark used to prune .pending against the (possibly
// baseline-less) `reachable` list rather than the new baseline, so pending
// SHAs that were ancestors of --mark (or unreachable from HEAD) were never
// dropped and stayed queued forever.
test('reconcile.js --mark prunes ancestors and unreachable pending when reconciled-sha is none (regression)', () => {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo2-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'first');
  const first = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a'), '2'); g('add', '.'); g('commit', '-qm', 'second');
  const second = g('rev-parse', 'HEAD');
  fs.mkdirSync(path.join(repo, 'memory/units'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'memory/index.md'), INDEX.replace('reconciled-sha: abc123', 'reconciled-sha: none'));
  fs.writeFileSync(path.join(repo, 'memory/.pending'), `${first}\n`);
  const script = path.join(__dirname, '..', 'skills/shared/memory/scripts/reconcile.js');
  execFileSync('node', [script, '--memory', path.join(repo, 'memory'), '--repo', repo, '--mark', second]);
  assert.ok(fs.readFileSync(path.join(repo, 'memory/index.md'), 'utf8').includes(`reconciled-sha: ${second}`));
  assert.equal(fs.readFileSync(path.join(repo, 'memory/.pending'), 'utf8').trim(), '');
});

test('reconcile.js --mark reports reconciled commits apart from those unreachable from HEAD', () => {
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo3-'));
  const g = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).toString().trim();
  g('init', '-q'); fs.writeFileSync(path.join(repo, 'a'), '1'); g('add', '.'); g('commit', '-qm', 'first');
  const first = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a'), '2'); g('add', '.'); g('commit', '-qm', 'second');
  const second = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'a'), '3'); g('add', '.'); g('commit', '-qm', 'third');
  const third = g('rev-parse', 'HEAD');
  const orphan = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
  fs.mkdirSync(path.join(repo, 'memory/units'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'memory/index.md'), INDEX.replace('reconciled-sha: abc123', 'reconciled-sha: none'));
  fs.writeFileSync(path.join(repo, 'memory/.pending'), `${first}\n${second}\n${third}\n${orphan}\n`);
  const script = path.join(__dirname, '..', 'skills/shared/memory/scripts/reconcile.js');
  const out = execFileSync('node', [script, '--memory', path.join(repo, 'memory'), '--repo', repo, '--mark', second]).toString();
  assert.match(out, /^reconciled through .*; 1 still queued$/m);
  assert.match(out, new RegExp(`^reconciled: ${first.slice(0, 12)} ${second.slice(0, 12)}$`, 'm'));
  assert.match(out, new RegExp(`^unreachable from HEAD: ${orphan.slice(0, 12)}$`, 'm'));
  assert.ok(!out.includes('stale'));
  assert.equal(fs.readFileSync(path.join(repo, 'memory/.pending'), 'utf8').trim(), third);
});
