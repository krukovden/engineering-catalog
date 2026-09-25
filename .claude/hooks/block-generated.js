#!/usr/bin/env node
'use strict';
// PreToolUse (Edit|Write) — a hard backstop for AGENTS.md's "never edit a generated file by
// hand" rule. remind-rebuild.js (PostToolUse) only nudges after a SOURCE edit; this hook denies
// the edit outright when the target is itself a file `npm run build` writes wholesale.
// Deliberately scoped to whole-file artifacts. README.md's <!-- catalog:start --> block and
// .github/copilot-instructions.md's style block are generated but live inside otherwise
// hand-written files — not covered here; `npm run check` is what catches those going stale.
//
// This process is spawned only when the `if` glob on the hook entry in .claude/settings.json
// already matches — an ordinary edit to a non-generated file never reaches Node at all, since
// Claude Code evaluates `if` in-process before running `command`. GENERATED below is kept as
// the actual authority regardless (checked for drift against both the `if` string and the
// Copilot twin by coding-agent-parity): the two pattern languages are not identical, and a
// permission glob quirk should never be the only thing standing between an edit and a denial.
const path = require('path');

const GENERATED = [
  /^catalog\.json$/,
  /^plugin\.json$/,
  /^\.claude-plugin\/(marketplace|plugin)\.json$/,
  /^hooks\/hooks\.json$/,
  /^\.copilot-plugin\/(agents\/[^/]+\.agent\.md|hooks\.json)$/,
  /^\.github\/plugin\/marketplace\.json$/,
  /^(skills|agents|workflows)\/[^/]+\/README\.md$/,
];

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) return;
  const cwd = input.cwd || process.cwd();
  const rel = path.relative(cwd, filePath).split(path.sep).join('/');
  if (!GENERATED.some((re) => re.test(rel))) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${rel} is generated — never edit it by hand (AGENTS.md). Change the source and run \`npm run build\`.`,
    },
  }));
  process.exit(2);
});
