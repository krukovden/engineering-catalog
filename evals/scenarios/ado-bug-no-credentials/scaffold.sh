#!/usr/bin/env bash
# Minimal context for "file this as a bug": a git repo exists, nothing else. The
# calculator project the sandbox script builds for its later asks is deliberately
# not recreated here — this case only needs enough state for "file this as a bug"
# to be a sensible request, and no az/PAT so ado-credentials must report the gap.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"
