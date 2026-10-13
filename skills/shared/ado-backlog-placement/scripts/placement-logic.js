'use strict';
// Pure logic for ado-backlog-placement: tokenising, duplicate matching, parent ranking, the
// publish draft (patch, approval hash, validation, read-back). No I/O; tested offline.
const crypto = require('crypto');

// House rule, as in qa-ado-work-item: a title that does not fit on a board card is not doing its job.
const TITLE_LIMIT = 100;
const RECENT_DAYS = 30;
const WEIGHTS = { title: 2, description: 1, iteration: 2, repository: 2, recent: 1 };
// Backlog item types in preference order: Scrum, Agile, CMMI, Basic; Task last.
const ITEM_TYPES = ['Product Backlog Item', 'User Story', 'Requirement', 'Issue', 'Task'];
const DUPLICATE_TYPES = ['Product Backlog Item', 'User Story', 'Requirement', 'Issue', 'Task', 'Bug'];

const STOP_WORDS = new Set((
  'a an and are as at be been but by can could do does for from has have how i if in into is it its '
  + 'let me my need needs not of on or our should so some than that the their them then there these '
  + 'this those to up us was we were what when where which while who why will with would you your '
  + 'add adds added make makes making new get gets work working start starting task item please want '
  + 'also all any each more most other same such only own very just via per'
).split(' '));

function plainText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();
}

// Lowercased significant words, plural "s" folded ("reports" → "report"), stop words and
// one- and two-letter words dropped. Returns a Set.
function tokenize(text) {
  const out = new Set();
  for (let w of plainText(text).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP_WORDS.has(w)) continue;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (!STOP_WORDS.has(w)) out.add(w);
  }
  return out;
}

const shared = (query, words) => [...query].filter((w) => words.has(w));

// --- duplicates ----------------------------------------------------------------------

// Credible when the item shares at least half of the task's significant words, and at least two
// of them (one when the task has only one).
function isDuplicate(queryTokens, itemTokens) {
  const matched = shared(queryTokens, itemTokens);
  const need = Math.min(2, queryTokens.size);
  return { matched, credible: need > 0 && matched.length >= need && matched.length / queryTokens.size >= 0.5 };
}

// items: [{ id, type, state, title, description }]
function findDuplicates(text, items) {
  const q = tokenize(text);
  return items
    .map((it) => {
      const words = new Set([...tokenize(it.title), ...tokenize(it.description)]);
      const d = isDuplicate(q, words);
      return { id: it.id, type: it.type, state: it.state, title: it.title, matched: d.matched, credible: d.credible };
    })
    .filter((x) => x.credible)
    .sort((a, b) => b.matched.length - a.matched.length || a.id - b.id);
}

// --- candidates ----------------------------------------------------------------------

const underPath = (p, root) => {
  if (!p || !root) return false;
  const a = String(p).toLowerCase();
  const b = String(root).toLowerCase();
  return a === b || a.startsWith(b + '\\');
};

// True when a relation is an artifact link (PR or branch) into this repository (verify the URL shape).
function linksRepository(relations, repoId) {
  if (!repoId) return false;
  const id = String(repoId).toLowerCase();
  return (relations || []).some((r) => r && r.rel === 'ArtifactLink'
    && /^vstfs:\/\/\/git\/(pullrequestid|ref)\//i.test(r.url || '')
    && decodeURIComponent(String(r.url)).toLowerCase().includes(`/${id}/`));
}

/**
 * One candidate's score, every part printed so the user sees why.
 * candidate: { id, title, description, iterationPath, changedDate, relations }
 * ctx: { queryTokens, iterationPath, repoId, nowMs, recentDays }
 */
