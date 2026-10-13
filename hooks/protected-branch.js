'use strict';
// PreToolUse deny hook: no `git commit` on main / master in a repository the catalog governs
// (Azure Repos origin, or a catalog receipt at the repo root). It checks the branch, never the
// message. Any doubt or error ends in silence, which is "allow" on both CLIs.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PROTECTED = ['main', 'master'];
const AZURE_REMOTE = /(?:^|[/@.])(?:dev\.azure\.com|[^/@:]+\.visualstudio\.com)(?:[/:]|$)/i;

// Command detection follows CRAP engine/src/hooks/shared.ts. Heredoc bodies are file payload,
// not invocations; an unterminated heredoc strips to the end of the command. A body ends only on
// a line equal to the delimiter (`<<-` also ignores leading tabs).
const HEREDOC = /(?<!<)<<(-?)[ \t]*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s;|&<>()"']+))/g;

function stripHeredocBodies(command) {
  if (!command.includes('<<')) return command;
  const out = [];
  let pending = [];
  for (const line of command.split('\n')) {
    if (pending.length) {
      const { delim, dash } = pending[0];
      if ((dash ? line.replace(/^\t+/, '') : line) === delim) pending.shift();
      continue;
    }
    for (const m of line.matchAll(HEREDOC)) {
      // Quote removal on an unquoted word: `<<\EOF` and `<<E\OF` both end on `EOF`.
      pending.push({ dash: m[1] === '-', delim: m[2] ?? m[3] ?? m[4].replace(/\\(.)/g, '$1') });
    }
    out.push(line);
  }
  return out.join('\n');
}

const normalize = (command) => stripHeredocBodies(command).replace(/\\\r?\n/g, ' ');

// Index of the character that closes a substitution opened just before `from` (or the end).
function substitutionEnd(text, from, close) {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (close === ')' && text[i] === '(') depth++;
    else if (text[i] === close && --depth === 0) return i;
  }
  return text.length;
}

