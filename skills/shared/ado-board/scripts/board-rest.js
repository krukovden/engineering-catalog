'use strict';
// ado-board REST reads and the one write (a state transition). Shapes marked "verify" were
// taken from the docs, not a live capture; see references/rest.md.
const ado = require('./ado.js');
const L = require('./board-logic.js');

const ITEM_FIELDS = ['System.Id', 'System.WorkItemType', 'System.State', 'System.Tags', 'System.Title', 'Microsoft.VSTS.Common.StateChangeDate'];
const PR_PAGE = 100;
const PR_MAX_PAGES = 20;

const enc = encodeURIComponent;
const projUrl = (ctx) => `${ctx.org}/${enc(ctx.project)}`;

async function getTypes(ctx, auth, deps) {
  const r = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), '_apis/wit/workitemtypes'), undefined, { fetch: deps.fetch });
  return r.value || [];
}

async function getStates(ctx, auth, type, deps) {
  const r = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/wit/workitemtypes/${enc(type)}/states`), undefined, { fetch: deps.fetch });
  return (r.value || []).map((s) => ({ name: s.name, category: s.category }));
}

function toItem(w) {
  const f = (w && w.fields) || {};
  return { id: w.id, rev: w.rev, type: f['System.WorkItemType'], state: f['System.State'], tags: f['System.Tags'] || '', title: f['System.Title'] || '', stateChangeDate: f['Microsoft.VSTS.Common.StateChangeDate'] || null };
}

async function getItem(ctx, auth, id, deps) {
  return toItem(await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/wit/workitems/${id}`, { fields: ITEM_FIELDS.join(',') }), undefined, { fetch: deps.fetch }));
}

async function getItems(ctx, auth, ids, deps, timeoutMs) {
  const out = {};
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const r = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), '_apis/wit/workitems', { ids: chunk.join(','), fields: ITEM_FIELDS.join(','), errorPolicy: 'omit' }), undefined, { fetch: deps.fetch, timeoutMs });
    for (const w of r.value || []) if (w) out[w.id] = toItem(w);
  }
  return out;
}

// Items in a `doing` state, assigned to the caller unless `everyone`.
async function queryDoing(ctx, auth, map, deps, { everyone = false, timeoutMs } = {}) {
  const states = new Set();
  for (const t of Object.values(map.types)) for (const [s, b] of Object.entries(t.states)) if (b === 'doing') states.add(s);
  if (!states.size) return [];
  const list = [...states].map((s) => `'${s.replace(/'/g, "''")}'`).join(', ');
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.State] IN (${list})${everyone ? '' : ' AND [System.AssignedTo] = @Me'}`;
  const r = await ado.request(auth, 'POST', ado.apiUrl(projUrl(ctx), '_apis/wit/wiql', { $top: '200' }), { query }, { fetch: deps.fetch, timeoutMs });
  return (r.workItems || []).map((w) => w.id);
}

// verify: GET .../git/repositories/{repo}/stats/branches -> value[{ name, aheadCount, commit: { commitId, committer: { date } } }]
async function getBranches(ctx, auth, repoName, deps, timeoutMs) {
  const repo = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/git/repositories/${enc(repoName)}`), undefined, { fetch: deps.fetch, timeoutMs });
  const stats = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/git/repositories/${repo.id}/stats/branches`), undefined, { fetch: deps.fetch, timeoutMs });
  const branches = (stats.value || []).map((b) => ({
    name: b.name, ahead: b.aheadCount || 0, commit: b.commit && b.commit.commitId,
    date: b.commit && ((b.commit.committer && b.commit.committer.date) || (b.commit.author && b.commit.author.date)),
  }));
  return { repoId: repo.id, defaultBranch: String(repo.defaultBranch || 'refs/heads/main').replace(/^refs\/heads\//, ''), branches };
}

// Completed PRs through the PR API: squash merges leave nothing for `git log --merges`.
// Pages with $skip until a short page; the server bounds the list by closed time (verify), and
// the date is filtered again here. Past PR_MAX_PAGES the coverage says it is incomplete.
// verify: completionOptions.transitionWorkItems is set when "complete linked work items" was on.
async function getCompletedPrs(ctx, auth, repoId, sinceMs, deps) {
  const since = new Date(sinceMs).toISOString();
  const found = new Map();
  let pages = 0;
  let complete = false;
  while (pages < PR_MAX_PAGES) {
    const r = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/git/repositories/${repoId}/pullrequests`, {
      'searchCriteria.status': 'completed', 'searchCriteria.queryTimeRangeType': 'closed', 'searchCriteria.minTime': since,
      $top: String(PR_PAGE), $skip: String(pages * PR_PAGE),
    }), undefined, { fetch: deps.fetch });
    const page = r.value || [];
    pages++;
    for (const p of page) if (Date.parse(p.closedDate) >= sinceMs) found.set(p.pullRequestId, p);
    if (page.length < PR_PAGE) { complete = true; break; }
  }
  const prs = [];
  for (const p of found.values()) {
    const links = await ado.request(auth, 'GET', ado.apiUrl(projUrl(ctx), `_apis/git/repositories/${repoId}/pullRequests/${p.pullRequestId}/workitems`), undefined, { fetch: deps.fetch });
    prs.push({
      id: p.pullRequestId, title: p.title, sourceRefName: p.sourceRefName, closedDate: p.closedDate,
      transitionWorkItems: !!(p.completionOptions && p.completionOptions.transitionWorkItems),
      workItemIds: ((links && links.value) || []).map((w) => Number(w.id)).filter(Boolean),
    });
  }
  const coverage = { since, read: prs.length, pages, complete };
  if (!complete) coverage.warning = `Not every completed pull request since ${since} was read (stopped after ${pages} pages of ${PR_PAGE}). Items linked only from the unread ones are not reconciled: run again with a smaller --since.`;
  return { prs, coverage };
}

