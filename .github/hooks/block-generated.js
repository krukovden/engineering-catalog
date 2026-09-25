#!/usr/bin/env node
'use strict';
// preToolUse — same backstop as .claude/hooks/block-generated.js, ported for Copilot CLI.
// The deny shape below (a flat {permissionDecision, permissionDecisionReason}, exit 2) is
// doc-sourced only (copilot-facts.md §4.1) — unlike remind-rebuild.js's twin, it has not been
// captured live against a running Copilot CLI the way copilot-facts.md §6 verifies other hook
// behaviour. Re-verify it there before trusting it on a materially newer CLI.
// toolArgs parsing and the matcher/trusted-folder/JSON-stdout caveats mirror remind-rebuild.js —
// see that file's header and copilot-facts.md §6.
//
// Unlike the Claude twin, this process is spawned on EVERY create|edit|str_replace_editor|
// apply_patch call — the Copilot hook manifest's `matcher` is a tool-name regex only (§4, §6.1),
// with no documented per-path prefilter equivalent to Claude's hook-level `if`. The cost stays
// negligible regardless: no I/O, one regex loop, same as before — Node's own startup is the
// only real overhead, and that is paid by every dev-side hook on this platform already.
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

  let toolArgs = input.toolArgs;
  if (typeof toolArgs === 'string') {
    try { toolArgs = JSON.parse(toolArgs); } catch { toolArgs = {}; }
  }
  toolArgs = toolArgs || {};

  const filePath = toolArgs.path || toolArgs.file_path || toolArgs.filePath;
  if (!filePath) return process.stdout.write('{}\n');
  const cwd = input.cwd || process.cwd();
  const rel = path.relative(cwd, filePath).split(path.sep).join('/');
  if (!GENERATED.some((re) => re.test(rel))) return process.stdout.write('{}\n');
  process.stdout.write(`${JSON.stringify({
    permissionDecision: 'deny',
    permissionDecisionReason: `${rel} is generated — never edit it by hand (AGENTS.md). Change the source and run \`npm run build\`.`,
  })}\n`);
  process.exit(2);
});
