'use strict';
const fs = require('fs');
const path = require('path');

const HOOKS_DIR = 'hooks';
// `hooks/hooks.json` is the generated Claude manifest, so no source may take that name.
const GENERATED = 'hooks';
const TARGETS = ['claude', 'copilot'];
// Claude's events and the Copilot event each one becomes. An event with no entry here
// exists only on Claude, so a hook using it must say so with platforms: ["claude"].
const COPILOT_EVENT = {
  SessionStart: 'sessionStart',
  SessionEnd: 'sessionEnd',
  UserPromptSubmit: 'userPromptSubmitted',
  PreToolUse: 'preToolUse',
  PostToolUse: 'postToolUse',
};
const CLAUDE_ONLY = ['Stop', 'SubagentStop', 'PreCompact', 'Notification'];
const EVENTS = [...Object.keys(COPILOT_EVENT), ...CLAUDE_ONLY];
const DEFAULT_TIMEOUT_SEC = 30;
// The two CLIs disagree about how a hook says something to the model. Claude adds plain
// stdout to the session as context on SessionStart; Copilot reads stdout as JSON and takes
// the line from `additionalContext`, dropping plain text without a word (captured on
// copilot 1.0.85 — copilot-facts.md §6). A hook that declares `emitsContext` is one whose
// output is meant to be read, so only its Copilot rendering asks for the JSON shape.
const COPILOT_CONTEXT_ARG = { sh: '--json', powershell: '-Json' };

const argList = (args, shell) => (args && args[shell]) || [];
const withArgs = (command, args) => [command, ...args].join(' ');
const copilotArgList = (hook, shell) => (hook.emitsContext ? [...argList(hook.args, shell), COPILOT_CONTEXT_ARG[shell]] : argList(hook.args, shell));

/** `<event>.<script basename>` — the id a contract fixture is named after. */
function hookId(hook) {
  return `${hook.event}.${path.basename(hook.script)}`;
}

function claudeCommand(hook) {
  return withArgs(`sh "\${CLAUDE_PLUGIN_ROOT}/${hook.script}.sh"`, argList(hook.args, 'sh'));
}

/**
 * Copilot runs a plugin hook with cwd = the plugin root and exports COPILOT_PLUGIN_ROOT /
 * COPILOT_PROJECT_DIR (verified against copilot 1.0.83). A hook script looks for the project
 * it is talking about relative to cwd, so step into the project first; the fallbacks keep the
 * command meaningful on a CLI that exports neither variable.
 */
function copilotCommands(hook) {
  return {
    bash: withArgs(`ROOT="\${COPILOT_PLUGIN_ROOT:-$PWD}"; cd "\${COPILOT_PROJECT_DIR:-$PWD}" && sh "$ROOT/${hook.script}.sh"`, copilotArgList(hook, 'sh')),
    powershell: withArgs(`$root = if ($env:COPILOT_PLUGIN_ROOT) { $env:COPILOT_PLUGIN_ROOT } else { $PWD.Path }; if ($env:COPILOT_PROJECT_DIR) { Set-Location $env:COPILOT_PROJECT_DIR }; & "$root/${hook.script}.ps1"`, copilotArgList(hook, 'powershell')),
  };
}

function loadHookFromFile(file, root) {
  const name = path.basename(file, '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const where = `${HOOKS_DIR}/${name}.json`;
  const fail = (msg) => { throw new Error(`${where}: ${msg}`); };
  if (raw.name !== name) fail(`"name" is "${raw.name}" but the file is named ${name}.json`);
  if (!raw.description) fail('needs a "description"');
  if (!EVENTS.includes(raw.event)) fail(`event "${raw.event}" is not one of ${EVENTS.join(', ')}`);
  const platforms = raw.platforms || TARGETS;
  for (const p of platforms) if (!TARGETS.includes(p)) fail(`platform "${p}" is not one of ${TARGETS.join(', ')}`);
  if (typeof raw.script !== 'string' || raw.script.endsWith('.sh') || raw.script.endsWith('.ps1')) {
    fail('"script" is a path without its extension — the .sh and .ps1 twins are derived from it');
  }
  if (platforms.includes('copilot') && !COPILOT_EVENT[raw.event]) {
    fail(`event "${raw.event}" has no Copilot equivalent — set "platforms": ["claude"]`);
  }
  if (raw.emitsContext !== undefined && typeof raw.emitsContext !== 'boolean') fail('"emitsContext" is true or false');
  const hook = {
    name, description: raw.description, event: raw.event, script: raw.script,
    args: raw.args || {}, emitsContext: raw.emitsContext === true,
    timeoutSec: raw.timeoutSec || DEFAULT_TIMEOUT_SEC, platforms,
    path: where,
  };
  for (const [ext, target] of [['sh', 'claude'], ['ps1', 'copilot']]) {
    if (!platforms.includes(target)) continue;
    const script = path.join(root, `${hook.script}.${ext}`);
    if (!fs.existsSync(script)) fail(`${hook.script}.${ext} does not exist (needed for ${target})`);
  }
  return hook;
}

/** Every hand-written hook source under `hooks/`, sorted by name. Throws on a malformed source. */
function scanHooks({ root }) {
  const dir = path.join(root, HOOKS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && path.basename(f, '.json') !== GENERATED)
    .sort()
    .map((f) => loadHookFromFile(path.join(dir, f), root));
}

/** `hooks/hooks.json` — one matcher group per event, every hook of that event inside it. */
function claudeHooksFile(hooks) {
  const out = {};
  for (const hook of hooks.filter((h) => h.platforms.includes('claude'))) {
    (out[hook.event] = out[hook.event] || [{ hooks: [] }])[0].hooks.push({ type: 'command', command: claudeCommand(hook) });
  }
  return { hooks: out };
}

/** `.copilot-plugin/hooks.json` — Copilot's own event names, one entry per hook. */
function copilotHooksFile(hooks) {
  const out = {};
  for (const hook of hooks.filter((h) => h.platforms.includes('copilot'))) {
    const event = COPILOT_EVENT[hook.event];
    (out[event] = out[event] || []).push({ type: 'command', ...copilotCommands(hook), timeoutSec: hook.timeoutSec });
  }
  return { version: 1, hooks: out };
}

module.exports = {
  HOOKS_DIR, EVENTS, COPILOT_EVENT, CLAUDE_ONLY, DEFAULT_TIMEOUT_SEC, COPILOT_CONTEXT_ARG,
  hookId, scanHooks, claudeHooksFile, copilotHooksFile, claudeCommand, copilotCommands,
};
