'use strict';
// The pure grading engine for the Copilot arm. Claude's native `plugin eval` command grades its
// own runs internally (we only ever read the JSON it already scored); Copilot has no such
// command, so this module re-implements the four free grader types from `cases.js`'s
// `graders/*.md` frontmatter, operating on one **normalized trace** built by `copilot.js`.
//
// Normalized trace shape (deliberately Copilot-name-agnostic, so a future third target can
// reuse this module unchanged):
//   {
//     reply: string,        // every assistant message's text, concatenated in event order
//     raw: string,          // the tool-call log serialised to text, then the reply appended —
//                            // this is what a `target: trace` regex grader matches against,
//                            // the closest equivalent to Claude's whole-transcript view
//     toolCalls: [{ name, input, success }],  // ordered, `name` is the *target's own* tool name
//     workdir: string,      // absolute path to the run's working directory, for file_exists
//   }
//
// Case graders are written in Claude vocabulary (`tool: Skill`, `tool: Bash`, `before: Read`),
// because the same `graders/*.md` files grade both arms. `TOOL_MAP` / `mapToolName` translate
// that vocabulary to whatever name the trace's tool calls actually carry.
const fs = require('fs');
const path = require('path');

// Claude case vocabulary -> Copilot CLI tool name (from copilot-facts.md's live-captured table).
const TOOL_MAP = { Skill: 'skill', Bash: 'bash', Read: 'view', Glob: 'glob', Grep: 'rg' };

/** Case-insensitive lookup in TOOL_MAP; an already-lowercase/unrecognised name passes through
 * lowercased, so a grader written directly in a target's own vocabulary still matches. */
function mapToolName(name) {
  const key = Object.keys(TOOL_MAP).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? TOOL_MAP[key] : String(name).toLowerCase();
}

function textForTarget(grader, trace) {
  // The case format's `target` key means "trace" for the whole transcript view; anything else
  // (including unset) means the final reply, matching the native runner's default.
  return grader.target === 'trace' ? trace.raw : trace.reply;
}

function gradeRegex(grader, trace) {
  const re = new RegExp(grader.pattern, grader.flags || '');
  const text = textForTarget(grader, trace) || '';
  const found = re.test(text);
  const match = grader.match || 'contains';
  const passed = match === 'not_contains' ? !found : found;
  const where = grader.target === 'trace' ? 'trace' : 'reply';
  return { passed, explanation: `pattern /${grader.pattern}/${grader.flags || ''} ${found ? 'matched' : 'did not match'} the ${where} (match: ${match})` };
}

function gradeToolUsed(grader, trace) {
  const mapped = mapToolName(grader.tool);
  const inputRe = grader.input_match ? new RegExp(grader.input_match) : null;
  const matches = (trace.toolCalls || []).filter((c) => c.name && c.name.toLowerCase() === mapped
    && (!inputRe || inputRe.test(JSON.stringify(c.input === undefined ? {} : c.input))));
  const count = matches.length;
  const min = grader.min === undefined ? 1 : grader.min;
  const max = grader.max === undefined ? Infinity : grader.max;
  const passed = count >= min && count <= max;
  return { passed, explanation: `tool "${grader.tool}" (mapped to "${mapped}") called ${count}x (expected ${min}..${max === Infinity ? '∞' : max})` };
}

function gradeToolOrder(grader, trace) {
  const beforeTool = mapToolName(grader.before);
  const afterTool = mapToolName(grader.after);
  const calls = trace.toolCalls || [];
  const beforeIdx = calls.findIndex((c) => c.name && c.name.toLowerCase() === beforeTool);
  const afterIdx = calls.findIndex((c) => c.name && c.name.toLowerCase() === afterTool);
  const passed = beforeIdx !== -1 && afterIdx !== -1 && beforeIdx < afterIdx;
  return { passed, explanation: `"${grader.before}" (${beforeTool}) at index ${beforeIdx}, "${grader.after}" (${afterTool}) at index ${afterIdx}` };
}

function gradeFileExists(grader, trace) {
  const full = path.join(trace.workdir, grader.path);
  const exists = fs.existsSync(full);
  const expected = grader.exists === undefined ? true : grader.exists;
  const passed = exists === expected;
  return { passed, explanation: `${grader.path} ${exists ? 'exists' : 'does not exist'} (expected to ${expected ? '' : 'not '}exist)` };
}

const GRADERS = { regex: gradeRegex, tool_used: gradeToolUsed, tool_order: gradeToolOrder, file_exists: gradeFileExists };

/**
 * Runs every grader in `caseDef.graders` and returns the per-run shape `records.js`'s
 * `mapGrader` expects: `{ score, passed, graders: [{ name, passed, weight, scored, explanation }] }`.
 *
 * Design decision (documented per the task, not silent): the native runner marks a grader
 * `scored: false` when it only exists to compare the "with" arm against a "without" arm (e.g. a
 * bare "did the skill fire" check that would trivially fail without the candidate installed) —
 * excluding it keeps that comparison from polluting the case's own pass/fail score. This runner
 * has no "without" arm at all: every Copilot run already has the candidate catalog installed, so
 * there is nothing to exclude *from* and no reason to invent a fake exclusion. We therefore
 * score every grader `scored: true` **except** one explicitly authored with `arm: without`
 * (meaning "only meaningful without the candidate", which can never be true here and would only
 * ever inflate a Copilot score if we counted it).
 */
async function gradeCase(caseDef, trace, { judge } = {}) {
  const results = [];
  for (const grader of caseDef.graders) {
    const scored = grader.arm !== 'without';
    let outcome;
    if (grader.type === 'llm' || grader.type === 'baseline') {
      if (typeof judge !== 'function') throw new Error(`case "${caseDef.name}": grader "${grader.name}" is a ${grader.type} grader but no judge was injected`);
      outcome = await judge(grader, trace);
    } else {
      const fn = GRADERS[grader.type];
      if (!fn) throw new Error(`case "${caseDef.name}": grader "${grader.name}" has unsupported type "${grader.type}"`);
      outcome = fn(grader, trace);
    }
    results.push({ name: grader.name, passed: outcome.passed, weight: grader.weight === undefined ? 1 : grader.weight, scored, explanation: outcome.explanation });
  }
  const scoredResults = results.filter((r) => r.scored);
  const totalWeight = scoredResults.reduce((sum, r) => sum + r.weight, 0);
  // No scored graders is an edge case the case format shouldn't produce (every case needs at
  // least one grader per cases.js) — treat it as a vacuous pass rather than a divide-by-zero NaN.
  const score = totalWeight > 0 ? scoredResults.reduce((sum, r) => sum + (r.passed ? r.weight : 0), 0) / totalWeight : 1;
  const passed = scoredResults.length === 0 ? true : scoredResults.every((r) => r.passed);
  return { score, passed, graders: results };
}

module.exports = {
  TOOL_MAP, mapToolName,
  gradeRegex, gradeToolUsed, gradeToolOrder, gradeFileExists,
  gradeCase,
};
