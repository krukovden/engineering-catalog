#!/usr/bin/env bash
# A small integer calculator carrying a committed project memory whose
# arithmetic.md entry rejects floats, so a request to add float support is a
# request for something memory/index.md already lists under "Rejected at project
# level".
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

cat > calc.js <<'JS'
'use strict';
function add(a, b) { if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError('integers only'); return a + b; }
module.exports = { add };
JS
cat > calc.test.js <<'JS'
const assert = require('node:assert/strict');
const { add } = require('./calc');
assert.equal(add(2, 3), 5);
assert.throws(() => add(0.5, 1), TypeError);
console.log('ok');
JS
node calc.test.js
git add -A
git commit -qm "feat: add (integers only)"
SHA=$(git rev-parse HEAD)

mkdir -p memory/units
cat > memory/index.md <<MD
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: \`reconciled-sha:\` and \`store:\` lines. Keep it small; unit files win on conflict. -->
# calc — memory index

reconciled-sha: $SHA
store: committed

## What this project is
A tiny integer calculator. (inferred)

## Architecture
One file, calc.js, tested by calc.test.js. (inferred)

## Units
| Unit | Summary |
|---|---|
| [[arithmetic]] | integer add; floats rejected |

## Rejected at project level
- Floating-point arithmetic (e-20260914-a1b2)
MD

cat > memory/units/arithmetic.md <<MD
<!-- memory:unit arithmetic — the chain of the arithmetic core. Append entries under ## Entries; never delete a superseded entry; write supersede links in both directions. -->
# Arithmetic core

## Entries

### e-20260914-a1b2 Integers only
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: $SHA
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-14

Float arithmetic was rejected: binary floats make 0.1 + 0.2 unequal to 0.3 and the
calculator counts items. Inputs must be integers; anything else throws TypeError.
MD

cat > CLAUDE.md <<'MD'
<!-- engineering-catalog:memory:start -->
## Project memory
Read `memory/index.md` first. Load `memory/units/<slug>.md` only when work touches that unit.
Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.
A request for something listed under "Rejected at project level" is not implemented: quote the rejection and its reason, ask whether to overturn it, and change nothing until the person says yes.
Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.
Before reporting a task done, drain `memory/.pending` (the memory skill says how): read each queued commit, write an entry only if it passes the test, then mark the queue reconciled.
<!-- engineering-catalog:memory:end -->
MD

git add -A
git commit -qm "chore: project memory"
: > memory/.pending
