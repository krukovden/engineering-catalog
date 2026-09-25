#!/usr/bin/env bash
# A project that already has a project-memory folder, so the model can notice it via
# Glob/Read before proposing anything (the memory skill's own trigger condition).
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

mkdir -p src memory/units
cat > src/upload.js <<'JS'
'use strict';
function upload(file) { return fetch('/api/upload', { method: 'POST', body: file }); }
module.exports = { upload };
JS

cat > memory/index.md <<'MD'
<!-- memory:index — what this project is, its architecture, one row per unit, project-level rejections.
     Machine-read fields: `reconciled-sha:` and `store:` lines. Keep it small; unit files win on conflict. -->
# upload-service — memory index

reconciled-sha: none
store: committed

## What this project is
A small service that uploads files to a backend API. (inferred)

## Architecture
One module, src/upload.js, wrapping fetch. (inferred)

## Units
| Unit | Summary |
|---|---|
| [[upload-handler]] | posts a file to /api/upload |

## Rejected at project level
- none yet
MD

cat > memory/units/upload-handler.md <<'MD'
<!-- memory:unit upload-handler — the chain of the upload handler. Append entries under ## Entries;
     never delete a superseded entry; write supersede links in both directions. -->
# Upload handler

## Entries

This predates tracking; history before 2026-09-01 is not recorded.
MD

cat > CLAUDE.md <<'MD'
<!-- engineering-catalog:memory:start -->
## Project memory
Read `memory/index.md` first. Load `memory/units/<slug>.md` only when work touches that unit.
Write an entry only when the change is hard to reverse, not obvious without context, and the result of a real trade-off — all three.
Unit files win over the index. Update only your own index row. Never record credentials, personal data or session narrative.
<!-- engineering-catalog:memory:end -->
MD

git add -A
git commit -qm "feat: upload handler"
