#!/usr/bin/env node
'use strict';
// postToolUse — same backstop as .claude/hooks/remind-rebuild.js, ported for Copilot CLI.
// Three things about this hook were captured live on copilot 1.0.85 (copilot-facts.md §6),
// because each of them fails silently when guessed wrong:
//   - The matcher must use RUNTIME tool names. Documentation says a token also matches the
//     Claude-equivalent name, but `Edit|Write` never fires; `create` does. Hence the list.
//   - stdout is read as JSON. Plain text is captured in the debug log and dropped, so the
//     reminder travels in `additionalContext` or not at all; `{}` means "nothing to say".
//   - `.github/hooks/*.json` loads only in a folder Copilot trusts. In an untrusted folder
//     this hook never runs, and nothing says so — `npm run check` is the real enforcement.
// `toolArgs` arrives as an object with `path` for `create`; the other keys are kept for the
// write variants this hook also matches, whose arguments the reference leaves unspecified.
const path = require('path');

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
  if (!/^(skills|agents|workflows|bundles)\//.test(rel)) return process.stdout.write('{}\n');
  process.stdout.write(`${JSON.stringify({
    additionalContext: `Source unit changed (${rel}) — run \`npm run build\` (then \`npm test\` and \`npm run check\`) before committing.`,
  })}\n`);
});
