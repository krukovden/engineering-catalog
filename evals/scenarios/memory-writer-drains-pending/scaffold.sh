#!/usr/bin/env bash
# A tiny project with real project memory already initialized (index.md, one unit
# file with one entry, a CLAUDE.md pointer block) plus one commit memory has not
# caught up with yet — its sha sits in memory/.pending, exactly as the post-commit
# hook would leave it. The commit is a real, self-contained decision (fixed-count
# retries were causing a thundering herd; switched to backoff+jitter) so the
# write-test judgment in the llm grader has something real to check.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

cat > retry.js <<'JS'
'use strict';
function retry(fn, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try { return fn(); } catch (e) { if (i === attempts - 1) throw e; }
  }
}
module.exports = { retry };
JS
git add -A
git commit -qm "feat: retry with a fixed attempt count"
FIRST_SHA=$(git rev-parse HEAD)

mkdir -p memory/units
cat > memory/index.md <<MD
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: \`reconciled-sha:\` and \`store:\` lines. Keep it small; unit files win on conflict. -->
# retry-service — memory index

reconciled-sha: $FIRST_SHA
store: committed

## What this project is
A tiny module that retries a failing operation. (inferred)

## Architecture
One file, retry.js. (inferred)

## Units
| Unit | Summary |
|---|---|
| [[retry]] | retry policy for a failing operation |

## Rejected at project level
- (none recorded)
MD

cat > memory/units/retry.md <<MD
<!-- memory:unit retry — the chain of the retry policy. Append entries under ## Entries; never delete a superseded entry; write supersede links in both directions. -->
# Retry policy

## Entries

### e-20260910-aa11 Fixed attempt count
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: $FIRST_SHA
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-10

Started with a fixed 3-attempt retry: the simplest thing that could work for the
first caller.
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

cat > retry.js <<'JS'
'use strict';
function retry(fn, { attempts = 5, baseDelayMs = 50 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try { return fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      const jitter = Math.random() * baseDelayMs;
      void (baseDelayMs * 2 ** i + jitter); // a real caller would await a timer here
    }
  }
}
module.exports = { retry };
JS
git commit -qam "fix: switch retry to exponential backoff with jitter

Fixed-count retries with no delay meant every client hammered the
dependency at the same instant during the last outage (thundering herd).
Backoff with jitter spreads retries out; it is hard to reverse because
callers now assume delayed retries, not instant ones."
SECOND_SHA=$(git rev-parse HEAD)
echo "$SECOND_SHA" > memory/.pending