async function patchState(ctx, auth, d, comment, deps) {
  return ado.request(auth, 'PATCH', ado.apiUrl(projUrl(ctx), `_apis/wit/workitems/${d.id}`), L.movePatch(d.rev, d.toState, comment), { fetch: deps.fetch, contentType: 'application/json-patch+json' });
}

// verify: a failed `test /rev` answers 412 (409 accepted too).
const isConflict = (e) => e && (e.status === 409 || e.status === 412);

// One PATCH, guarded by the revision `d` was decided on, so a stale decision never lands. On a
// conflict the item is read again: a changed work item type refuses, otherwise the same rules
// (idp:, Removed, forward only) decide once more; a second conflict refuses. A refused transition that needs a field names it and stops.
// `describe(d)` builds the evidence comment for the transition actually written.
async function applyMove(ctx, auth, map, d, describe, deps, { allowIdp = false } = {}) {
  let cur = d;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!Number.isInteger(cur.rev)) return { id: d.id, outcome: 'error', detail: `work item ${d.id} was read without a revision; nothing was written` };
    try {
      await patchState(ctx, auth, cur, describe(cur), deps);
      return { id: d.id, outcome: 'moved', from: cur.fromState, to: cur.toState };
    } catch (e) {
      if (!isConflict(e)) {
        const req = e.status === 400 ? L.requiredFieldFromError(e.body) : null;
        if (req) return { id: d.id, outcome: 'field-required', field: req.field, fieldName: req.name, detail: `Moving ${d.id} to "${cur.toState}" needs the field "${req.name}"${req.field ? ` (${req.field})` : ''}. Set it on the work item yourself, then run move again. ado-board never invents a value.` };
        return { id: d.id, outcome: 'error', detail: e.message };
      }
      if (attempt) break;
    }
    let fresh;
    try { fresh = await getItem(ctx, auth, d.id, deps); } catch (e) { return { id: d.id, outcome: 'error', detail: `work item ${d.id} changed since it was read and could not be read again: ${e.message}` }; }
    // The bucket was chosen for the type that was read (a completed PR earns `testing`, a Bug
    // `verify`, or `done`, by type); a different type invalidates the whole decision.
    if (fresh.type !== d.type) {
      return { id: d.id, outcome: 'refused', code: 'type-changed', reason: `changed since it was read (rev ${cur.rev} → ${fresh.rev}): type ${d.type} → ${fresh.type}; the move was decided for ${d.type}. Look at the card, then run the command again.` };
    }
    const again = L.checkMove({ map, item: fresh, bucket: d.to, allowIdp });
    if (!again.ok) {
      return { id: d.id, outcome: again.code === 'same' ? 'unchanged' : 'refused', code: again.code, reason: `changed since it was read (rev ${cur.rev} → ${fresh.rev}): ${again.reason}` };
    }
    cur = again;
  }
  return { id: d.id, outcome: 'conflict', detail: `Work item ${d.id} changed again while ado-board was moving it (rev ${cur.rev}); nothing was written. Look at the card, then run the command again.` };
}

module.exports = {
  ITEM_FIELDS, PR_PAGE, PR_MAX_PAGES,
  getTypes, getStates, toItem, getItem, getItems, queryDoing, getBranches, getCompletedPrs, applyMove,
};
