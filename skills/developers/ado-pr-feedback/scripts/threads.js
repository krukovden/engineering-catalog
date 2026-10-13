#!/usr/bin/env node
'use strict';
// Read and change pull request threads through REST (`az repos` has no thread verb).
//
//   node threads.js list       --pr <id> [--org URL --project NAME] [--all]
//   node threads.js set-status --pr <id> --thread <id> --status fixed|wontFix|closed --approved
//   node threads.js reply      --pr <id> --thread <id> --text "<reply>" --approved
//
// Writes refuse to run without --approved: the user approves the list first.
const ado = require('./ado');

const WRITABLE_STATUS = ['fixed', 'wontFix', 'closed'];

// Threads → compact list. Drops deleted threads and threads made only of system comments
// (vote changes, policy notices) unless includeSystem is set.
function simplifyThreads(payload, { includeResolved = false, includeSystem = false } = {}) {
  const threads = (payload && payload.value) || [];
  const out = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    const comments = (t.comments || [])
      .filter((c) => !c.isDeleted && (includeSystem || c.commentType !== 'system'))
      .map((c) => ({ id: c.id, author: c.author && c.author.displayName, content: c.content, published: c.publishedDate }));
    if (!comments.length) continue;
    const status = t.status || 'unknown';
    if (!includeResolved && status !== 'active' && status !== 'pending') continue;
    const ctx = t.threadContext || {};
    out.push({
      id: t.id,
      status,
      file: ctx.filePath || null,
      // verify: rightFileStart is the line in the PR's target version; leftFileStart for removed lines
      line: (ctx.rightFileStart && ctx.rightFileStart.line) || (ctx.leftFileStart && ctx.leftFileStart.line) || null,
      comments,
    });
  }
  return out;
}

function statusPayload(status) {
  if (!WRITABLE_STATUS.includes(status)) throw new Error(`status must be one of ${WRITABLE_STATUS.join(', ')}`);
  return { status };
}

// parentCommentId 1 = reply to the thread's first comment; commentType 1 = text (verify).
function replyPayload(text) {
  if (!text || !String(text).trim()) throw new Error('reply text is empty');
  return { content: String(text), parentCommentId: 1, commentType: 1 };
}

function requireApproved(args) {
  if (!args.approved) throw new Error('refusing to write: pass --approved only after the user approved the list');
}

function need(args, key) {
  if (args[key] === undefined || args[key] === true) throw new Error(`missing --${key}`);
  return args[key];
}

async function run(argv, env = process.env, fetchImpl = fetch) {
  const args = ado.parseArgs(argv);
  const cmd = args._[0];
  if (!['list', 'set-status', 'reply'].includes(cmd)) throw new Error('usage: threads.js list|set-status|reply --pr <id> ...');
  const pr = need(args, 'pr');
  if (cmd !== 'list') requireApproved(args);
  const body = cmd === 'set-status' ? statusPayload(need(args, 'status')) : cmd === 'reply' ? replyPayload(need(args, 'text')) : null;
  const ctx = ado.resolveContext(args, env);
  const auth = ado.resolveAuth(env);
  const info = await ado.getPullRequest(auth, ctx.org, pr, fetchImpl);
  const project = info.projectName || ctx.project;
  const base = `${ctx.org}/${encodeURIComponent(project)}/_apis/git/repositories/${info.repositoryId}/pullRequests/${pr}/threads`;
  if (cmd === 'list') {
    const raw = await ado.request(auth, 'GET', ado.apiUrl(base, ''), undefined, fetchImpl);
    return { pr: info.id, title: info.title, threads: simplifyThreads(raw, { includeResolved: !!args.all }) };
  }
  const thread = need(args, 'thread');
  if (cmd === 'set-status') {
    const r = await ado.request(auth, 'PATCH', ado.apiUrl(`${base}/${thread}`, ''), body, fetchImpl);
    return { pr: info.id, thread: Number(thread), status: r && r.status };
  }
  const r = await ado.request(auth, 'POST', ado.apiUrl(`${base}/${thread}/comments`, ''), body, fetchImpl);
  return { pr: info.id, thread: Number(thread), commentId: r && r.id };
}

module.exports = { simplifyThreads, statusPayload, replyPayload, requireApproved, run, WRITABLE_STATUS };

if (require.main === module) {
  run(process.argv.slice(2)).then(
    (out) => console.log(JSON.stringify(out)),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
