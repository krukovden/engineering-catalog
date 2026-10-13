#!/usr/bin/env bash
# Minimal repo context for the workflow's opening. No az CLI login and
# no PAT exist in this sandbox, so Step 1 (ado-credentials) must report the gap
# before subsequent steps proceed.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"
