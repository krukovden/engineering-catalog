'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const URL_ = 'https://dev.azure.com/ORG/PROJ/_apis/wit/workitems/1?api-version=7.1';
const forbidden = async () => ({ ok: false, status: 403, text: async () => '{}', headers: { get: () => 'application/json' } });
const AUTH = { header: 'Basic x' };

// [ado.js, the scope text the skill's PAT needs, how that copy takes its fetch]
const COPIES = [
  ['skills/shared/ado-board/scripts/ado.js', 'Work Items (Read & write)', (m, u, method) => m.request(AUTH, method, u, undefined, { fetch: forbidden })],
  ['skills/shared/ado-backlog-placement/scripts/ado.js', 'Work Items (Read & write)', (m, u, method) => m.request(AUTH, method, u, undefined, { fetch: forbidden })],
  ['skills/shared/project-workspace/scripts/ado.js', 'Code (Read)', (m, u, method) => m.request(AUTH, method, u, undefined, { fetch: forbidden })],
  ['skills/shared/catalog-feedback/scripts/ado.js', 'Work Items (Read & write)', (m, u, method) => m.request(AUTH, method, u, undefined, forbidden)],
  ['skills/developers/ado-pr-feedback/scripts/ado.js', 'Code (Read & write), Build (Read) and Work Items (Read)', (m, u, method) => m.request(AUTH, method, u, undefined, forbidden)],
];

for (const [rel, scope, call] of COPIES) {
  test(`${rel}: HTTP 403 says the token cannot do it and names the scope`, async () => {
    const m = require(path.join(ROOT, rel));
    await assert.rejects(call(m, URL_, 'POST'), (e) => {
      assert.match(e.message, /the token can sign in but is not allowed to change this: create a new PAT with /);
      assert.ok(e.message.endsWith(`create a new PAT with ${scope}`), e.message);
      return true;
    });
    await assert.rejects(call(m, URL_, 'GET'), /not allowed to read this/);
  });
}

test('the PowerShell request helper maps 403 to the plain message, and publish still releases the receipt', () => {
  const fs = require('fs');
  const common = fs.readFileSync(path.join(ROOT, 'skills/qa/qa-ado-work-item/scripts/common.ps1'), 'utf8');
  assert.match(common, /\$status -eq 403/);
  assert.match(common, /the token can sign in but is not allowed to .*create a new PAT with Work Items \(Read & write\)/);
  const publish = fs.readFileSync(path.join(ROOT, 'skills/qa/qa-ado-work-item/scripts/publish-work-item.ps1'), 'utf8');
  assert.match(publish, /can sign in but is not allowed/);
});

test('check.sh and check.ps1 word the ok result the same way', () => {
  const fs = require('fs');
  const dir = path.join(ROOT, 'skills/shared/ado-credentials/scripts');
  const tail = 'permissions are checked when a skill first uses them';
  assert.ok(fs.readFileSync(path.join(dir, 'check.sh'), 'utf8').includes(`sign-in works for $org; ${tail}`));
  assert.ok(fs.readFileSync(path.join(dir, 'check.ps1'), 'utf8').includes(`sign-in works for $($context.organization) / $($project.name) as context '$($context.name)'; ${tail}.`));
});
