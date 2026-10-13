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
// A deny hook speaks JSON on both CLIs and always exits 0; only the shape differs. Claude wants
// `{hookSpecificOutput: {hookEventName, permissionDecision, permissionDecisionReason}}`, Copilot
// a flat `{permissionDecision, permissionDecisionReason}` (copilot-facts.md §4.1). The script
// writes Claude's shape by default and Copilot's when its Copilot rendering passes this flag.
const COPILOT_DENY_ARG = { sh: '--copilot', powershell: '-Copilot' };
// The events a `matcher` (a tool filter) means anything on.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse'];
// A source's `matcher` lists Claude tool names. Claude's manifest takes them as written; Copilot's
// matcher matches the runtime name only (copilot-facts.md §6.1 — the Claude spelling silently
// never fires), so each Claude name becomes every runtime name that stands for it (§4). The order
// of this table is the order runtime names are rendered in. A Claude tool with no Copilot runtime
// equivalent is absent here and is refused in a hook that ships to Copilot.
const COPILOT_TOOLS = {
  Bash: ['bash', 'powershell'],
  Read: ['view'],
  Write: ['create'],
  Edit: ['edit', 'str_replace_editor', 'apply_patch'],
  Grep: ['grep', 'rg'],
  Glob: ['glob'],
  WebFetch: ['web_fetch'],
  WebSearch: ['web_search'],
  AskUserQuestion: ['ask_user'],
  TodoWrite: ['update_todo'],
  Agent: ['task'],
};
// Flip only after copilot-facts.md §6 holds a live capture of a `preToolUse` deny (§4.1 is
// doc-sourced). Until then a `denies` hook must declare "platforms": ["claude"].
const COPILOT_DENY_CAPTURED = false;

const argList = (args, shell) => (args && args[shell]) || [];
const withArgs = (command, args) => [command, ...args].join(' ');
const copilotArgList = (hook, shell) => [
  ...argList(hook.args, shell),
  ...(hook.emitsContext ? [COPILOT_CONTEXT_ARG[shell]] : []),
  ...(hook.denies ? [COPILOT_DENY_ARG[shell]] : []),
];

/** `Edit|Write` for Claude, or undefined when the hook has no matcher. */
function claudeMatcher(hook) {
  return hook.matcher ? hook.matcher.join('|') : undefined;
}

/** `create|edit|str_replace_editor|apply_patch` for the same hook on Copilot. */
function copilotMatcher(hook) {
  if (!hook.matcher) return undefined;
  return Object.keys(COPILOT_TOOLS).filter((t) => hook.matcher.includes(t)).flatMap((t) => COPILOT_TOOLS[t]).join('|');
}

/** `<event>.<script basename>` — the id a contract fixture is named after. */
function hookId(hook) {
  return `${hook.event}.${path.basename(hook.script)}`;
}

/**
 * A deny hook fails open: whatever goes wrong inside it — a missing `node`, a missing script, a
 * failed `cd`, a script that throws — the tool call goes ahead. On Copilot any non-zero exit
 * denies (only a timeout fails open, copilot-facts.md §4.1), and `sh` itself exits 2 when it
 * cannot open its script on some systems (dash), which Claude reads as a block. So the generated
 * command, not the script, carries the guarantee: it always exits 0, and a deliberate deny is the
 * JSON decision on stdout — which both CLIs honour on exit 0 (Claude live-verified, §4.1 note).
 */
const failOpenSh = (command) => `${command}; exit 0`;
const failOpenPs = (command) => `try { ${command} } catch { }; exit 0`;

function claudeCommand(hook) {
  const command = withArgs(`sh "\${CLAUDE_PLUGIN_ROOT}/${hook.script}.sh"`, argList(hook.args, 'sh'));
  return hook.denies ? failOpenSh(command) : command;
}

/**
 * Copilot runs a plugin hook with cwd = the plugin root and exports COPILOT_PLUGIN_ROOT /
 * COPILOT_PROJECT_DIR (verified against copilot 1.0.83). A hook script looks for the project
 * it is talking about relative to cwd, so step into the project first; the fallbacks keep the
 * command meaningful on a CLI that exports neither variable.
 */
