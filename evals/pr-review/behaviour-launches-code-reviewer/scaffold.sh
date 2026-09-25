#!/usr/bin/env sh
# A small branch ahead of main with an obvious diff, so pr-review has something
# real to hand the reviewer.
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

git checkout -q -b feature/ADO-103520-export-large-reports
cat > calc.js <<'JS'
'use strict';
function add(a, b) { return a + b; }
function subtract(a, b) { return a - b; }
function divide(a, b) { if (b === 0) throw new RangeError('division by zero'); return a / b; }
module.exports = { add, subtract, divide };
JS
git commit -qam "add subtract and divide"
