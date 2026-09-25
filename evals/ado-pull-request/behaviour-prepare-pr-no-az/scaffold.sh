#!/usr/bin/env sh
# A condensed PR flow: a main branch, a bare origin, and a
# feature/ADO-<id>-<slug> branch ahead of it with a real commit. No `az` CLI in this
# sandbox, so ado-credentials cannot report "ok" and the PR cannot actually be created.
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
module.exports = { add, subtract };
JS
git commit -qam "add subtract"
