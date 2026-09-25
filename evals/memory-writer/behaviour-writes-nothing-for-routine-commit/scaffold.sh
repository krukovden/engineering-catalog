#!/usr/bin/env bash
# Same shape as the real-tradeoff case, but the queued commit is routine: a pure
# rename plus a comment explaining it, reversible with a trivial revert and
# already self-explanatory from the diff. memory-writer should write nothing for
# it, not pad the record with an entry that only restates the rename.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

cat > cache.js <<'JS'
'use strict';
const store = new Map();
function get(key) { return store.get(key); }
function set(key, value) { store.set(key, value); }
module.exports = { get, set };
JS
git add -A
git commit -qm "feat: in-memory cache"
FIRST_SHA=$(git rev-parse HEAD)

mkdir -p memory/units
cat > memory/index.md <<MD
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: \`reconciled-sha:\` and \`store:\` lines. Keep it small; unit files win on conflict. -->
# cache-service — memory index

reconciled-sha: $FIRST_SHA
store: committed

## What this project is
A tiny in-memory key/value cache. (inferred)

## Architecture
One file, cache.js. (inferred)

## Units
| Unit | Summary |
|---|---|
| [[cache]] | in-memory cache storage |

## Rejected at project level
- (none recorded)
MD

cat > memory/units/cache.md <<MD
<!-- memory:unit cache — the chain of the cache storage approach. Append entries under ## Entries; never delete a superseded entry; write supersede links in both directions. -->
# Cache storage

## Entries

### e-20260908-cc01 Plain Map storage
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: $FIRST_SHA
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-08

Started with a plain Map: the simplest thing that could work for the first caller.
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
git commit -qm "chore: init project memory"

cat > cache.js <<'JS'
'use strict';
// renamed `store` to `entries` for clarity — no behavior change
const entries = new Map();
function get(key) { return entries.get(key); }
function set(key, value) { entries.set(key, value); }
module.exports = { get, set };
JS
git commit -qam "refactor: rename internal store variable to entries

Pure rename for readability, no behavior change."
SECOND_SHA=$(git rev-parse HEAD)
echo "$SECOND_SHA" > memory/.pending