function copilotCommands(hook) {
  if (hook.denies) {
    return {
      bash: failOpenSh(withArgs(`ROOT="\${COPILOT_PLUGIN_ROOT:-$PWD}"; cd "\${COPILOT_PROJECT_DIR:-$PWD}" && sh "$ROOT/${hook.script}.sh"`, copilotArgList(hook, 'sh'))),
      powershell: failOpenPs(withArgs(`$root = if ($env:COPILOT_PLUGIN_ROOT) { $env:COPILOT_PLUGIN_ROOT } else { $PWD.Path }; if ($env:COPILOT_PROJECT_DIR) { Set-Location -ErrorAction Stop $env:COPILOT_PROJECT_DIR }; & "$root/${hook.script}.ps1"`, copilotArgList(hook, 'powershell'))),
    };
  }
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
  if (raw.denies !== undefined && typeof raw.denies !== 'boolean') fail('"denies" is true or false');
  if (raw.denies && raw.event !== 'PreToolUse') fail('"denies" is only for a PreToolUse hook — no other event may block');
  if (raw.denies && platforms.includes('copilot') && !COPILOT_DENY_CAPTURED) {
    fail('a deny hook ships to Copilot only once its deny shape has a live capture (copilot-facts.md §6) — set "platforms": ["claude"]');
  }
  if (raw.matcher !== undefined) {
    if (!TOOL_EVENTS.includes(raw.event)) fail(`"matcher" filters tool calls — only ${TOOL_EVENTS.join(' and ')} take one`);
    if (!Array.isArray(raw.matcher) || !raw.matcher.length || raw.matcher.some((t) => typeof t !== 'string' || !/^[A-Za-z_]\w*$/.test(t))) {
      fail('"matcher" is a non-empty list of Claude tool names, e.g. ["Edit", "Write"]');
    }
    if (platforms.includes('copilot')) {
      for (const t of raw.matcher) {
        if (!COPILOT_TOOLS[t]) fail(`matcher tool "${t}" has no Copilot runtime name — one of ${Object.keys(COPILOT_TOOLS).join(', ')}, or set "platforms": ["claude"]`);
      }
    }
  }
  const hook = {
    name, description: raw.description, event: raw.event, script: raw.script,
    args: raw.args || {}, emitsContext: raw.emitsContext === true, denies: raw.denies === true,
    matcher: raw.matcher, timeoutSec: raw.timeoutSec || DEFAULT_TIMEOUT_SEC, platforms,
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
  const hooks = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json') && path.basename(f, '.json') !== GENERATED)
    .sort()
    .map((f) => loadHookFromFile(path.join(dir, f), root));
  // Two SessionStart hooks that both answer with context lose all of it on Copilot
  // (copilot-facts.md §6.5), so a second one joins the first instead.
  const speakers = hooks.filter((h) => h.event === 'SessionStart' && h.emitsContext);
  if (speakers.length > 1) {
    throw new Error(`${speakers.map((h) => h.path).join(', ')}: a plugin has one context-emitting SessionStart hook — join them into one`);
  }
  return hooks;
}

/** `hooks/hooks.json` — one matcher group per event and matcher, every hook of that pair inside it. */
function claudeHooksFile(hooks) {
  const out = {};
  for (const hook of hooks.filter((h) => h.platforms.includes('claude'))) {
    const matcher = claudeMatcher(hook);
    const groups = (out[hook.event] = out[hook.event] || []);
    let group = groups.find((g) => g.matcher === matcher);
    if (!group) groups.push(group = matcher === undefined ? { hooks: [] } : { matcher, hooks: [] });
    group.hooks.push({ type: 'command', command: claudeCommand(hook) });
  }
  return { hooks: out };
}

/** `.copilot-plugin/hooks.json` — Copilot's own event names, one entry per hook. */
function copilotHooksFile(hooks) {
  const out = {};
  for (const hook of hooks.filter((h) => h.platforms.includes('copilot'))) {
    const event = COPILOT_EVENT[hook.event];
    const matcher = copilotMatcher(hook);
    (out[event] = out[event] || []).push({
      type: 'command', ...copilotCommands(hook), ...(matcher === undefined ? {} : { matcher }), timeoutSec: hook.timeoutSec,
    });
  }
  return { version: 1, hooks: out };
}

module.exports = {
  HOOKS_DIR, EVENTS, COPILOT_EVENT, CLAUDE_ONLY, DEFAULT_TIMEOUT_SEC, COPILOT_CONTEXT_ARG,
  COPILOT_DENY_ARG, COPILOT_TOOLS, COPILOT_DENY_CAPTURED, TOOL_EVENTS,
  hookId, scanHooks, claudeHooksFile, copilotHooksFile, claudeCommand, copilotCommands,
  claudeMatcher, copilotMatcher,
};
