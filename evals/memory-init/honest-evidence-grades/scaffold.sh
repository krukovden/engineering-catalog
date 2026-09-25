#!/usr/bin/env bash
# A repo with a design rationale visible only as a code comment (never confirmed by any
# person or PR in this session), and no rejected approach at all — so a run of
# memory-init should grade any claim about "why" as inferred, not confirmed, and must
# not invent a "Rejected at project level" entry that was never recorded.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

mkdir -p src
cat > src/search.js <<'JS'
'use strict';
// Debounced to avoid firing an API call on every keystroke.
function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
module.exports = { debounce };
JS
cat > README.md <<'MD'
# search-ui

A small search-as-you-type helper with a debounced input handler.
MD
git add -A
git commit -qm "feat: debounced search input"