// The same text with every character that only looks like shell syntax neutralised: separators
// inside quotes or after a backslash, and comments, become `_`. Length and quote characters are
// kept, so an index into the mask is an index into the text, and values are read from the text.
// `echo "a; git commit"` and `# git commit` then hold no command position. Under PowerShell a
// backslash is a path separator, never an escape.
function mask(text, shell = 'bash') {
  const escapes = shell !== 'powershell';
  const out = text.split('');
  const neutral = (i) => { if (/[;&|()\n#]/.test(out[i])) out[i] = '_'; };
  let quote = null;
  for (let i = 0; i < out.length; i++) {
    const ch = text[i];
    if (quote === "'") { if (ch === "'") quote = null; else neutral(i); continue; }
    if (quote === '"') {
      // `$(…)` and `` `…` `` still run inside double quotes: leave them live.
      if (ch === '$' && text[i + 1] === '(') i = substitutionEnd(text, i + 2, ')');
      else if (ch === '`') i = substitutionEnd(text, i + 1, '`');
      else if (ch === '\\' && escapes) { i++; neutral(i); } else if (ch === '"') quote = null; else neutral(i);
      continue;
    }
    if (ch === '\\' && escapes) { i++; if (i < out.length) neutral(i); continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) {
      while (i < out.length && text[i] !== '\n') { out[i] = '_'; i++; }
      i--;
    }
  }
  return out.join('');
}

// The alternatives must stay mutually exclusive on any single token, or a command that fails to
// match costs exponential time (CRAP CodeQL js/redos #100). An argument is quoted or starts with a
// non-quote character, so its parse is unique; `(?![cC]\s)` and the `--git-dir|--work-tree|
// --namespace` lookahead make each separate-argument option the only parse of itself, and the
// catch-all `-\S+` covers every other option, including the `--opt=value` forms.
const ARG = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"']\S*)`;
const GIT_GLOBAL_OPTIONS = String.raw`(?:-[cC]\s+${ARG}\s+|--(?:git-dir|work-tree|namespace)\s+${ARG}\s+|-(?![cC]\s)(?!-(?:git-dir|work-tree|namespace)\s)\S+\s+)*`;
// Start of string or a shell separator, then horizontal whitespace only: `\s` would overlap the
// newline already in the separator class.
// A backtick opens a command substitution, so it starts a command position too; so does the `)`
// that ends a case pattern (`case x in x) git commit;; esac`) or a function's `()` (`f() { git
// commit; }`), which `invocations` accepts only after a `case` or right after `(`.
const COMMAND_HEAD = String.raw`(?:^|[|&;()\n\`])[ \t]*`;
// What the shell lets stand in front of a command and still run it: `NAME=value` assignments, the
// wrappers `command`, `env`, `exec`, `nice`, `nohup`, `sudo`, `time` with their options (`env -u
// NAME`, `sudo -u USER`, `time -p`), and the control-flow words that open a command position
// (`if`, `then`, `else`, `elif`, `do`, `while`, `until`, `!`, `{`). An assignment needs `=`, a word
// has none, an option starts with `-`, and an option's argument is neither a word nor an
// assignment, so each prefix has one parse; whether an option took an argument is settled by
// what follows, one token back at most.
const WRAPPERS = 'command|env|exec|nice|nohup|sudo|time';
const KEYWORDS = 'if|then|else|elif|do|while|until';
const OPTION_ARG = String.raw`(?!(?:${WRAPPERS}|${KEYWORDS})[ \t])[^\s"'=!{-][^\s=]*`;
const WRAPPER = String.raw`(?:${WRAPPERS})[ \t]+(?:-\S+[ \t]+(?:${OPTION_ARG}[ \t]+)?)*`;
const PREFIXES = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=${ARG}?[ \t]+|${WRAPPER}|(?:${KEYWORDS}|!|\{)[ \t]+)*`;
// The command word as the shell reads it: quoted, escaped and bare segments joined. `commits`
// keeps a match only when the word, with quotes and escapes removed, names git: `git`,
// `/usr/bin/git`, `git.exe`, `'git'`, `g"i"t`, `g\\it`. Each segment starts with a different
// character, so the word has one parse.
const WORD = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\\.|[^\s"'\\;&|()\`])+`;
// The subcommand is the first word after the global options. It never starts with `-`, so it
// cannot compete with GIT_GLOBAL_OPTIONS for a token and the parse stays unique.
const SUB = String.raw`(?!-)${WORD}`;
const GIT_INVOCATION = `${COMMAND_HEAD}(?<pre>${PREFIXES})(?<exe>${WORD})\\s+(?<opts>${GIT_GLOBAL_OPTIONS})(?<sub>${SUB})`;
const dequote = (word) => word.replace(/"([^"]*)"|'([^']*)'|\\(.)/g, (_, d, q, e) => d ?? q ?? e);
// A backslash is an escape to a POSIX shell and a path separator to PowerShell: try both readings.
const isGitName = (word) => [dequote(word), word.replace(/["']/g, '')]
  .some((w) => /^git(?:\.exe)?$/i.test(w.split(/[\\/]/).pop()));
const GIT_ENV = /(?:^|[ \t])(GIT_DIR|GIT_WORK_TREE)=("[^"\n]*"|'[^'\n]*'|[^\s"']\S*)?/g;
// One pass over the text in front of a commit: quoted strings are skipped, `cd` moves the
// directory, `(` / `)` open and close a subshell whose cd must not leak out. Groups: 1 the
// separator before a cd, 2 its target, 3 the operator after it, 4 a subshell paren.
// A cd target stops at a shell separator: `cd a; git commit` moves to `a`, not `a;`.
const CD_ARG = String.raw`(?:"[^"\n]*"|'[^'\n]*'|[^\s"';&|()]+)`;
const SHELL_STEP = new RegExp([
  String.raw`"[^"\n]*"|'[^'\n]*'`,
  String.raw`(?:^|([|&;(\n]))[ \t]*cd(?:[ \t]+(?![&|;])(${CD_ARG}))?[ \t]*(?=($|&&|\|\||[;&|\n)]))`,
  String.raw`([()])`,
].join('|'), 'g');
const SHELL_STEP_D = new RegExp(SHELL_STEP.source, 'gd');
const OPTION_TOKEN = new RegExp(ARG, 'g');

const unquote = (t) => (/^["']/.test(t) ? t.slice(1, -1) : t);

// `-c alias.<name>=<value>` options on the command line itself, keyed by lower-case name (git
// config names are case-insensitive).
function inlineAliases(opts) {
  const tokens = (opts.match(OPTION_TOKEN) || []).map(unquote);
  const out = Object.create(null);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '-c') {
      const kv = /^alias\.([^=]+)=([^]*)$/i.exec(tokens[++i] || '');
      if (kv) out[kv[1].toLowerCase()] = kv[2];
    } else if (['-C', '--git-dir', '--work-tree', '--namespace'].includes(tokens[i])) i++;
  }
  return out;
}

// Every git invocation in the text, values read back from the text by the indices the masked
// match found. A match that is not git (or a `)` outside a case) may have swallowed the head of a
// later command, so the scan resumes one character after its start rather than after its end.
function invocations(text, masked) {
  const re = new RegExp(GIT_INVOCATION, 'gd');
  const found = [];
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const g = m.indices.groups;
    if (!isGitName(text.slice(...g.exe))
      || (masked[m.index] === ')' && masked[m.index - 1] !== '('
        && !/(?:^|[\s;&|(])case\s/.test(masked.slice(0, m.index)))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    const opts = text.slice(...g.opts);
    found.push({ index: m.index, pre: text.slice(...g.pre), opts, sub: dequote(text.slice(...g.sub)), inline: inlineAliases(opts) });
  }
  return found;
}

// Built-ins git never resolves as an alias: a command naming one is not looked up, so ordinary
// commands spawn nothing extra.
const BUILTINS = new Set(('add am annotate apply archive bisect blame branch bundle cat-file check-ignore checkout '
  + 'cherry cherry-pick clean clone commit-tree config count-objects describe diff diff-files diff-index '
  + 'diff-tree difftool fetch for-each-ref format-patch fsck gc grep hash-object help init log ls-files '
  + 'ls-remote ls-tree merge merge-base mergetool mv notes prune pull push range-diff rebase reflog remote '
  + 'repack replace reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash '
  + 'status submodule switch symbolic-ref tag update-index update-ref var version whatchanged worktree write-tree').split(' '));
const ALIAS_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MAX_ALIAS_DEPTH = 5;
const needsLookup = (sub) => sub !== 'commit' && !BUILTINS.has(sub) && ALIAS_NAME.test(sub);
const noLookup = () => null;

// Whether `git <sub>` commits: `commit` itself, or an alias that expands to it, followed through
// at most MAX_ALIAS_DEPTH lookups. `lookup(name)` returns the configured value or null. A `!`
// shell alias commits when its text holds a git commit by the same detector.
function isCommit(sub, inline, lookup, depth = 0) {
  if (sub === 'commit') return true;
  if (!needsLookup(sub) || depth >= MAX_ALIAS_DEPTH) return false;
  const key = sub.toLowerCase();
  const value = ((key in inline ? inline[key] : lookup(sub)) || '').trim();
  if (value.startsWith('!')) return isGitCommit(value.slice(1));
  const text = `git ${value}`;
  const [next] = invocations(text, mask(text));
  return Boolean(next) && next.index === 0
    && isCommit(next.sub, Object.assign(Object.create(null), inline, next.inline), lookup, depth + 1);
}

function isGitCommit(command, shell = 'bash') {
  const text = normalize(command);
  return invocations(text, mask(text, shell)).some((inv) => isCommit(inv.sub, inv.inline, noLookup));
}

// A group's value read back from the real text, by the index the masked match found it at.
const group = (text, m, i) => (m.indices[i] ? text.slice(...m.indices[i]) : undefined);

const WIN_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const hostContext = () => ({ shell: 'bash', platform: process.platform, win: process.platform === 'win32' });

// The directory a path argument names, or null when it cannot be known here: shell expansion,
// `cd -`, a backslash bash would treat as an escape, or a Windows path off Windows. Windows
// drive and UNC paths resolve with path.win32 when the platform is Windows or the shell is
// PowerShell; to PowerShell a backslash is never an escape.
function resolvePath(dir, raw, ctx) {
  const p = unquote(raw);
  if (/[$`~*?]/.test(p) || p === '-' || p === '') return null;
  if (p.includes('\\')) {
    const literal = ctx.shell === 'powershell' || raw.startsWith("'")
      || (raw.startsWith('"') && !/\\[$`"\\]/.test(p));
    if (!literal || !ctx.win) return null;
  }
  if (/^[A-Za-z]:/.test(p) && !WIN_PATH.test(p)) return null;
  if (WIN_PATH.test(p) && !ctx.win) return null;
  const api = ctx.platform === 'win32' || WIN_PATH.test(p) || WIN_PATH.test(dir) ? path.win32 : path.posix;
  return api.resolve(dir, p);
}

// Past this many possible directories for one commit the command is not worth modelling.
const MAX_DIRS = 16;

// Where one git invocation runs: the cd target in front of it, then the -C / --git-dir /
// --work-tree options. Returns [{ cwd, gitArgs }] or null when it cannot be known.
// A cd only guarantees the move when `&&` follows it and no `||` sits between it and the commit. After `cd a || git commit`, `cd a; …` or a
// pipe, the commit can run where the shell was before if the cd fails, so both stay candidates.
function place(text, masked, inv, cwd, ctx) {
  let dirs = [cwd];
  const saved = [];
  for (const c of masked.slice(0, inv.index + 1).matchAll(SHELL_STEP_D)) {
    if (c[1] === '(') saved.push(dirs);
    if (c[4] === '(') saved.push(dirs);
    else if (c[4] === ')') { if (saved.length) dirs = saved.pop(); }
    else if (c[0].trimStart().replace(/^[|&;(\n]\s*/, '').startsWith('cd')) {
      if (c[2] === undefined) return null;
      const target = group(text, c, 2);
      const moved = dirs.map((d) => resolvePath(d, target, ctx));
      if (moved.includes(null)) return null;
      // `cd x && true || git commit`: a later `||` reaches the commit after the cd failed too.
      const between = text.slice(c.index + c[0].length, inv.index + 1);
      const certain = c[3] === '&&' && !between.includes('||');
      // `cd x || git commit`: the commit runs only when the cd failed, so never in x.
      const failedOnly = /^\s*\|\|\s*$/.test(between);
      dirs = [...new Set(certain ? moved : failedOnly ? dirs : [...moved, ...dirs])];
      if (dirs.length > MAX_DIRS) return null;
    }
  }
  const found = dirs.map((dir) => locate(inv, dir, ctx));
  return found.includes(null) ? null : found;
}

// Where each `git commit` (literal, or through a `-c alias.x=commit` on the command line) runs.
function targets(command, cwd, ctx = hostContext()) {
  const text = normalize(command);
  const masked = mask(text, ctx.shell);
  const found = [];
  for (const inv of invocations(text, masked)) {
    if (!isCommit(inv.sub, inv.inline, noLookup)) continue;
    const at = place(text, masked, inv, cwd, ctx);
    if (at === null) return null;
    found.push(...at);
  }
  return found;
}

function locate(inv, start, ctx) {
  let dir = start;
  const gitArgs = [];
  const raw = inv.opts.match(OPTION_TOKEN) || [];
  // GIT_DIR / GIT_WORK_TREE in front of git choose the repository just like the options do; the
  // options win, and both resolve after -C has moved the directory.
  const fromEnv = {};
  for (const e of inv.pre.matchAll(GIT_ENV)) fromEnv[e[1] === 'GIT_DIR' ? '--git-dir' : '--work-tree'] = e[2] || '';
  for (let i = 0; i < raw.length; i++) {
    const t = unquote(raw[i]);
    // `--git-dir=x` and git's attached short form `-Cx` carry the value in the same token.
    const eq = /^(--git-dir|--work-tree)=(.*)$/.exec(t) || /^(-C)(.+)$/.exec(t);
    const name = eq ? eq[1] : t;
    let value = eq ? eq[2] : null;
    if (name === '-C' || name === '--git-dir' || name === '--work-tree') {
      if (value === null) value = raw[++i];
      if (value === undefined) return null;
      const resolved = resolvePath(dir, value, ctx);
      if (resolved === null) return null;
      if (name === '-C') dir = resolved;
      else gitArgs.push(`${name}=${resolved}`);
    } else if (t === '-c' || t === '--namespace') i++;
  }
  for (const [name, value] of Object.entries(fromEnv)) {
    if (gitArgs.some((a) => a.startsWith(`${name}=`))) continue;
    const resolved = resolvePath(dir, value, ctx);
    if (resolved === null) return null;
    gitArgs.push(`${name}=${resolved}`);
  }
  return { cwd: dir, gitArgs };
}

const git = (cwd, gitArgs, ...args) => execFileSync('git', [...gitArgs, ...args], {
  cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

function governed(run, cwd, gitArgs) {
  let remote = '';
  try { remote = run(cwd, gitArgs, 'config', '--get', 'remote.origin.url'); } catch { /* no origin */ }
  if (AZURE_REMOTE.test(remote)) return true;
  const top = run(cwd, gitArgs, 'rev-parse', '--show-toplevel');
  return fs.existsSync(path.join(top, '.engineering-catalog', 'receipt.json'));
}

function denial(branch) {
  return [
    `WHAT: git commit on the protected branch ${branch}.`,
    `WHY: ${branch} only moves through a reviewed pull request, and a direct commit cannot be merged back cleanly.`,
    'FIX: git switch -c feature/work-in-progress carries your working tree to a new branch, so commit there; the ado-branch skill names it after the work item.',
  ].join('\n');
}

// Alias lookups one hook run may spend: past either bound, an unresolved alias is allowed.
const MAX_LOOKUPS = 8;
const LOOKUP_BUDGET_MS = 2000;

// `deps` is a test seam: `git(cwd, gitArgs, ...args)` and `platform`.
function decide(input, copilot, deps = {}) {
  const run = deps.git || git;
  const platform = deps.platform || process.platform;
  let args = copilot ? input.toolArgs : input.tool_input;
  if (typeof args === 'string') args = JSON.parse(args);
  const command = args && typeof args.command === 'string' ? args.command : '';
  const tool = copilot ? input.toolName : input.tool_name;
  const shell = /^powershell$/i.test(typeof tool === 'string' ? tool : '') ? 'powershell' : 'bash';
  const ctx = { shell, platform, win: platform === 'win32' || shell === 'powershell' };
  const text = normalize(command);
  const masked = mask(text, shell);
  const all = invocations(text, masked);
  const literal = all.filter((inv) => isCommit(inv.sub, inv.inline, noLookup));
  const aliased = all.filter((inv) => !literal.includes(inv) && needsLookup(inv.sub));
  if (!literal.length && !aliased.length) return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const sites = [];
  for (const inv of literal) {
    const at = place(text, masked, inv, cwd, ctx);
    if (at === null) return null;
    sites.push(...at);
  }
  // An alias is resolved in the repository the command runs in, where git itself would read it.
  const cache = new Map();
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  let lookups = 0;
  for (const inv of aliased) {
    for (const t of place(text, masked, inv, cwd, ctx) || []) {
      const lookup = (name) => {
        const key = JSON.stringify([t.cwd, t.gitArgs, name.toLowerCase()]);
        if (cache.has(key)) return cache.get(key);
        if (lookups >= MAX_LOOKUPS || Date.now() > deadline) return null;
        lookups++;
        let value = null;
        try { value = run(t.cwd, t.gitArgs, 'config', '--get', `alias.${name}`); } catch { /* unset */ }
        cache.set(key, value);
        return value;
      };
      if (isCommit(inv.sub, inv.inline, lookup)) sites.push(t);
    }
  }
  for (const t of sites) {
    // A candidate that is not a repository (a cd target that fails) cannot be committed in;
    // skip it rather than let its error allow a commit in another candidate.
    try {
      const branch = run(t.cwd, t.gitArgs, 'symbolic-ref', '--short', '-q', 'HEAD');
      if (PROTECTED.includes(branch) && governed(run, t.cwd, t.gitArgs)) return denial(branch);
    } catch { /* not a repository here */ }
  }
  return null;
}

function main() {
  const copilot = process.argv.includes('--copilot');
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    try {
      const reason = decide(JSON.parse(raw), copilot);
      if (reason) {
        process.stdout.write(JSON.stringify(copilot
          ? { permissionDecision: 'deny', permissionDecisionReason: reason }
          : { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
      }
    } catch { /* fail open */ }
  });
}

if (require.main === module) main();
module.exports = { isGitCommit, targets, decide, stripHeredocBodies, AZURE_REMOTE };
