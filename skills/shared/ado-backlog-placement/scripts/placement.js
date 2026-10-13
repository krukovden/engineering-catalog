#!/usr/bin/env node
'use strict';
// ado-backlog-placement CLI: context, projects, duplicates, candidates, create. Decisions live
// in placement-logic.js, REST calls in placement-rest.js. Prints one JSON object on stdout.
// Exit codes: 0 done (or a preview), 1 a call or validation failed, nothing created,
// 2 a person must choose (organization/project unknown), 3 refused (no or stale approval, a
// receipt exists) and nothing sent, 5 created but the read-back differs: do not retry.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ado = require('./ado.js');
const L = require('./placement-logic.js');
const R = require('./placement-rest.js');

function defaultDeps() {
  return {
    fetch: (...a) => fetch(...a),
    env: process.env,
    home: os.homedir(),
    now: () => new Date().toISOString(),
    timeoutMs: 30000,
    runAz: (args, timeout = 8000) => {
      const win = process.platform === 'win32';
      return execFileSync(win ? 'az.cmd' : 'az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout, shell: win }).toString();
    },
    git: (args, cwd = process.cwd()) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(),
  };
}

function repoRemote(deps) {
  try { return L.parseRemoteUrl(deps.git(['remote', 'get-url', 'origin'])); } catch { return null; }
}

function context(args, deps) {
  const remote = repoRemote(deps);
  const fallback = remote ? { org: remote.org, project: remote.project } : {};
  const ctx = ado.resolveContext(args, deps.env, { fallback, home: deps.home, runAz: deps.runAz });
  // The repository counts for the score only when it lives in the project being searched.
  ctx.repo = remote && remote.org.toLowerCase() === ctx.org.toLowerCase() && remote.project.toLowerCase() === ctx.project.toLowerCase() ? remote.repo : null;
  return ctx;
}

const auth = (deps) => ado.resolveAuth(deps.env, deps.runAz);

async function withTeam(ctx, a, deps) {
  if (ctx.team) return ctx;
  const p = await R.getProject(ctx, a, deps);
  if (!p.defaultTeam) throw new Error(`project ${ctx.project} has no default team: pass --team`);
  return { ...ctx, team: p.defaultTeam, source: { ...ctx.source, team: 'project-default' } };
}

const where = (ctx) => ({ organization: ctx.org, project: ctx.project, team: ctx.team });

// --- context: local only, no network -----------------------------------------------------

function cmdContext(args, deps) {
  try {
    const ctx = context(args, deps);
    return {
      code: 0,
      out: {
        outcome: 'ok', ...where(ctx), areaPath: ctx.areaPath, repository: ctx.repo, source: ctx.source,
        ...(ctx.team ? {} : { teamNote: "the project's default team, resolved on the first query" }),
        ask: `Working in ${ctx.org} / ${ctx.project} / ${ctx.team || 'default team'} — right?`,
      },
    };
  } catch (e) {
    if (e.code !== 'needs-choice') throw e;
    return { code: 2, out: { outcome: 'needs-choice', known: e.partial, detail: e.message, next: 'placement.js projects --org <organization URL>, then pass --org/--project/--team' } };
  }
}

// --- projects ------------------------------------------------------------------------------

async function cmdProjects(args, deps) {
  let org = args.org;
  if (!org) {
    try { org = context(args, deps).org; } catch (e) { org = e.partial && e.partial.org; }
  }
  if (!org) return { code: 2, out: { outcome: 'needs-choice', detail: 'organization unknown: pass --org https://dev.azure.com/<org>' } };
  org = String(org).replace(/\/+$/, '');
  const a = auth(deps);
  if (args.project && args.project !== true) {
    return { code: 0, out: { outcome: 'ok', organization: org, project: args.project, teams: await R.listTeams({ org }, a, args.project, deps) } };
  }
  return { code: 0, out: { outcome: 'ok', organization: org, projects: await R.listProjects({ org }, a, deps) } };
}

// --- duplicates ----------------------------------------------------------------------------

function needText(args) {
  if (!args.text || args.text === true) throw Object.assign(new Error('--text "<the task in a sentence>" is required'), { code: 1 });
  return String(args.text);
}

async function cmdDuplicates(args, deps) {
  const text = needText(args);
  const a = auth(deps);
  const ctx = await withTeam(context(args, deps), a, deps);
  const scope = await R.getTeamScope(ctx, a, ctx.team, deps);
  const { items } = await R.queryOpen(ctx, a, scope, L.DUPLICATE_TYPES, deps);
  const duplicates = L.findDuplicates(text, items);
  return {
    code: 0,
    out: { outcome: duplicates.length ? 'duplicates' : 'none', ...where(ctx), areaPaths: scope.areas.map((x) => x.value), considered: items.length, words: [...L.tokenize(text)], duplicates },
  };
}

// --- candidates ----------------------------------------------------------------------------

async function cmdCandidates(args, deps) {
  const text = needText(args);
  const type = args.type && args.type !== true ? String(args.type) : 'Feature';
  if (!['Feature', 'Epic'].includes(type)) throw Object.assign(new Error('--type is Feature or Epic'), { code: 1 });
  const a = auth(deps);
  const ctx = await withTeam(context(args, deps), a, deps);
  const scope = await R.getTeamScope(ctx, a, ctx.team, deps);
  const { types, items } = await R.queryOpen(ctx, a, scope, [type], deps);
  let repoId = null;
  if (ctx.repo) { try { repoId = await R.getRepoId(ctx, a, ctx.repo, deps); } catch { /* no repository bonus */ } }
  const recentDays = Number(args['recent-days']) || L.RECENT_DAYS;
  const ranked = L.rankCandidates(text, items, { iterationPath: scope.iterationPath, repoId, nowMs: Date.parse(deps.now()), recentDays, top: Number(args.top) || 3 });
  return {
    code: 0,
    out: {
      outcome: ranked.ranked.length ? 'candidates' : 'none-fits', ...where(ctx), type,
      areaPath: scope.areaPath, iterationPath: scope.iterationPath, suggestedItemType: L.pickItemType(types),
      considered: ranked.considered, words: ranked.words, candidates: ranked.ranked,
    },
  };
}

// --- create: preview without --approved, publish once with it ----------------------------

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Exclusive creation is the lock: of two concurrent runs exactly one creates the receipt.
function claimReceipt(file, content) {
  try { fs.writeFileSync(file, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' }); return true; } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
}

function refusedByReceipt(receiptPath, title) {
  const receipt = readJson(receiptPath);
  const state = receipt && receipt.state;
  if (state === 'created') {
    return { code: 3, out: { mode: 'ALREADY-PUBLISHED', id: receipt.id, url: receipt.url, publishedAt: receipt.publishedAt, detail: 'This draft was already published. No second item was created.' } };
  }
  const previous = state === 'failed' ? `failed at ${receipt.failedAt} with: ${receipt.error}`
    : state === 'in-flight' ? `started at ${receipt.startedAt} and never recorded an outcome`
      : 'is being recorded by another run right now';
  return {
    code: 3,
    out: {
      mode: 'REFUSED', receipt: receiptPath,
      detail: `A previous publish of this draft ${previous}. The request had already been sent, so the work item may exist. Nothing was sent this time. `
        + `Search first: placement.js duplicates --text "${title}". If it exists, record its id and url in the receipt with "state": "created"; if not, delete the receipt and run again.`,
    },
  };
}

async function cmdCreate(args, deps) {
  if (!args.draft || args.draft === true) throw Object.assign(new Error('--draft <file.json> is required'), { code: 1 });
  const draftPath = path.resolve(String(args.draft));
  const draft = readJson(draftPath);
  if (!draft) throw Object.assign(new Error(`draft not found or not valid JSON: ${draftPath}`), { code: 1 });
  if (!draft.type || !draft.fields) throw Object.assign(new Error("draft needs 'type' and 'fields'"), { code: 1 });
  const receiptPath = `${draftPath}.receipt.json`;
  // The draft names its destination when it has one; the hash binds whatever was resolved.
  const ctx = context({ ...args, org: draft.organization || args.org, project: draft.project || args.project }, deps);
  const a = auth(deps);
  const parentId = draft.parentId ? Number(draft.parentId) : null;

  const types = await R.getTypes(ctx, a, deps);
  const typeFields = types.includes(draft.type) ? await R.getTypeFields(ctx, a, draft.type, deps) : null;
  let parent = null;
  if (parentId) {
    try { const p = R.toItem(await R.getItem(ctx, a, parentId, deps)); parent = { id: p.id, project: p.project, type: p.type, title: p.title }; } catch (e) { parent = { error: e.message }; }
  }
  const { checks, problems } = L.validateDraft(draft, ctx, { types, typeFields, parent });
  const patch = L.buildPatch(ctx.org, draft.fields, parentId);
  const hash = L.draftHash({ org: ctx.org, project: ctx.project, type: draft.type, parentId, patch });
  const title = draft.fields['System.Title'];

  if (!args.approved) {
    return {
      code: problems.length ? 1 : 0,
      out: {
        mode: 'PREVIEW', organization: ctx.org, project: ctx.project, type: draft.type, parentId,
        parent: parent && !parent.error ? `${parent.type} ${parent.id} - ${parent.title}` : null,
        draftHash: hash, valid: problems.length === 0, checks, problems, patch,
        receipt: fs.existsSync(receiptPath) ? receiptPath : null,
        next: problems.length ? 'NOTHING HAS BEEN CREATED. Fix the problems, then preview again.'
          : `NOTHING HAS BEEN CREATED. After the user approves THIS exact content: placement.js create --draft "${draftPath}" --approved ${hash}`,
      },
    };
  }
  if (problems.length) return { code: 1, out: { mode: 'INVALID', problems, detail: 'Draft failed validation; nothing was sent.' } };
  if (String(args.approved).trim().toLowerCase() !== hash) {
    return { code: 3, out: { mode: 'REFUSED', detail: `The draft or its destination changed after the approved preview (approved ${args.approved}, current ${hash}). Preview again and ask for approval of the new content. Nothing was sent.` } };
  }

  const stamp = { draftHash: hash, organization: ctx.org, project: ctx.project, title, type: draft.type };
  if (!claimReceipt(receiptPath, { state: 'in-flight', ...stamp, startedAt: deps.now() })) return refusedByReceipt(receiptPath, title);

  let created;
  try {
    created = await R.createItem(ctx, a, draft.type, patch, deps);
  } catch (e) {
    // A definitive 4xx means nothing was created: release the receipt so the draft can be fixed
    // and retried. Anything else (timeout, 5xx) looks exactly like a lost success: keep it.
    if (L.isDefinitiveRejection(e.status)) {
      fs.rmSync(receiptPath, { force: true });
      return { code: 1, out: { mode: 'REJECTED', detail: `${e.message}. Azure DevOps rejected the request; nothing was created and the receipt was released. Fix the cause and run again.`, body: e.body } };
    }
    fs.writeFileSync(receiptPath, JSON.stringify({ state: 'failed', ...stamp, failedAt: deps.now(), error: e.message }, null, 2) + '\n');
    return { code: 1, out: { mode: 'UNKNOWN', receipt: receiptPath, detail: `${e.message}. Recorded in the receipt. Check that the item was not created before running again.` } };
  }

  const url = `${ctx.org}/${encodeURIComponent(ctx.project)}/_workitems/edit/${created.id}`;
  fs.writeFileSync(receiptPath, JSON.stringify({ state: 'created', id: created.id, url, ...stamp, publishedAt: deps.now() }, null, 2) + '\n');

  let verification;
  let readBack = null;
  try {
    readBack = await R.getItem(ctx, a, created.id, deps);
    verification = L.compareReadBack(draft, readBack);
  } catch (e) {
    verification = { verdict: 'unread', mismatches: [`read-back failed: ${e.message}`] };
  }
  const f = (readBack && readBack.fields) || {};
  return {
    code: verification.verdict === 'verified' ? 0 : 5,
    out: {
      mode: 'COMMITTED', id: created.id, url, type: f['System.WorkItemType'] || draft.type, title: f['System.Title'] || title,
      state: f['System.State'] || null, parentId: verification.parentId === undefined ? parentId : verification.parentId,
      verification, receipt: receiptPath,
      ...(verification.verdict === 'verified' ? {} : { detail: `Work item ${created.id} WAS created but could not be confirmed against the approved draft. Do not retry; report it with the URL.` }),
    },
  };
}

// --- main ----------------------------------------------------------------------------------

const COMMANDS = { context: cmdContext, projects: cmdProjects, duplicates: cmdDuplicates, candidates: cmdCandidates, create: cmdCreate };

async function main(argv, deps = defaultDeps()) {
  const args = ado.parseArgs(argv);
  const cmd = COMMANDS[args._[0]];
  try {
    if (!cmd) throw new Error('usage: placement.js context | projects [--project P] | duplicates --text T | candidates --text T [--type Feature|Epic] | create --draft file.json [--approved <hash>]');
    const r = await cmd(args, deps);
    process.stdout.write(JSON.stringify(r.out, null, 2) + '\n');
    return r.code;
  } catch (e) {
    process.stderr.write(`ado-backlog-placement: ${e.message}\n`);
    return e.code === 'needs-choice' ? 2 : 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = { main, cmdContext, cmdProjects, cmdDuplicates, cmdCandidates, cmdCreate, claimReceipt };
