#!/usr/bin/env node
'use strict';
// CI failures for a pull request: failing builds (policy evaluations) → build timeline
// failed records and issues[] → bounded log excerpt → classification test/lint/typecheck/build.
//
//   node ci-failures.js --pr <id> [--org URL --project NAME] [--max-records 5] [--max-lines 200] [--human]
//
// Prints compact JSON on stdout; with --human, a short summary follows on stderr.
const ado = require('./ado');
const { classifyFailure, boundBlock, stripAnsi } = require('./failure-extraction');

const FAILING_POLICY_STATUS = ['rejected', 'broken'];
const LOG_TAIL_CHARS = 200000;
// Step names that settle the kind when the log text is ambiguous.
const NAME_HINTS = [
  ['test', /\b(test|tests|jest|vitest|mocha|pytest|xunit|nunit)\b/i],
  ['lint', /\b(lint|eslint|biome|stylecop|format)\b/i],
  ['typecheck', /\b(typecheck|type-check|tsc)\b/i],
];

// Policy evaluations → distinct build ids of failing build policies.
// verify: context.buildId is set on Build-policy evaluations; other policy types carry none.
function failingBuilds(evaluations) {
  const seen = new Map();
  for (const e of (evaluations && evaluations.value) || []) {
    if (!FAILING_POLICY_STATUS.includes(e.status)) continue;
    const buildId = e.context && e.context.buildId;
    if (!buildId || seen.has(buildId)) continue;
    const cfg = e.configuration || {};
    seen.set(buildId, {
      buildId,
      policy: (cfg.settings && cfg.settings.displayName) || (cfg.type && cfg.type.displayName) || 'Build',
      status: e.status,
    });
  }
  return [...seen.values()];
}

// Timeline → failed leaf records (a failed Job/Stage only repeats its children's failure),
// each with its issues[] errors and the log id, if any.
function failedRecords(timeline) {
  const records = (timeline && timeline.records) || [];
  const failed = records.filter((r) => r.result === 'failed');
  const parents = new Set(failed.map((r) => r.parentId).filter(Boolean));
  return failed
    .filter((r) => !parents.has(r.id))
    .map((r) => ({
      id: r.id,
      name: r.name,
      type: r.type,
      logId: r.log && r.log.id ? r.log.id : null,
      issues: (r.issues || []).filter((i) => i.type === 'error').map((i) => i.message),
    }));
}

function kindFromName(name) {
  const hit = NAME_HINTS.find(([, re]) => re.test(name || ''));
  return hit ? hit[0] : null;
}

// Classify one failed record from its log text, falling back to its issues[] text, then its name.
function classifyRecord(record, logText) {
  const text = logText || record.issues.join('\n');
  if (!text) return { kind: kindFromName(record.name) || 'build', block: '' };
  const c = classifyFailure(text);
  if (c.kind === 'build') {
    const hinted = kindFromName(record.name);
    if (hinted) c.kind = hinted;
  }
  return c;
}

function tailChars(text, max = LOG_TAIL_CHARS) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function buildResult(buildInfo, records, maxLines) {
  return {
    buildId: buildInfo.buildId,
    policy: buildInfo.policy,
    failures: records.map(({ record, logText, logError }) => {
      const c = classifyRecord(record, logText);
      const b = boundBlock(stripAnsi(c.block), maxLines);
      return {
        step: record.name,
        kind: c.kind,
        issues: record.issues.slice(0, 5),
        excerpt: b.block,
        truncated: b.truncated,
        logError: logError || null,
      };
    }),
  };
}

function humanSummary(result) {
  const note = result.partial
    ? `NOTE: evidence is partial; ${result.errors.length} log ${result.errors.length === 1 ? 'was' : 's were'} unavailable.`
    : '';
  if (!result.builds.length) return [note, `PR ${result.pr}: no failing build policy.`].filter(Boolean).join('\n');
  const lines = [`PR ${result.pr}: ${result.builds.length} failing build(s)`];
  for (const b of result.builds) {
    lines.push(`- build ${b.buildId} (${b.policy})`);
    if (b.timelineError) lines.push(`    note: timeline unavailable (${b.timelineError})`);
    for (const f of b.failures) {
      lines.push(`    [${f.kind}] ${f.step}${f.issues[0] ? ': ' + f.issues[0] : ''}`);
      if (f.logError) lines.push(`      note: log ${result.errors.find((e) => e.buildId === b.buildId && e.step === f.step)?.logId || '?'} unavailable (${f.logError})`);
    }
  }
  return [note, ...lines].filter(Boolean).join('\n');
}

async function run(argv, env = process.env, fetchImpl = fetch) {
  const args = ado.parseArgs(argv);
  if (!args.pr || args.pr === true) throw new Error('usage: ci-failures.js --pr <id> [--org URL --project NAME]');
  const maxRecords = Number(args['max-records'] || 5);
  const maxLines = Number(args['max-lines'] || 200);
  const ctx = ado.resolveContext(args, env);
  const auth = ado.resolveAuth(env);
  const pr = await ado.getPullRequest(auth, ctx.org, args.pr, fetchImpl);
  const project = pr.projectName || ctx.project;
  const projBase = `${ctx.org}/${encodeURIComponent(project)}`;

  // verify: artifactId format for a PR is vstfs:///CodeReview/CodeReviewId/{projectId}/{pullRequestId}
  // and the route is still served as 7.1-preview.1 on some servers.
  const artifactId = `vstfs:///CodeReview/CodeReviewId/${pr.projectId}/${pr.id}`;
  const evals = await ado.request(auth, 'GET', ado.apiUrl(projBase, '_apis/policy/evaluations', { artifactId }), undefined, fetchImpl);

  const builds = [];
  const errors = [];
  for (const b of failingBuilds(evals)) {
    // An expired or deleted build loses its timeline; report it and keep the other builds.
    let timeline;
    try {
      timeline = await ado.request(auth, 'GET', ado.apiUrl(projBase, `_apis/build/builds/${b.buildId}/timeline`), undefined, fetchImpl);
    } catch (error) {
      errors.push({ buildId: b.buildId, step: null, message: `timeline unavailable: ${error.message}` });
      builds.push({ ...buildResult(b, [], maxLines), timelineError: error.message });
      continue;
    }
    const picked = failedRecords(timeline).slice(0, maxRecords);
    const withLogs = [];
    for (const record of picked) {
      let logText = '';
      let logError = null;
      if (record.logId) {
        try {
          const raw = await ado.request(auth, 'GET', ado.apiUrl(projBase, `_apis/build/builds/${b.buildId}/logs/${record.logId}`), undefined, fetchImpl);
          logText = tailChars(typeof raw === 'string' ? raw : JSON.stringify(raw));
        } catch (error) {
          logError = error.message;
          errors.push({ buildId: b.buildId, step: record.name, logId: record.logId, message: error.message });
        }
      }
      withLogs.push({ record, logText, logError });
    }
    builds.push(buildResult(b, withLogs, maxLines));
  }
  return { pr: pr.id, builds, partial: errors.length > 0, errors };
}

module.exports = { failingBuilds, failedRecords, classifyRecord, buildResult, humanSummary, kindFromName, tailChars, run };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (out) => {
      console.log(JSON.stringify(out));
      if (process.argv.includes('--human')) console.error(humanSummary(out));
    },
    (e) => { console.error(e.message); process.exit(1); },
  );
}
