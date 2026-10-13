'use strict';
// Denies a shell command containing "deny-me"; throws on one containing "boom".
const copilot = process.argv.includes('--copilot');
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const args = copilot ? input.toolArgs : input.tool_input;
  const command = String((args && args.command) || '');
  if (command.includes('boom')) throw new Error('probe blew up');
  if (!command.includes('deny-me')) return;
  const reason = 'probe denied this call';
  process.stdout.write(JSON.stringify(copilot
    ? { permissionDecision: 'deny', permissionDecisionReason: reason }
    : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
});
