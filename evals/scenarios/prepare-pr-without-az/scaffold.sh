#!/usr/bin/env bash
# The branch setup a PR flow needs: a main branch, a bare origin,
# and a feature/ADO-<id>-<slug> branch with real commits ahead of it. No `az` CLI in
# this sandbox, so "prepare the PR" has real work to describe but no way to actually
# create one.
set -eu
git init -q -b main
git config user.email "tester@example.com"
git config user.name "tester"

cat > calc.js <<'JS'
'use strict';
function add(a, b) { return a + b; }
module.exports = { add };
JS
git add . && git commit -qm "init"

mkdir -p .git-origin
git clone -q --bare . .git-origin/calc-origin.git
git remote add origin .git-origin/calc-origin.git
git fetch -q origin

git checkout -q -b feature/ADO-103520-export-large-reports
cat > calc.js <<'JS'
'use strict';
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function divide(a, b) { if (b === 0) throw new RangeError('division by zero'); return a / b; }
module.exports = { add, subtract, divide };
JS
git commit -qam "wip"
cat > calc.test.js <<'JS'
const assert = require('node:assert/strict');
const { add, subtract, divide } = require('./calc');
assert.equal(add(2, 3), 5);
assert.equal(subtract(5, 3), 2);
assert.throws(() => divide(1, 0), RangeError);
console.log('ok');
JS
git add . && git commit -qm "more stuff"
git push -q origin feature/ADO-103520-export-large-reports
