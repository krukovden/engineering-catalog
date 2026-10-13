'use strict';
// ado-backlog-placement REST reads and the one write (create a work item). Shapes marked
// "verify" come from the documentation, not a live capture; see references/rest.md.
const ado = require('./ado.js');
const L = require('./placement-logic.js');

const enc = encodeURIComponent;
const projUrl = (ctx) => `${ctx.org}/${enc(ctx.project)}`;
const teamUrl = (ctx, team) => `${projUrl(ctx)}/${enc(team)}`;
const get = (auth, url, deps) => ado.request(auth, 'GET', url, undefined, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });

async function listProjects(ctx, auth, deps) {
  const r = await get(auth, ado.apiUrl(ctx.org, '_apis/projects', { $top: '500' }), deps);
  return (r.value || []).map((p) => p.name).sort((a, b) => a.localeCompare(b));
}

async function listTeams(ctx, auth, project, deps) {
  const r = await get(auth, ado.apiUrl(ctx.org, `_apis/projects/${enc(project)}/teams`, { $top: '500' }), deps);
  return (r.value || []).map((t) => t.name).sort((a, b) => a.localeCompare(b));
}

// verify: GET _apis/projects/{p} -> { id, defaultTeam: { name } }
async function getProject(ctx, auth, deps) {
  const r = await get(auth, ado.apiUrl(ctx.org, `_apis/projects/${enc(ctx.project)}`), deps);
  return { id: r.id, defaultTeam: (r.defaultTeam && r.defaultTeam.name) || null };
}

// The team's area paths and current iteration. Falls back to the credentials context's area
// path when the team settings cannot be read.
// verify: teamfieldvalues -> { values: [{ value, includeChildren }] }; iterations?$timeframe=current -> value[{ path }]
async function getTeamScope(ctx, auth, team, deps) {
  let areas = [];
  try {
    const r = await get(auth, ado.apiUrl(teamUrl(ctx, team), '_apis/work/teamsettings/teamfieldvalues'), deps);
    areas = (r.values || []).map((v) => ({ value: v.value, includeChildren: !!v.includeChildren }));
  } catch (e) {
    if (!ctx.areaPath) throw e;
  }
  if (!areas.length && ctx.areaPath) areas = [{ value: ctx.areaPath, includeChildren: true }];
  let iterationPath = null;
  try {
    const r = await get(auth, ado.apiUrl(teamUrl(ctx, team), '_apis/work/teamsettings/iterations', { $timeframe: 'current' }), deps);
    iterationPath = ((r.value || [])[0] || {}).path || null;
  } catch { /* no current iteration */ }
  return { areas, areaPath: areas.length ? areas[0].value : null, iterationPath };
}

async function getTypes(ctx, auth, deps) {
  const r = await get(auth, ado.apiUrl(projUrl(ctx), '_apis/wit/workitemtypes'), deps);
  return (r.value || []).filter((t) => !t.isDisabled).map((t) => t.name);
}

async function getTypeFields(ctx, auth, type, deps) {
  const r = await get(auth, ado.apiUrl(projUrl(ctx), `_apis/wit/workitemtypes/${enc(type)}/fields`), deps);
  return (r.value || []).map((f) => f.referenceName);
}

// States in the Completed and Removed categories of the given types: what "open" excludes.
async function closedStates(ctx, auth, types, deps) {
  const out = new Set();
  for (const t of types) {
    const r = await get(auth, ado.apiUrl(projUrl(ctx), `_apis/wit/workitemtypes/${enc(t)}/states`), deps);
    for (const s of r.value || []) if (s.category === 'Completed' || s.category === 'Removed') out.add(s.name);
  }
  return [...out];
}

async function wiql(ctx, auth, query, deps) {
  const r = await ado.request(auth, 'POST', ado.apiUrl(projUrl(ctx), '_apis/wit/wiql', { $top: '200' }), { query }, { fetch: deps.fetch, timeoutMs: deps.timeoutMs });
  return (r.workItems || []).map((w) => w.id);
}

function toItem(w) {
  const f = (w && w.fields) || {};
  return {
    id: w.id, type: f['System.WorkItemType'], state: f['System.State'], title: f['System.Title'] || '',
    description: f['System.Description'] || '', iterationPath: f['System.IterationPath'] || '',
    areaPath: f['System.AreaPath'] || '', project: f['System.TeamProject'] || '',
    changedDate: f['System.ChangedDate'] || null, relations: w.relations || [],
  };
}

// $expand=relations returns every field; `fields` cannot be combined with it.
async function getItems(ctx, auth, ids, deps) {
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await get(auth, ado.apiUrl(projUrl(ctx), '_apis/wit/workitems', { ids: ids.slice(i, i + 200).join(','), $expand: 'relations', errorPolicy: 'omit' }), deps);
    for (const w of r.value || []) if (w) out.push(toItem(w));
  }
  return out;
}

async function getItem(ctx, auth, id, deps) {
  return get(auth, ado.apiUrl(projUrl(ctx), `_apis/wit/workitems/${enc(id)}`, { $expand: 'relations' }), deps);
}

async function getRepoId(ctx, auth, repo, deps) {
  const r = await get(auth, ado.apiUrl(projUrl(ctx), `_apis/git/repositories/${enc(repo)}`), deps);
  return r.id || null;
}

async function createItem(ctx, auth, type, patch, deps) {
  return ado.request(auth, 'POST', ado.apiUrl(projUrl(ctx), `_apis/wit/workitems/$${enc(type)}`), patch, { fetch: deps.fetch, timeoutMs: deps.timeoutMs, contentType: 'application/json-patch+json' });
}

// Open items of `types` in the team's area paths.
async function queryOpen(ctx, auth, scope, types, deps) {
  const present = await getTypes(ctx, auth, deps);
  const wanted = types.filter((t) => present.includes(t));
  if (!wanted.length) return { types: present, items: [] };
  const closed = await closedStates(ctx, auth, wanted, deps);
  const ids = await wiql(ctx, auth, L.wiqlOpen({ types: wanted, closedStates: closed, areas: scope.areas }), deps);
  return { types: present, items: ids.length ? await getItems(ctx, auth, ids, deps) : [] };
}

module.exports = {
  listProjects, listTeams, getProject, getTeamScope, getTypes, getTypeFields, closedStates, wiql,
  toItem, getItems, getItem, getRepoId, createItem, queryOpen,
};