function scoreCandidate(candidate, ctx) {
  const titleWords = shared(ctx.queryTokens, tokenize(candidate.title));
  const descWords = shared(ctx.queryTokens, tokenize(candidate.description)).filter((w) => !titleWords.includes(w));
  const parts = [];
  if (titleWords.length) parts.push({ part: 'title', points: WEIGHTS.title * titleWords.length, words: titleWords });
  if (descWords.length) parts.push({ part: 'description', points: WEIGHTS.description * descWords.length, words: descWords });
  const fits = parts.length > 0;
  if (underPath(candidate.iterationPath, ctx.iterationPath)) parts.push({ part: 'iteration', points: WEIGHTS.iteration, detail: ctx.iterationPath });
  if (linksRepository(candidate.relations, ctx.repoId)) parts.push({ part: 'repository', points: WEIGHTS.repository, detail: 'linked PR or branch in this repository' });
  const days = ctx.recentDays || RECENT_DAYS;
  const changed = Date.parse(candidate.changedDate || '');
  if (Number.isFinite(changed) && ctx.nowMs - changed <= days * 86400000) parts.push({ part: 'recent', points: WEIGHTS.recent, detail: `changed in the last ${days} days` });
  return { id: candidate.id, title: candidate.title, state: candidate.state, fits, score: parts.reduce((s, p) => s + p.points, 0), parts };
}

// Only candidates sharing a word with the task fit; bonuses order them, never qualify them.
function rankCandidates(text, candidates, ctx = {}) {
  const queryTokens = tokenize(text);
  const scored = candidates.map((c) => scoreCandidate(c, { ...ctx, queryTokens }));
  const fitting = scored.filter((s) => s.fits).sort((a, b) => b.score - a.score || a.id - b.id);
  return { words: [...queryTokens], ranked: fitting.slice(0, ctx.top || 3), considered: candidates.length };
}

function pickItemType(available) {
  const names = new Set(available);
  return ITEM_TYPES.find((t) => names.has(t)) || null;
}

// --- WIQL ----------------------------------------------------------------------------

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// areas: [{ value, includeChildren }] from teamfieldvalues.
function wiqlOpen({ types, closedStates = [], areas = [] }) {
  const where = ['[System.TeamProject] = @project', `[System.WorkItemType] IN (${types.map(q).join(', ')})`];
  if (closedStates.length) where.push(`[System.State] NOT IN (${closedStates.map(q).join(', ')})`);
  if (areas.length) where.push(`(${areas.map((a) => `[System.AreaPath] ${a.includeChildren ? 'UNDER' : '='} ${q(a.value)}`).join(' OR ')})`);
  return `SELECT [System.Id] FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [System.ChangedDate] DESC`;
}

// --- git remote ----------------------------------------------------------------------

// Copied from ado-board: https://dev.azure.com/ORG/PROJECT/_git/REPO,
// https://ORG.visualstudio.com/[DefaultCollection/]PROJECT/_git/REPO, git@ssh.dev.azure.com:v3/ORG/PROJECT/REPO,
// ORG@vs-ssh.visualstudio.com:v3/ORG/PROJECT/REPO.
function parseRemoteUrl(url) {
  const u = String(url || '').trim();
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  let m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+?)(?:\.git)?\/?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  m = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::|\/)v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(u);
  if (m) return { org: `https://dev.azure.com/${m[1]}`, project: dec(m[2]), repo: dec(m[3]) };
  return null;
}

// --- publish -------------------------------------------------------------------------

