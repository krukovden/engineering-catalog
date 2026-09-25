#!/usr/bin/env bash
# A tiny, real-looking git repo with no memory/ yet, so memory-init has to create the
# folder, the index and its pointers from scratch and fill them from the actual code.
set -eu
git init -q
git config user.email "tester@example.com"
git config user.name "tester"

mkdir -p src
cat > package.json <<'JSON'
{ "name": "widget-lib", "version": "1.0.0", "scripts": { "test": "node test.js" } }
JSON
cat > src/widget.js <<'JS'
'use strict';
function createWidget(name) {
  if (!name) throw new Error('name required');
  return { name, id: Math.random().toString(36).slice(2) };
}
module.exports = { createWidget };
JS
cat > test.js <<'JS'
const assert = require('node:assert/strict');
const { createWidget } = require('./src/widget');
const w = createWidget('gear');
assert.equal(w.name, 'gear');
console.log('ok');
JS
node test.js
git add -A
git commit -qm "feat: widget creation"
