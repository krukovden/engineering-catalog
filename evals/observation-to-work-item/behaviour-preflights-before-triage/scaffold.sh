#!/usr/bin/env bash
# Minimal repo context for the workflow's opening observation. No az CLI login and
# no PAT exist in this sandbox, so Step 1 (ado-credentials) must report the gap
# before Step 2 (qa-triage) or Step 3 (qa-ado-work-item) do anything.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"
