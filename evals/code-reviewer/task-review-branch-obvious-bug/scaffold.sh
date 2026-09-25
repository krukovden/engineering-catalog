#!/usr/bin/env sh
# A small branch ahead of main with one obvious, findable bug: divide() does not
# guard against division by zero even though the sibling functions do input
# validation, and the new caller in report.js passes a value that can legally be 0.
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

git checkout -q -b feature/ADO-103520-average-report
cat > calc.js <<'JS'
'use strict';
function add(a, b) { return a + b; }
function average(values) {
  // BUG: no guard for values.length === 0, divides by zero
  const total = values.reduce((sum, v) => sum + v, 0);
  return total / values.length;
}
module.exports = { add, average };
JS
cat > report.js <<'JS'
'use strict';
const { average } = require('./calc');

function summarize(entries) {
  // entries can legally be an empty array when a report has no rows yet
  const values = entries.map((e) => e.amount);
  return { count: entries.length, average: average(values) };
}
module.exports = { summarize };
JS
git add . && git commit -qm "add average report summary"
