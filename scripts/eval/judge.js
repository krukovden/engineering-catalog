'use strict';
// The llm/baseline judge for the Copilot arm. `evals/eval.config.json`'s `judge` block pins one
// judge model for *both* CLIs (`claude-opus-5`, headless) — grading a Copilot run's `llm`/
// `baseline` graders never calls `copilot -p`, it always calls `claude -p` as a pure text judge:
// no tools, no plugin dir, just a rubric and an excerpt in, a PASS/FAIL verdict out.
//
// The native `claude plugin eval` command votes three times internally for `llm`/`baseline`
// graders and takes the majority; that voting happens inside the CLI on the Claude arm, so we
// get it for free there. This runner doesn't get that for free — `runJudge` does the same
// three-call majority vote itself.
const { spawn } = require('child_process');
const fs = require('fs');

const tail = (text, lines = 20) => (text || '').split('\n').slice(-lines).join('\n').trim();

/** Keep the prompt short — every judge call is a real, metered claude -p invocation. */
function judgePrompt(grader, trace) {
  const rubric = (grader.criteria || '').trim() || '(no rubric text)';
  const header = 'You are grading an AI coding agent\'s run against a rubric below. '
    + 'Reply with exactly one line, "PASS" or "FAIL", then a short reason on the next line.';
  if (grader.type === 'baseline') {
    let baseline = '(baseline file not found — grade on the rubric alone)';
    try {
      baseline = fs.readFileSync(grader.baseline_file, 'utf8').trim();
    } catch {
      // A missing baseline file is a grading gap to note in the verdict, not a crash.
    }
    return [header, '', 'Rubric:', rubric, '', 'Baseline (expected) behavior:', baseline, '', 'What the agent actually did:', trace.reply || '(empty reply)'].join('\n');
  }
  return [header, '', 'Rubric:', rubric, '', 'The agent\'s reply:', trace.reply || '(empty reply)'].join('\n');
}

/** Extracts a PASS/FAIL verdict from a judge reply. No parseable verdict fails closed — a judge
 * response we can't understand must never silently pass a run. */
function parseVerdict(text) {
  const match = /\b(PASS|FAIL)\b/i.exec(text || '');
  const passed = !!match && match[1].toUpperCase() === 'PASS';
  const explanation = match ? (text || '').trim().split('\n').slice(0, 2).join(' ').slice(0, 200) : `unparseable judge reply: ${(text || '').slice(0, 200)}`;
  return { passed, explanation };
}

/** The real judge call: headless `claude -p`, text only — no `--plugin-dir`, no tools. */
function spawnJudge(prompt, judge) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--model', judge.model, '--output-format', 'json'];
    const child = spawn('claude', args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return resolve({ text: '', error: tail(stderr) });
      try {
        const parsed = JSON.parse(stdout);
        return resolve({ text: parsed.result || parsed.text || stdout });
      } catch {
        return resolve({ text: stdout });
      }
    });
  });
}

/** Three-vote majority, matching the native runner's documented behavior for llm/baseline
 * graders. `exec(prompt, judge)` is injected so tests never spawn the real `claude` binary. */
async function runJudge({ grader, trace, judge, exec = spawnJudge }) {
  const prompt = judgePrompt(grader, trace);
  const votes = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- three sequential, cheap, deliberately serial votes
    const { text } = await exec(prompt, judge);
    votes.push(parseVerdict(text));
  }
  const passCount = votes.filter((v) => v.passed).length;
  const passed = passCount >= 2;
  const explanation = `${passCount}/3 judge votes passed — ${votes.map((v) => v.explanation).join(' | ')}`;
  return { passed, explanation };
}

module.exports = { judgePrompt, parseVerdict, runJudge, spawnJudge };
