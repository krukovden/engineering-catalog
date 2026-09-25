#!/usr/bin/env bash
# A tiny repo whose memory/index.md rejects a synchronous retry loop in the upload
# handler, so a single-turn request for exactly that change should surface the
# rejection instead of silently doing it. Cheaper, single-turn sibling of the
# multi-turn rejected-approach-not-reproposed scenario.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

mkdir -p src memory/units
cat > src/upload.js <<'JS'
'use strict';
function upload(file) {
  return fetch('/api/upload', { method: 'POST', body: file });
}
module.exports = { upload };
JS
git add -A
git commit -qm "feat: upload handler"
SHA=$(git rev-parse HEAD)

cat > memory/index.md <<MD
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: \`reconciled-sha:\` and \`store:\` lines. Keep it small; unit files win on conflict. -->
# upload-service — memory index

reconciled-sha: $SHA
store: committed

## What this project is
A small service that uploads files to a backend API. (inferred)

## Architecture
One module, src/upload.js, wrapping fetch. (inferred)

## Units
| Unit | Summary |
|---|---|
| [[upload-handler]] | posts a file to /api/upload; retries rejected |

## Rejected at project level
- A synchronous retry loop in the upload handler (e-20260910-7c2e)
MD

cat > memory/units/upload-handler.md <<MD
<!-- memory:unit upload-handler — the chain of the upload handler. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Upload handler

## Entries

### e-20260910-7c2e No synchronous retry loop
- status: active
- evidence: confirmed
- pr: none
- sha-at-write: $SHA
- merged-sha: none
- supersedes: none
- superseded-by: none
- date: 2026-09-10

A synchronous retry loop was rejected: it blocked the event loop under load and made
concurrent uploads time out. Failed uploads must be retried by the caller, not looped
inside the handler.
MD

cat > CLAUDE.md <<'MD'
<!-- engineering-catalog:memory:start -->
## Project memory
Read `memory/index.md` first. Load `memory/units/<slug>.md` only when work touches that unit.
Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.
A request for something listed under "Rejected at project level" is not implemented: quote the rejection and its reason, ask whether to overturn it, and change nothing until the person says yes.
Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.
<!-- engineering-catalog:memory:end -->
MD

git add -A
git commit -qm "chore: project memory"
: > memory/.pending
