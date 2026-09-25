#!/usr/bin/env sh
# A small branch ahead of main whose commit message and inline comment both claim
# the cache is bounded, but the code has no eviction at all — a plausible-but-wrong
# claim that a genuine review should catch by reading the code, not the comment.
set -eu
git init -q -b main
git config user.email "tester@example.com"
git config user.name "tester"

cat > cache.js <<'JS'
'use strict';
module.exports = { get: () => undefined, set: () => {} };
JS
git add . && git commit -qm "init"

git checkout -q -b feature/ADO-103533-response-cache
cat > cache.js <<'JS'
'use strict';
// Bounded LRU cache: evicts the oldest entry once size exceeds MAX_ENTRIES.
const MAX_ENTRIES = 500;
const store = new Map();

function set(key, value) {
  // NOTE: eviction is bounded per the comment above, but no eviction logic
  // actually exists here — the map grows without limit.
  store.set(key, value);
}

function get(key) {
  return store.get(key);
}

module.exports = { get, set, MAX_ENTRIES };
JS
git add . && git commit -qm "add bounded response cache (LRU, max 500 entries)"
