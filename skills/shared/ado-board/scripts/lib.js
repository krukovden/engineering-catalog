'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const readline = require('node:readline/promises');

const STATE_FILE_VERSION = 1;
const DEFAULT_STALE_DAYS = 7;
const DEFAULT_THROTTLE_HOURS = 12;
const CATEGORY_TO_BUCKET = {
  Proposed: 'todo',
  InProgress: 'doing',
  Resolved: 'verify',
  Completed: 'done',
  Removed: 'removed',
};
const BUCKET_ORDER = ['todo', 'doing', 'verify', 'done'];
const ACCESS_TOKEN_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

function homeDir(env = process.env) {
  return env.ENGCAT_HOME || os.homedir();
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeOrganization(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function git(cwd, args, { allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    if (allowFailure) return '';
    const stderr = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(stderr || `git ${args.join(' ')} failed`);
  }
}

function gitRefExists(cwd, ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      cwd,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function repoRoot(cwd) {
  const root = git(cwd, ['rev-parse', '--show-toplevel'], { allowFailure: true });
  return root || null;
}

function defaultProjectStatePath(cwd) {
  const root = repoRoot(cwd) || cwd;
  return path.join(root, '.engineering-catalog', 'ado-board.json');
}

function hookThrottlePath(env = process.env) {
  return path.join(homeDir(env), '.engineering-catalog', 'ado-board-reconcile.json');
}

function loadProjectState(file) {
  if (!fs.existsSync(file)) return null;
  return parseJsonFile(file);
}

function saveProjectState(file, state) {
  writeJsonFile(file, state);
}

function parseTags(value) {
  return String(value || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function hasIdpTag(item) {
  return parseTags(item.fields?.['System.Tags']).some((tag) => tag.toLowerCase().startsWith('idp:'));
}

function bucketRank(bucket) {
  return BUCKET_ORDER.indexOf(bucket);
}

function parseChoices(values = []) {
  const out = {};
  for (const raw of values) {
    const match = /^(.+?):(todo|doing|verify|done|removed)=(.+)$/.exec(String(raw).trim());
    if (!match) throw new Error(`Invalid --choose value "${raw}". Use "<type>:<bucket>=<state>".`);
    out[`${match[1]}::${match[2]}`] = match[3];
  }
  return out;
}

function inferBucketForState(typeMap, stateName) {
  if (!typeMap) return null;
  for (const [bucket, mappedState] of Object.entries(typeMap)) {
    if (bucket === 'removed' || bucket === 'choices' || bucket === 'categories') continue;
    if (mappedState === stateName) return bucket;
  }
  if (typeMap.removed === stateName) return 'removed';
  return null;
}

function parseBranchWorkItem(name) {
  const branch = String(name || '')
    .replace(/^refs\/heads\//, '')
    .replace(/^refs\/remotes\/origin\//, '')
    .replace(/^origin\//, '');
  let match = /^feature\/ADO-(\d+)(?:-|$)/i.exec(branch);
  if (match) return { id: match[1], kind: 'feature', branch };
  match = /^bug\/ADO-(\d+)(?:-|$)/i.exec(branch);
  if (match) return { id: match[1], kind: 'bug', branch };
  match = /^pbi\/(\d+)(?:-|$)/i.exec(branch);
  if (match) return { id: match[1], kind: 'pbi', branch };
  return null;
}

function parsePullRequestWorkItem(pr) {
  const linked = (pr.workItemRefs || []).map((ref) => String(ref.id)).filter(Boolean);
  if (linked.length) return linked;
  const byBranch = parseBranchWorkItem(pr.sourceRefName || pr.sourceRef || pr.branch || '');
  if (byBranch) return [byBranch.id];
  const matches = new Set();
  for (const text of [pr.title, pr.description]) {
    const source = String(text || '');
    let match;
    const pattern = /\b(?:feat|fix|bug)\((\d+)\)|#(\d+)\b/g;
    while ((match = pattern.exec(source)) !== null) {
      matches.add(match[1] || match[2]);
    }
  }
  return [...matches];
}

function listRemoteBranches(root) {
  const baseRef = gitRefExists(root, 'refs/remotes/origin/main')
    ? 'origin/main'
    : gitRefExists(root, 'refs/heads/main') ? 'main' : null;
  const output = git(root, ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)', 'refs/remotes/origin'], { allowFailure: true });
  if (!output) return [];
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, committedAt] = line.split('\t');
      return { name, sha, committedAt };
    })
    .filter((entry) => entry.name !== 'origin/HEAD' && entry.name !== 'origin/main')
    .map((entry) => {
      const ahead = baseRef ? Number(git(root, ['rev-list', '--count', `${baseRef}..${entry.name}`], { allowFailure: true }) || '0') : 0;
      return {
        ...entry,
        ahead,
        parsed: parseBranchWorkItem(entry.name),
      };
    })
    .filter((entry) => entry.ahead > 0);
}

function remoteOrigin(root) {
  return git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
}

function parseRepositoryName(remoteUrl) {
  const text = String(remoteUrl || '');
  let match = /\/_git\/([^/?#]+)(?:[/?#]|$)/.exec(text);
  if (match) return decodeURIComponent(match[1]);
  match = /[:/]v3\/[^/]+\/[^/]+\/([^/?#]+)(?:[/?#]|$)/.exec(text);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

function repoFingerprint(root) {
  const origin = remoteOrigin(root);
  if (origin) return origin;
  return root;
}

function daysBetween(now, iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  return (now.getTime() - then.getTime()) / 86400000;
}

function requiredFieldName(error) {
  const message = String(error?.message || error || '');
  const patterns = [
    /Field '([^']+)'/i,
    /field "([^"]+)"/i,
    /required field ([A-Za-z0-9_.-]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(message);
    if (match) return match[1];
  }
  return null;
}

async function chooseState({ typeName, bucket, category, states, nonInteractive, chooseMap, input = process.stdin, output = process.stdout }) {
  const key = `${typeName}::${bucket}`;
  if (chooseMap[key]) return { state: chooseMap[key], via: 'flag' };
  if (states.length === 1) return { state: states[0], via: 'single' };
  if (nonInteractive) {
    throw new Error(`State discovery needs a choice for ${typeName} ${bucket} (${category}): ${states.join(', ')}. Pass --choose "${typeName}:${bucket}=STATE".`);
  }
  if (!input.isTTY || !output.isTTY) {
    throw new Error(`State discovery cannot prompt for ${typeName} ${bucket} without a TTY. Pass --non-interactive with --choose.`);
  }
  const rl = readline.createInterface({ input, output });
  try {
    const prompt = [
      `${typeName} has multiple ${bucket} states in category ${category}. Choose one:`,
      ...states.map((state, index) => `  ${index + 1}. ${state}`),
      '> ',
    ].join('\n');
    const answer = await rl.question(prompt);
    const index = Number(answer.trim());
    if (!Number.isInteger(index) || index < 1 || index > states.length) {
      throw new Error(`Invalid choice "${answer.trim()}". Expected 1-${states.length}.`);
    }
    return { state: states[index - 1], via: 'prompt' };
  } finally {
    rl.close();
  }
}

async function discoverStates({
  transport,
  context,
  stateFile,
  choose = [],
  nonInteractive = false,
  input = process.stdin,
  output = process.stdout,
}) {
  const chooseMap = parseChoices(choose);
  const types = await transport.listWorkItemTypes(context);
  const stateMap = {};
  const resolved = [];
  for (const type of types) {
    const states = await transport.listWorkItemStates(context, type.name);
    const categories = {};
    for (const state of states) {
      const category = state.category || state.stateCategory || state.stateCategoryName;
      if (!category) continue;
      (categories[category] = categories[category] || []).push(state.name);
    }
    const mapped = { categories };
    for (const [category, bucket] of Object.entries(CATEGORY_TO_BUCKET)) {
      const options = categories[category] || [];
      if (options.length === 0) continue;
      if (bucket === 'removed') {
        mapped.removed = options[0];
        continue;
      }
      const choice = await chooseState({
        typeName: type.name,
        bucket,
        category,
        states: options,
        nonInteractive,
        chooseMap,
        input,
        output,
      });
      mapped[bucket] = choice.state;
      if (options.length > 1) {
        resolved.push({ type: type.name, bucket, category, chosen: choice.state, options, via: choice.via });
      }
    }
    stateMap[type.name] = mapped;
  }

  const current = loadProjectState(stateFile) || {};
  const next = {
    version: STATE_FILE_VERSION,
    organization: context.organization,
    project: context.project,
    updatedAt: new Date().toISOString(),
    stateMap,
    ...('path' in current ? { path: current.path } : {}),
  };
  saveProjectState(stateFile, next);
  return { ok: true, command: 'states-discover', stateFile, resolved, stateMap };
}

function manualEvidenceComment(cwd, targetBucket) {
  const root = repoRoot(cwd);
  if (!root) return `ado-board: moved to ${targetBucket}.`;
  const branch = git(root, ['branch', '--show-current'], { allowFailure: true });
  const sha = git(root, ['rev-parse', '--short', 'HEAD'], { allowFailure: true });
  const parts = [`ado-board: moved to ${targetBucket}`];
  if (branch) parts.push(`from ${branch}`);
  if (sha) parts.push(`at ${sha}`);
  return `${parts.join(' ')}.`;
}

async function moveWorkItem({
  transport,
  context,
  stateMap,
  id,
  targetBucket,
  comment,
  cwd = process.cwd(),
  workItem = null,
}) {
  if (!BUCKET_ORDER.includes(targetBucket) && targetBucket !== 'verify') {
    throw new Error(`Unknown bucket "${targetBucket}". Use todo, doing, verify or done.`);
  }
  const item = workItem || await transport.getWorkItem(context, id);
  if (hasIdpTag(item)) {
    return {
      ok: true,
      noop: true,
      id: String(id),
      reason: 'idp-tagged',
      from: inferBucketForState(stateMap[item.fields['System.WorkItemType']], item.fields['System.State']),
      to: targetBucket,
    };
  }
  const typeName = item.fields['System.WorkItemType'];
  const typeMap = stateMap[typeName];
  if (!typeMap) throw new Error(`No discovered state map for "${typeName}". Run "states discover" first.`);
  if (targetBucket === 'removed') throw new Error('ado-board never moves an item into Removed.');
  const currentState = item.fields['System.State'];
  const from = inferBucketForState(typeMap, currentState);
  if (!from) throw new Error(`State "${currentState}" for "${typeName}" is not in the discovered map.`);
  if (from === 'removed') throw new Error('ado-board never touches Removed items.');
  if (bucketRank(targetBucket) < bucketRank(from)) {
    throw new Error(`Refusing to move ${id} backwards (${from} → ${targetBucket}).`);
  }
  if (from === targetBucket) {
    return { ok: true, noop: true, id: String(id), from, to: targetBucket, state: currentState };
  }
  const targetState = typeMap[targetBucket];
  if (!targetState) throw new Error(`No "${targetBucket}" state is mapped for "${typeName}". Run "states discover" again.`);
  const evidence = comment || manualEvidenceComment(cwd, targetBucket);
  try {
    const updated = await transport.moveWorkItemState(context, {
      id: String(id),
      rev: item.rev,
      state: targetState,
      comment: evidence,
    });
    return {
      ok: true,
      id: String(id),
      from,
      to: targetBucket,
      state: targetState,
      comment: evidence,
      workItem: updated,
    };
  } catch (error) {
    const field = requiredFieldName(error);
    if (field) {
      return {
        ok: false,
        id: String(id),
        error: 'required-field',
        field,
        message: String(error.message || error),
      };
    }
    throw error;
  }
}

function parseMarkdownLinks(markdown) {
  const links = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    links.push({ text: match[1], target: match[2] });
  }
  return links;
}

function blueprintDrift(root) {
  const dir = path.join(root, 'docs', 'blueprint');
  if (!fs.existsSync(dir)) return [];
  const reports = [];
  for (const entry of fs.readdirSync(dir).filter((name) => name.endsWith('.md')).sort()) {
    const file = path.join(dir, entry);
    const markdown = fs.readFileSync(file, 'utf8');
    for (const link of parseMarkdownLinks(markdown)) {
      if (/^(https?:|mailto:|#)/i.test(link.target)) continue;
      const target = link.target.split('#')[0];
      if (!target) continue;
      const resolved = path.resolve(path.dirname(file), target);
      if (!fs.existsSync(resolved)) {
        reports.push({
          blueprint: path.relative(root, file).split(path.sep).join('/'),
          target,
          text: link.text,
        });
      }
    }
  }
  return reports;
}

function reconcileThrottle({ root, hours, env = process.env }) {
  if (!hours || hours <= 0) return { throttled: false };
  const file = hookThrottlePath(env);
  const key = hashText(repoFingerprint(root));
  const now = Date.now();
  let state = { projects: {} };
  if (fs.existsSync(file)) {
    try { state = parseJsonFile(file); } catch { state = { projects: {} }; }
  }
  const previous = state.projects?.[key];
  if (previous) {
    const last = new Date(previous);
    if (!Number.isNaN(last.getTime()) && (now - last.getTime()) < hours * 3600000) {
      return { throttled: true, lastRunAt: previous, file };
    }
  }
  state.projects = state.projects || {};
  state.projects[key] = new Date(now).toISOString();
  writeJsonFile(file, state);
  return { throttled: false, file, lastRunAt: state.projects[key] };
}

async function reconcileBoard({
  transport,
  context,
  stateMap,
  cwd = process.cwd(),
  staleDays = DEFAULT_STALE_DAYS,
  throttleHours = 0,
  env = process.env,
}) {
  const root = repoRoot(cwd);
  if (!root) throw new Error('reconcile needs a git repository.');
  const throttle = reconcileThrottle({ root, hours: throttleHours, env });
  if (throttle.throttled) {
    return { ok: true, command: 'reconcile', throttled: true, lastRunAt: throttle.lastRunAt };
  }

  const branches = listRemoteBranches(root);
  const repository = parseRepositoryName(remoteOrigin(root));
  const workCache = new Map();
  const moves = [];
  const skipped = [];

  async function getWorkItemCached(id) {
    if (!workCache.has(id)) workCache.set(id, await transport.getWorkItem(context, id));
    return workCache.get(id);
  }

  async function applyMove(id, targetBucket, comment, reason) {
    const item = await getWorkItemCached(id);
    const result = await moveWorkItem({
      transport,
      context,
      stateMap,
      id,
      targetBucket,
      comment,
      cwd,
      workItem: item,
    });
    if (result.ok && !result.noop && result.workItem) workCache.set(id, result.workItem);
    if (result.ok && !result.noop) moves.push({ id: String(id), from: result.from, to: result.to, reason, comment });
    else skipped.push({ id: String(id), reason, result });
  }

  for (const branch of branches.filter((entry) => entry.parsed)) {
    const id = branch.parsed.id;
    const item = await getWorkItemCached(id);
    const typeMap = stateMap[item.fields['System.WorkItemType']];
    const bucket = inferBucketForState(typeMap, item.fields['System.State']);
    if (bucket === 'todo') {
      const comment = `ado-board: moved to doing after pushed work on ${branch.parsed.branch} (${branch.sha.slice(0, 7)}).`;
      await applyMove(id, 'doing', comment, 'branch-pushed');
    }
  }

  const prs = await transport.listCompletedPullRequests(context, { repository });
  for (const pr of prs) {
    for (const id of parsePullRequestWorkItem(pr)) {
      const item = await getWorkItemCached(id);
      const targetBucket = item.fields['System.WorkItemType'] === 'Bug' ? 'verify' : 'done';
      const comment = `ado-board: moved to ${targetBucket} after completed PR #${pr.pullRequestId || pr.id} from ${pr.sourceRefName || 'unknown source branch'}.`;
      await applyMove(id, targetBucket, comment, 'completed-pr');
    }
  }

  const activeItems = await transport.listTrackedItemsInBuckets(context, stateMap, ['doing', 'verify']);
  const now = new Date();
  const stale = [];
  for (const item of activeItems) {
    if (hasIdpTag(item)) continue;
    const typeMap = stateMap[item.fields['System.WorkItemType']];
    const bucket = inferBucketForState(typeMap, item.fields['System.State']);
    const matchingBranches = branches.filter((branch) => branch.parsed && branch.parsed.id === String(item.id));
    const latest = matchingBranches.sort((a, b) => new Date(b.committedAt) - new Date(a.committedAt))[0];
    const ageDays = latest ? daysBetween(now, latest.committedAt) : null;
    if (!latest || (ageDays != null && ageDays >= staleDays)) {
      stale.push({
        id: String(item.id),
        type: item.fields['System.WorkItemType'],
        title: item.fields['System.Title'],
        bucket,
        branch: latest ? latest.name : null,
        lastCommitAt: latest ? latest.committedAt : null,
        ageDays: ageDays == null ? null : Number(ageDays.toFixed(1)),
      });
    }
  }

  return {
    ok: true,
    command: 'reconcile',
    throttled: false,
    changed: moves,
    skipped,
    report: {
      doingWithNoPushedCommit: stale,
      untrackedBranches: branches
        .filter((entry) => !entry.parsed)
        .map((entry) => ({ branch: entry.name, sha: entry.sha, committedAt: entry.committedAt })),
      blueprintDrift: blueprintDrift(root),
    },
  };
}

function parseAzDefaults(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    const organization = /organization\s*=\s*(.+)/i.exec(raw);
    const project = /project\s*=\s*(.+)/i.exec(raw);
    return {
      organization: organization ? organization[1].trim() : '',
      project: project ? project[1].trim() : '',
    };
  }
  if (Array.isArray(parsed)) {
    const map = Object.fromEntries(parsed.map((entry) => [entry.name, entry.value]));
    return {
      organization: map.organization || map['defaults.organization'] || '',
      project: map.project || map['defaults.project'] || '',
    };
  }
  if (parsed.defaults && typeof parsed.defaults === 'object') {
    return {
      organization: parsed.defaults.organization || '',
      project: parsed.defaults.project || '',
    };
  }
  return {
    organization: parsed.organization || parsed['defaults.organization'] || '',
    project: parsed.project || parsed['defaults.project'] || '',
  };
}

function loadContextFromConfig(config, contextName) {
  const contexts = Array.isArray(config.contexts) ? config.contexts : [];
  const wanted = contextName || config.activeContext;
  const context = contexts.find((entry) => entry.name === wanted) || contexts[0];
  if (!context) throw new Error('Azure DevOps config has no contexts. Run ado-credentials first.');
  if (!context.organization || !context.project) {
    throw new Error('Azure DevOps config is missing organization or project.');
  }
  return {
    organization: normalizeOrganization(context.organization),
    project: String(context.project).trim(),
    contextName: context.name || null,
  };
}

function resolveAdoContext({ env = process.env, platform = process.platform, contextName } = {}) {
  const configPath = path.join(homeDir(env), '.ado-credentials', 'config.json');
  if (fs.existsSync(configPath)) {
    return loadContextFromConfig(parseJsonFile(configPath), contextName);
  }
  if (platform === 'win32') {
    throw new Error('Azure DevOps config not found in ~/.ado-credentials/config.json. Run ado-credentials first.');
  }
  const raw = execFileSync('az', ['devops', 'configure', '--list', '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const defaults = parseAzDefaults(raw);
  if (!defaults.organization || !defaults.project) {
    throw new Error('Azure DevOps defaults are incomplete. Run ado-credentials first.');
  }
  return {
    organization: normalizeOrganization(defaults.organization),
    project: String(defaults.project).trim(),
    contextName: null,
  };
}

function getWindowsPat(env = process.env) {
  const script = path.join(homeDir(env), '.ado-credentials', 'get-pat.ps1');
  if (!fs.existsSync(script)) {
    throw new Error('Azure DevOps PAT helper is missing. Run ado-credentials setup again.');
  }
  return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function getAzToken() {
  const raw = execFileSync('az', ['account', 'get-access-token', '--resource', ACCESS_TOKEN_RESOURCE, '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const parsed = JSON.parse(raw);
  if (!parsed.accessToken) throw new Error('az account get-access-token returned no accessToken.');
  return parsed.accessToken;
}

class HttpError extends Error {
  constructor(status, message, data) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.data = data;
  }
}

class HttpAzureDevOpsTransport {
  constructor({ context, authHeader, fetchImpl = fetch }) {
    this.context = context;
    this.authHeader = authHeader;
    this.fetch = fetchImpl;
  }

  async request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const url = `${this.context.organization}/${encodeURIComponent(this.context.project)}${pathname}`;
    const response = await this.fetch(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: 'application/json',
        ...headers,
      },
      body,
    });
    const text = await response.text();
    const data = text ? (() => {
      try { return JSON.parse(text); } catch { return text; }
    })() : null;
    if (!response.ok) {
      const message = typeof data === 'string'
        ? data
        : data?.message || data?.error?.message || `${method} ${pathname} failed (${response.status})`;
      throw new HttpError(response.status, message, data);
    }
    return data;
  }

  async listWorkItemTypes() {
    const data = await this.request('/_apis/wit/workitemtypes?api-version=7.1');
    return data.value || [];
  }

  async listWorkItemStates(_context, typeName) {
    const data = await this.request(`/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}/states?api-version=7.1`);
    return (data.value || []).map((state) => ({
      name: state.name,
      category: state.category || state.stateCategory,
    }));
  }

  async getWorkItem(_context, id) {
    return this.request(`/_apis/wit/workitems/${id}?fields=System.WorkItemType,System.State,System.Tags,System.Title&api-version=7.1`);
  }

  async moveWorkItemState(_context, { id, rev, state, comment }) {
    return this.request(`/_apis/wit/workitems/${id}?api-version=7.1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([
        { op: 'test', path: '/rev', value: rev },
        { op: 'add', path: '/fields/System.State', value: state },
        { op: 'add', path: '/fields/System.History', value: comment },
      ]),
    });
  }

  async listCompletedPullRequests(_context, { repository } = {}) {
    if (!repository) return [];
    const data = await this.request(`/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests?searchCriteria.status=completed&$top=100&api-version=7.1`);
    const pulls = data.value || [];
    const enriched = [];
    for (const pr of pulls) {
      let workItemRefs = pr.workItemRefs;
      if (!Array.isArray(workItemRefs)) {
        try {
          const workItems = await this.request(`/_apis/git/repositories/${encodeURIComponent(repository)}/pullRequests/${pr.pullRequestId}/workitems?api-version=7.1`);
          workItemRefs = workItems.value || [];
        } catch {
          workItemRefs = [];
        }
      }
      enriched.push({ ...pr, workItemRefs });
    }
    return enriched;
  }

  async listTrackedItemsInBuckets(_context, stateMap, buckets) {
    const clauses = [];
    for (const [typeName, mapped] of Object.entries(stateMap)) {
      const states = buckets.map((bucket) => mapped[bucket]).filter(Boolean);
      if (!states.length) continue;
      const quotedStates = states.map((state) => `'${String(state).replace(/'/g, "''")}'`).join(', ');
      clauses.push(`([System.WorkItemType] = '${typeName.replace(/'/g, "''")}' AND [System.State] IN (${quotedStates}))`);
    }
    if (!clauses.length) return [];
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND (${clauses.join(' OR ')})`;
    const query = await this.request('/_apis/wit/wiql?api-version=7.1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: wiql }),
    });
    const ids = (query.workItems || []).map((item) => item.id);
    if (!ids.length) return [];
    const batch = await this.request('/_apis/wit/workitemsbatch?api-version=7.1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids,
        fields: ['System.WorkItemType', 'System.State', 'System.Tags', 'System.Title'],
      }),
    });
    return batch.value || [];
  }
}

function createTransport({ context, env = process.env, platform = process.platform, fetchImpl } = {}) {
  const authHeader = platform === 'win32'
    ? `Basic ${Buffer.from(`:${getWindowsPat(env)}`, 'utf8').toString('base64')}`
    : `Bearer ${getAzToken()}`;
  return new HttpAzureDevOpsTransport({ context, authHeader, fetchImpl });
}

module.exports = {
  STATE_FILE_VERSION,
  DEFAULT_STALE_DAYS,
  DEFAULT_THROTTLE_HOURS,
  CATEGORY_TO_BUCKET,
  BUCKET_ORDER,
  defaultProjectStatePath,
  hookThrottlePath,
  loadProjectState,
  saveProjectState,
  parseChoices,
  parseTags,
  hasIdpTag,
  inferBucketForState,
  parseBranchWorkItem,
  parsePullRequestWorkItem,
  listRemoteBranches,
  blueprintDrift,
  requiredFieldName,
  discoverStates,
  moveWorkItem,
  reconcileBoard,
  resolveAdoContext,
  createTransport,
  manualEvidenceComment,
  repoRoot,
  parseRepositoryName,
  gitRefExists,
};