// Same patch as qa-ado-work-item/publish-work-item.ps1: fields in draft order, empty values
// dropped, then the parent link.
function buildPatch(org, fields, parentId) {
  const patch = [];
  for (const [name, value] of Object.entries(fields || {})) {
    if (value !== null && value !== undefined && String(value) !== '') patch.push({ op: 'add', path: `/fields/${name}`, value });
  }
  if (parentId) {
    patch.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${String(org).replace(/\/+$/, '')}/_apis/wit/workItems/${parentId}`, attributes: { comment: 'Parent' } } });
  }
  return patch;
}

// Twin of the PowerShell rule: "<org, no trailing slash, lowercase>|<project lowercase>|<type>|<parentId>|<patch JSON>",
// SHA-256, first 16 hex characters. Reformatting the draft file does not move it; any content,
// type, parent or destination change does.
function canonical({ org, project, type, parentId, patch }) {
  return `${String(org).replace(/\/+$/, '').toLowerCase()}|${String(project).toLowerCase()}|${type}|${parentId || ''}|${JSON.stringify(patch)}`;
}

function draftHash(parts) {
  return crypto.createHash('sha256').update(canonical(parts), 'utf8').digest('hex').slice(0, 16);
}

/**
 * Checks a draft against what the project says. facts: { types: [name], typeFields: [refName] | null,
 * parent: { id, project, type, title } | null | { error } }. Returns { checks, problems }.
 */
function validateDraft(draft, ctx, facts) {
  const checks = [];
  const add = (check, ok, detail) => checks.push({ check, ok, detail });
  const type = draft.type;
  const fields = draft.fields || {};
  const hasType = facts.types.includes(type);
  add('type-exists', hasType, hasType ? `'${type}' exists in ${ctx.project}` : `'${type}' is not a work item type in ${ctx.project}. Available: ${facts.types.join(', ')}`);
  const title = fields['System.Title'];
  add('title-present', !!title, title ? 'present' : 'System.Title is required');
  if (title) add('title-length', String(title).length <= TITLE_LIMIT, `${String(title).length} characters (limit ${TITLE_LIMIT})`);
  if (hasType && facts.typeFields) {
    const unknown = Object.keys(fields).filter((f) => !facts.typeFields.includes(f));
    add('fields-exist-on-type', unknown.length === 0, unknown.length ? `not fields of '${type}': ${unknown.join(', ')}` : `all field reference names exist on '${type}'`);
  }
  if (draft.parentId) {
    const p = facts.parent;
    if (!p || p.error) add('parent-exists', false, `parent ${draft.parentId} could not be read${p && p.error ? `: ${p.error}` : ''}`);
    else {
      const same = String(p.project).toLowerCase() === String(ctx.project).toLowerCase();
      add('parent-in-project', same, same ? `${p.type} ${p.id} - ${p.title}` : `parent ${p.id} is in project '${p.project}', not '${ctx.project}'`);
    }
  } else add('parent', true, 'none - item will be created unparented');
  return { checks, problems: checks.filter((c) => !c.ok).map((c) => `${c.check} - ${c.detail}`) };
}

// Azure DevOps rewrites HTML fields, so a difference only in markup is "normalized", not a mismatch.
function compareReadBack(draft, readBack) {
  const f = (readBack && readBack.fields) || {};
  const comparisons = [];
  const mismatches = [];
  for (const [name, value] of Object.entries(draft.fields || {})) {
    if (value === null || value === undefined || String(value) === '') continue;
    const sent = String(value);
    const got = f[name] === undefined || f[name] === null ? '' : String(f[name]);
    const verdict = sent === got ? 'exact' : plainText(sent) === plainText(got) ? 'normalized' : 'differs';
    comparisons.push({ field: name, verdict });
    if (verdict === 'differs') mismatches.push(name);
  }
  if (f['System.WorkItemType'] !== draft.type) mismatches.push(`System.WorkItemType (asked '${draft.type}', got '${f['System.WorkItemType']}')`);
  const rel = ((readBack && readBack.relations) || []).find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  const actualParent = rel ? Number(String(rel.url).split('/').pop()) : null;
  if (draft.parentId && actualParent !== Number(draft.parentId)) mismatches.push(`parent (asked ${draft.parentId}, got ${actualParent})`);
  if (!draft.parentId && actualParent) mismatches.push(`parent (asked none, got ${actualParent})`);
  return { verdict: mismatches.length ? 'mismatch' : 'verified', fields: comparisons, mismatches, parentId: actualParent };
}

// A rejection Azure DevOps answered definitively: nothing was created, the receipt is released.
const isDefinitiveRejection = (status) => [400, 401, 403, 404, 422].includes(status);

module.exports = {
  TITLE_LIMIT, RECENT_DAYS, WEIGHTS, ITEM_TYPES, DUPLICATE_TYPES, STOP_WORDS,
  plainText, tokenize, isDuplicate, findDuplicates, linksRepository, scoreCandidate, rankCandidates,
  pickItemType, wiqlOpen, parseRemoteUrl, buildPatch, canonical, draftHash, validateDraft, compareReadBack, isDefinitiveRejection,
};
