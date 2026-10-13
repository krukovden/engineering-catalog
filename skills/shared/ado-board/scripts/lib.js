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
const RECONCILE_MARKER_LIMIT = 200;
const OWN_MARKER_PREFIX = 'ado-board:';
const CATEGORY_TO_BUCKET = {
  Proposed: 'todo',
  InProgress: 'doing',
  Resolved: 'verify',
  Completed: 'done',
  Removed: 'removed',
};
const BUCKET_TO_CATEGORY = Object.fromEntries(
  Object.entries(CATEGORY_TO_BUCKET).map(([category, bucket]) => [bucket, category]),
);
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

function normalizeName(value) {
  return String(value || '').trim();
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

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function categoryStatesForBucket(typeMap, bucket) {
  const category = BUCKET_TO_CATEGORY[bucket];
  if (!category || !typeMap?.categories?.[category]) return [];
  return uniqueStrings(typeMap.categories[category]);
}

function statesForBucket(typeMap, bucket) {
  const states = categoryStatesForBucket(typeMap, bucket);
  const primary = typeMap?.[bucket];
  if (primary && !states.includes(primary)) states.unshift(primary);
  return states;
}

function resolveTargetBucket(typeMap, targetBucket) {
  if (targetBucket === 'verify' && !typeMap?.verify && typeMap?.done) return 'done';
  return targetBucket;
}

function inferBucketForState(typeMap, stateName) {
  if (!typeMap) return null;
  for (const bucket of [...BUCKET_ORDER, 'removed']) {
    if (statesForBucket(typeMap, bucket).includes(stateName)) return bucket;
  }
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
  if (linked.length) return uniqueStrings(linked);

  const byBranch = parseBranchWorkItem(pr.sourceRefName || pr.sourceRef || pr.branch || '');
  if (byBranch) return [byBranch.id];

  const matches = new Set();
  const title = String(pr.title || '');
  const description = String(pr.description || '');

  for (const pattern of [/\b(?:feat|fix|bug)\((\d+)\)/gi]) {
    let match;
    while ((match = pattern.exec(title)) !== null) matches.add(match[1]);
  }

  for (const text of [title, description]) {
    for (const pattern of [/\bAB#(\d+)\b/gi, /\b(?:fix(?:es|ed)?|close(?:s|d)?|resolve(?:s|d)?)\s+#(\d+)\b/gi]) {
      let match;
      while ((match = pattern.exec(text)) !== null) matches.add(match[1]);
    }
  }

  return [...matches];
}

function resolveBaseRef(root) {
  const originHead = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { allowFailure: true });
  if (originHead) {
    const short = originHead.replace(/^refs\/remotes\//, '');
    if (gitRefExists(root, originHead) || gitRefExists(root, short)) return short;
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const fullRef = candidate.startsWith('origin/') ? `refs/remotes/${candidate}` : `refs/heads/${candidate}`;
    if (gitRefExists(root, fullRef) || gitRefExists(root, candidate)) return candidate;
  }
  return null;
}

function listRemoteBranches(root) {
  const baseRef = resolveBaseRef(root);
  const output = git(
    root,
    ['for-each-ref', '--format=%(refname:short)\t%(objectname)\t%(committerdate:iso-strict)', 'refs/remotes/origin'],
    { allowFailure: true },
  );
  if (!output) return { baseRef, baseMissing: !baseRef, branches: [] };

  const entries = output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, sha, committedAt] = line.split('\t');
      return { name, sha, committedAt };
    })
    .filter((entry) => entry.name !== 'origin/HEAD' && entry.name !== baseRef);

  if (!baseRef) return { baseRef, baseMissing: true, branches: [] };

  const branches = entries
    .map((entry) => {
      const ahead = Number(git(root, ['rev-list', '--count', `${baseRef}..${entry.name}`], { allowFailure: true }) || '0');
      return {
        ...entry,
        ahead,
        parsed: parseBranchWorkItem(entry.name),
      };
    })
    .filter((entry) => entry.ahead > 0);

  return { baseRef, baseMissing: false, branches };
}

function remoteOrigin(root) {
  return git(root, ['remote', 'get-url', 'origin'], { allowFailure: true });
}

function parseAzureReposRemote(remoteUrl) {
  const text = String(remoteUrl || '').trim();
  if (!text) return null;

  let match = /^https:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)(?:[/?#]|$)/i.exec(text);
  if (match) {
    const organizationId = decodeURIComponent(match[1]);
    return {
      organization: normalizeOrganization(`https://dev.azure.com/${organizationId}`),
      organizationId,
      project: decodeURIComponent(match[2]),
      repository: decodeURIComponent(match[3]),
    };
  }

  match = /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?_git\/([^/?#]+)(?:[/?#]|$)/i.exec(text);
  if (match) {
    const organizationId = decodeURIComponent(match[1]);
    const repository = decodeURIComponent(match[2]);
    return {
      organization: normalizeOrganization(`https://${organizationId}.visualstudio.com`),
      organizationId,
      project: repository,
      repository,
    };
  }

  match = /^https:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/?#]+)(?:[/?#]|$)/i.exec(text);
  if (match) {
    const organizationId = decodeURIComponent(match[1]);
    return {
      organization: normalizeOrganization(`https://${organizationId}.visualstudio.com`),
      organizationId,
      project: decodeURIComponent(match[2]),
      repository: decodeURIComponent(match[3]),
    };
  }

  match = /^(?:ssh:\/\/)?git@ssh\.dev\.azure\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#]|$)/i.exec(text);
  if (match) {
    const organizationId = decodeURIComponent(match[1]);
    return {
      organization: normalizeOrganization(`https://dev.azure.com/${organizationId}`),
      organizationId,
      project: decodeURIComponent(match[2]),
      repository: decodeURIComponent(match[3]),
    };
  }

  match = /^(?:ssh:\/\/)?[^@]+@vs-ssh\.visualstudio\.com(?::\d+)?[:/]v3\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#]|$)/i.exec(text);
  if (match) {
    const organizationId = decodeURIComponent(match[1]);
    return {
      organization: normalizeOrganization(`https://${organizationId}.visualstudio.com`),
      organizationId,
      project: decodeURIComponent(match[2]),
      repository: decodeURIComponent(match[3]),
    };
  }

  return null;
}

function parseRepositoryName(remoteUrl) {
  const remote = parseAzureReposRemote(remoteUrl);
  if (remote) return remote.repository;
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
  let match = /Rule Error for field ([^.]+)\.\s*Error code:\s*([^.]+)/i.exec(message);
  if (match && /\b(?:Required|InvalidEmpty)\b/i.test(match[2])) {
    return match[1].trim();
  }
  match = /Field '([^']+)'\s+must be set\./i.exec(message);
  if (match) return match[1];
  match = /field "([^"]+)"\s+must be set\./i.exec(message);
  if (match) return match[1];
  match = /required field ([A-Za-z0-9_.-]+)/i.exec(message);
  if (match) return match[1];
  return null;
}

async function chooseState({
  typeName,
  bucket,
  category,
  states,
  nonInteractive,
  chooseMap,
  input = process.stdin,
  output = process.stderr,
}) {
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
  output = process.stderr,
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
    ...('reconcile' in current ? { reconcile: current.reconcile } : {}),
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

function completedPrComment(pr, repository, targetBucket) {
  const prId = pr.pullRequestId || pr.id || 'unknown';
  const source = pr.sourceRefName || 'unknown source branch';
  const marker = repository ? ` [ado-board reconcile ${repository}#${prId}]` : ` [ado-board reconcile #${prId}]`;
  return `${OWN_MARKER_PREFIX} moved to ${targetBucket} after completed PR #${prId} from ${source}.${marker}`;
}

async function moveWorkItem({
  transport,
  context,
  stateMap,
  id,
  targetBucket,
  comment,
  allowIdp = false,
  cwd = process.cwd(),
  workItem = null,
}) {
  if (!BUCKET_ORDER.includes(targetBucket) && targetBucket !== 'verify') {
    throw new Error('Unknown bucket "' + targetBucket + '". Use todo, doing, verify or done.');
  }
  const item = workItem || await transport.getWorkItem(context, id);
  const typeName = item.fields['System.WorkItemType'];
  const currentState = item.fields['System.State'];
  const typeMap = stateMap[typeName];
  if (!typeMap) throw new Error(`No discovered state map for "${typeName}". Run "states discover" first.`);
  const from = inferBucketForState(typeMap, currentState);
  if (hasIdpTag(item) && !allowIdp) {
    return {
      ok: false,
      id: String(id),
      error: 'idp-tagged',
      message: 'ado-board move refuses idp-tagged items; reconcile skips them instead.',
      from,
      to: targetBucket,
    };
  }
  if (targetBucket === 'removed') throw new Error('ado-board never moves an item into Removed.');
  if (!from) throw new Error(`State "${currentState}" for "${typeName}" is not in the discovered map.`);
  if (from === 'removed') throw new Error('ado-board never touches Removed items.');

  const effectiveBucket = resolveTargetBucket(typeMap, targetBucket);
  if (bucketRank(effectiveBucket) < bucketRank(from)) {
    throw new Error(`Refusing to move ${id} backwards (${from} → ${effectiveBucket}).`);
  }
  if (from === effectiveBucket) {
    return {
      ok: true,
      noop: true,
      id: String(id),
      from,
      to: effectiveBucket,
      requestedTo: targetBucket,
      state: currentState,
    };
  }

  const targetState = typeMap[effectiveBucket];
  if (!targetState) {
    throw new Error(`No "${effectiveBucket}" state is mapped for "${typeName}". Run "states discover" again.`);
  }

  const evidence = comment || manualEvidenceComment(cwd, effectiveBucket);
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
      to: effectiveBucket,
      requestedTo: targetBucket,
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

function parseIsoDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function itemStateChangedAt(item) {
  const fields = item?.fields || {};
  return parseIsoDate(fields['Microsoft.VSTS.Common.StateChangeDate'])
    || parseIsoDate(fields['System.ChangedDate']);
}

function shouldSkipBranchReplay(item, branch) {
  const changedAt = itemStateChangedAt(item);
  const committedAt = parseIsoDate(branch?.committedAt);
  return Boolean(changedAt && committedAt && changedAt > committedAt);
}

function shouldSkipCompletedPrReplay(item, pr) {
  const changedAt = itemStateChangedAt(item);
  const closedAt = parseIsoDate(pr?.closedDate);
  return Boolean(changedAt && closedAt && changedAt > closedAt);
}

function isOwnMarkerComment(value) {
  return String(value || '').includes(OWN_MARKER_PREFIX);
}

function extractUpdateField(update, fieldName) {
  return update?.fields?.[fieldName] || update?.fields?.[fieldName.replace(/\./g, '_')] || null;
}

function fieldValue(field) {
  if (!field) return null;
  if (typeof field === 'string') return field;
  if (typeof field === 'object') {
    if (typeof field.newValue === 'string') return field.newValue;
    if (typeof field.value === 'string') return field.value;
  }
  return null;
}

function isOwnStateTransitionUpdate(update) {
  const stateField = extractUpdateField(update, 'System.State');
  if (!stateField) return false;
  const history = fieldValue(extractUpdateField(update, 'System.History'));
  if (isOwnMarkerComment(history)) return true;
  const comment = fieldValue(extractUpdateField(update, 'System.Comment'));
  if (isOwnMarkerComment(comment)) return true;
  return false;
}

// Never read update.revisedDate: it is when the revision was superseded (9999-01-01 for the latest).
function latestNonOwnStateChangeDateFromUpdates(updates = []) {
  const candidates = [];
  for (const update of updates) {
    if (isOwnStateTransitionUpdate(update)) continue;
    const stateField = extractUpdateField(update, 'System.State');
    if (!stateField) continue;
    const when = parseIsoDate(fieldValue(extractUpdateField(update, 'System.ChangedDate')) || fieldValue(extractUpdateField(update, 'Microsoft.VSTS.Common.StateChangeDate')));
    if (when) candidates.push(when);
  }
  candidates.sort((a, b) => b.getTime() - a.getTime());
  return candidates[0] || null;
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

function readReconcileThrottle({ root, hours, env = process.env }) {
  if (!hours || hours <= 0) return { throttled: false };
  const file = hookThrottlePath(env);
  const key = hashText(repoFingerprint(root));
  let state = { projects: {} };
  if (fs.existsSync(file)) {
    try { state = parseJsonFile(file); } catch { state = { projects: {} }; }
  }
  const previous = state.projects?.[key];
  if (!previous) return { throttled: false, file, key };
  const last = new Date(previous);
  if (Number.isNaN(last.getTime())) return { throttled: false, file, key };
  if ((Date.now() - last.getTime()) < hours * 3600000) {
    return { throttled: true, lastRunAt: previous, file, key };
  }
  return { throttled: false, file, key, lastRunAt: previous };
}

function markReconcileThrottle({ root, env = process.env, at = new Date() }) {
  const file = hookThrottlePath(env);
  const key = hashText(repoFingerprint(root));
  let state = { projects: {} };
  if (fs.existsSync(file)) {
    try { state = parseJsonFile(file); } catch { state = { projects: {} }; }
  }
  state.projects = state.projects || {};
  state.projects[key] = at.toISOString();
  writeJsonFile(file, state);
  return { file, lastRunAt: state.projects[key] };
}

function skippableReconcileError(error) {
  if (error?.status === 404) {
    return { code: 'work-item-missing', message: String(error.message || error) };
  }
  const message = String(error?.message || error || '');
  if (/unknown work item/i.test(message)) return { code: 'work-item-missing', message };
  if (/never touches Removed/i.test(message) || /never moves an item into Removed/i.test(message)) {
    return { code: 'removed', message };
  }
  if (/backwards/.test(message)) return { code: 'backwards', message };
  if (/discovered state map/i.test(message) || /is not in the discovered map/i.test(message) || /No "[^"]+" state is mapped/i.test(message)) {
    return { code: 'state-unmapped', message };
  }
  return null;
}

function isRetryablePrSkip(reason) {
  return reason === 'move-error';
}

function completedPullRequestKey(repository, pr) {
  return [
    repository || '',
    String(pr.pullRequestId || pr.id || ''),
    normalizeName(pr.targetRefName),
    normalizeName(pr.closedDate),
  ].join('::');
}

function retryPullRequestKey(entry) {
  return String(entry?.key || '');
}

function latestClosedDate(prs) {
  const valid = prs
    .map((pr) => new Date(pr.closedDate || 0))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());
  return valid[0] ? valid[0].toISOString() : null;
}

function nextReconcileState(projectState, processedPullRequests) {
  const current = projectState?.reconcile || {};
  const merged = [...(current.processedPullRequests || []), ...processedPullRequests];
  const deduped = [];
  const seen = new Set();
  for (const entry of merged.slice().sort((a, b) => {
    const left = new Date(b.closedDate || 0).getTime();
    const right = new Date(a.closedDate || 0).getTime();
    return left - right;
  })) {
    if (!entry?.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    deduped.push(entry);
    if (deduped.length >= RECONCILE_MARKER_LIMIT) break;
  }
  const lastCompletedPrClosedDate = latestClosedDate(deduped) || current.lastCompletedPrClosedDate || null;
  return {
    lastCompletedPrClosedDate,
    processedPullRequests: deduped,
  };
}

function mergeRetryablePullRequests(current = [], next = []) {
  const merged = [...current, ...next];
  const deduped = [];
  const seen = new Set();
  for (const entry of merged.slice().sort((a, b) => {
    const left = new Date(a.closedDate || 0).getTime();
    const right = new Date(b.closedDate || 0).getTime();
    return left - right;
  })) {
    const key = retryPullRequestKey(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
    if (deduped.length >= RECONCILE_MARKER_LIMIT) break;
  }
  return deduped;
}

function retryableMinClosedDate(entries = []) {
  const valid = entries
    .map((entry) => parseIsoDate(entry.closedDate))
    .filter(Boolean)
    .sort((a, b) => a.getTime() - b.getTime());
  return valid[0] ? valid[0].toISOString() : null;
}

function reconcileQueryMinTime(projectState) {
  const current = projectState?.reconcile || {};
  const retryMin = retryableMinClosedDate(current.retryablePullRequests || []);
  if (!current.lastCompletedPrClosedDate) return retryMin;
  if (!retryMin) return current.lastCompletedPrClosedDate;
  return new Date(retryMin) < new Date(current.lastCompletedPrClosedDate)
    ? retryMin
    : current.lastCompletedPrClosedDate;
}

function updateRetryablePullRequests(currentRetryable, retryableThisRun, processedThisRun) {
  const processedKeys = new Set(processedThisRun.map((entry) => entry.key));
  const pendingCurrent = (currentRetryable || []).filter((entry) => !processedKeys.has(retryPullRequestKey(entry)));
  return mergeRetryablePullRequests(pendingCurrent, retryableThisRun);
}

function contiguousSuccessClosedDate(processedPullRequests, retryablePullRequests) {
  const retryMin = retryableMinClosedDate(retryablePullRequests);
  const eligible = processedPullRequests
    .map((entry) => parseIsoDate(entry.closedDate))
    .filter(Boolean)
    .filter((date) => !retryMin || date.toISOString() < retryMin)
    .sort((a, b) => b.getTime() - a.getTime());
  return eligible[0] ? eligible[0].toISOString() : null;
}

function buildNextReconcileState(projectState, processedPullRequests, retryablePullRequests) {
  const current = projectState?.reconcile || {};
  const nextProcessed = nextReconcileState(projectState, processedPullRequests).processedPullRequests;
  const nextRetryable = updateRetryablePullRequests(current.retryablePullRequests || [], retryablePullRequests, nextProcessed);
  const contiguousClosedDate = contiguousSuccessClosedDate(nextProcessed, nextRetryable);
  return {
    lastCompletedPrClosedDate: contiguousClosedDate || current.lastCompletedPrClosedDate || null,
    processedPullRequests: nextProcessed,
    ...(nextRetryable.length ? { retryablePullRequests: nextRetryable } : {}),
  };
}

function reconcileStateChanged(projectState, nextReconcile) {
  const current = projectState?.reconcile || {};
  return JSON.stringify({
    lastCompletedPrClosedDate: current.lastCompletedPrClosedDate || null,
    processedPullRequests: current.processedPullRequests || [],
    retryablePullRequests: current.retryablePullRequests || [],
  }) !== JSON.stringify({
    lastCompletedPrClosedDate: nextReconcile.lastCompletedPrClosedDate || null,
    processedPullRequests: nextReconcile.processedPullRequests || [],
    retryablePullRequests: nextReconcile.retryablePullRequests || [],
  });
}

function compareAdoContexts(left, right) {
  const leftRemote = parseAzureReposRemote(left?.organization ? `${left.organization}/${left.project}/_git/placeholder` : '');
  const rightRemote = parseAzureReposRemote(right?.organization ? `${right.organization}/${right.project}/_git/placeholder` : '');
  const leftOrg = leftRemote?.organizationId?.toLowerCase() || normalizeOrganization(left?.organization).toLowerCase();
  const rightOrg = rightRemote?.organizationId?.toLowerCase() || normalizeOrganization(right?.organization).toLowerCase();
  return leftOrg === rightOrg && normalizeName(left?.project).toLowerCase() === normalizeName(right?.project).toLowerCase();
}

function assertAdoContextMatches(expected, actual, expectedLabel, actualLabel) {
  if (!expected?.organization || !expected?.project || !actual?.organization || !actual?.project) return;
  if (!compareAdoContexts(expected, actual)) {
    throw new Error(`${expectedLabel} ${normalizeOrganization(expected.organization)}/${normalizeName(expected.project)} does not match ${actualLabel} ${normalizeOrganization(actual.organization)}/${normalizeName(actual.project)}.`);
  }
}

async function reconcileBoard({
  transport,
  context,
  stateMap,
  cwd = process.cwd(),
  staleDays = DEFAULT_STALE_DAYS,
  throttleHours = 0,
  env = process.env,
  stateFile = null,
  projectState = null,
}) {
  const root = repoRoot(cwd);
  if (!root) throw new Error('reconcile needs a git repository.');
  const throttle = readReconcileThrottle({ root, hours: throttleHours, env });
  if (throttle.throttled) {
    return { ok: true, command: 'reconcile', throttled: true, lastRunAt: throttle.lastRunAt };
  }

  const branchScan = listRemoteBranches(root);
  const origin = remoteOrigin(root);
  const azureRemote = parseAzureReposRemote(origin);
  const repository = azureRemote?.repository || parseRepositoryName(origin);
  const workCache = new Map();
  const workItemUpdatesCache = new Map();
  const moves = [];
  const skipped = [];
  const processedPullRequests = [];
  const retryablePullRequests = [];
  const processedPullRequestKeys = new Set(
    (projectState?.reconcile?.processedPullRequests || []).map((entry) => entry.key),
  );
  const movedByReconcile = new Set();
  const latestBranchById = new Map();
  for (const branch of branchScan.branches.filter((entry) => entry.parsed)) {
    const current = latestBranchById.get(branch.parsed.id);
    if (!current || new Date(branch.committedAt) > new Date(current.committedAt)) {
      latestBranchById.set(branch.parsed.id, branch);
    }
  }

  async function getWorkItemCached(id) {
    if (!workCache.has(id)) workCache.set(id, await transport.getWorkItem(context, id));
    return workCache.get(id);
  }

  async function getWorkItemUpdatesCached(id) {
    if (!workItemUpdatesCache.has(id)) workItemUpdatesCache.set(id, await transport.getWorkItemUpdates(context, id));
    return workItemUpdatesCache.get(id);
  }

  async function wasChangedBySomeoneElseAfter(id, boundaryDate) {
    if (!boundaryDate) return false;
    const item = await getWorkItemCached(id);
    const changedAt = itemStateChangedAt(item);
    if (!changedAt || changedAt <= boundaryDate) return false;
    if (movedByReconcile.has(String(id))) return false;
    const updates = await getWorkItemUpdatesCached(id);
    const latestNonOwn = latestNonOwnStateChangeDateFromUpdates(updates);
    return Boolean(latestNonOwn && latestNonOwn > boundaryDate);
  }

  function pushSkipped(entry) {
    skipped.push({
      id: String(entry.id),
      reason: entry.reason,
      source: entry.source,
      ...(entry.message ? { message: entry.message } : {}),
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.pullRequest ? { pullRequest: entry.pullRequest } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
    });
  }

  async function applyMove({ id, targetBucket, comment, reason, source, pullRequest = null, branch = null }) {
    let item;
    try {
      item = await getWorkItemCached(id);
    } catch (error) {
      const skippedError = skippableReconcileError(error) || { code: 'move-error', message: String(error.message || error) };
      pushSkipped({ id, reason: skippedError.code, source, message: skippedError.message, pullRequest, branch });
      return { disposition: skippedError.code === 'work-item-missing' ? 'terminal-skip' : 'retryable-skip', reason: skippedError.code };
    }

    if (hasIdpTag(item)) {
      pushSkipped({
        id,
        reason: 'idp-tagged',
        source,
        message: 'ado-board reconcile skips idp-tagged items.',
        pullRequest,
        branch,
      });
      return { disposition: 'terminal-skip', reason: 'idp-tagged' };
    }

    try {
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
      if (result.ok && !result.noop && result.workItem) {
        workCache.set(String(id), result.workItem);
        movedByReconcile.add(String(id));
        moves.push({
          id: String(id),
          from: result.from,
          to: result.to,
          requestedTo: result.requestedTo,
          reason,
          comment,
          source,
          ...(pullRequest ? { pullRequest } : {}),
          ...(branch ? { branch } : {}),
        });
        return { disposition: 'moved', reason: null };
      }
      pushSkipped({
        id,
        reason: result.error || result.reason || 'noop',
        source,
        result,
        pullRequest,
        branch,
      });
      if (result.ok && result.noop) return { disposition: 'noop', reason: result.reason || 'noop' };
      return {
        disposition: isRetryablePrSkip(result.error) ? 'retryable-skip' : 'terminal-skip',
        reason: result.error || result.reason || 'noop',
      };
    } catch (error) {
      const skippedError = skippableReconcileError(error) || { code: 'move-error', message: String(error.message || error) };
      pushSkipped({ id, reason: skippedError.code, source, message: skippedError.message, pullRequest, branch });
      return { disposition: skippedError.code === 'move-error' ? 'retryable-skip' : 'terminal-skip', reason: skippedError.code };
    }
  }

  for (const branch of latestBranchById.values()) {
    const id = branch.parsed.id;
    let item;
    try {
      item = await getWorkItemCached(id);
    } catch (error) {
      const skippedError = skippableReconcileError(error) || { code: 'move-error', message: String(error.message || error) };
      pushSkipped({ id, reason: skippedError.code, source: 'branch-pushed', message: skippedError.message, branch: branch.name });
      continue;
    }
    const typeMap = stateMap[item.fields['System.WorkItemType']];
    const bucket = inferBucketForState(typeMap, item.fields['System.State']);
    if (bucket === 'todo') {
      let replayed = false;
      if (shouldSkipBranchReplay(item, branch)) {
        try {
          replayed = await wasChangedBySomeoneElseAfter(id, parseIsoDate(branch.committedAt));
        } catch (error) {
          pushSkipped({ id, reason: 'move-error', source: 'branch-pushed', message: String(error.message || error), branch: branch.name });
          continue;
        }
      }
      if (replayed) {
        pushSkipped({
          id,
          reason: 'branch-replayed-after-manual-change',
          source: 'branch-pushed',
          message: 'Work item changed after the branch commit; not replaying branch evidence.',
          branch: branch.name,
        });
        continue;
      }
      const comment = `ado-board: moved to doing after pushed work on ${branch.parsed.branch} (${branch.sha.slice(0, 7)}).`;
      await applyMove({
        id,
        targetBucket: 'doing',
        comment,
        reason: 'branch-pushed',
        source: 'branch-pushed',
        branch: branch.name,
      });
    }
  }

  const prQuery = {
    repository,
    targetRefName: branchScan.baseRef ? `refs/heads/${branchScan.baseRef.replace(/^origin\//, '')}` : null,
    minTime: reconcileQueryMinTime(projectState),
    queryTimeRangeType: 'closed',
  };
  const prs = await transport.listCompletedPullRequests(context, prQuery);
  for (const pr of prs) {
    const prKey = completedPullRequestKey(repository, pr);
    if (processedPullRequestKeys.has(prKey)) continue;
    const ids = parsePullRequestWorkItem(pr);
    const prRef = {
      id: String(pr.pullRequestId || pr.id || ''),
      key: prKey,
      closedDate: pr.closedDate || null,
      sourceRefName: pr.sourceRefName || null,
      targetRefName: pr.targetRefName || null,
    };
    for (const id of ids) {
      let item;
      try {
        item = await getWorkItemCached(id);
      } catch (error) {
        const skippedError = skippableReconcileError(error) || { code: 'move-error', message: String(error.message || error) };
        pushSkipped({ id, reason: skippedError.code, source: 'completed-pr', message: skippedError.message, pullRequest: prRef });
        prRef.retryable = prRef.retryable || skippedError.code !== 'work-item-missing';
        continue;
      }
      const typeMap = stateMap[item.fields['System.WorkItemType']];
      const targetBucket = item.fields['System.WorkItemType'] === 'Bug' ? 'verify' : 'done';
      let replayed = false;
      if (shouldSkipCompletedPrReplay(item, pr)) {
        try {
          replayed = await wasChangedBySomeoneElseAfter(id, parseIsoDate(pr.closedDate));
        } catch (error) {
          pushSkipped({ id, reason: 'move-error', source: 'completed-pr', message: String(error.message || error), pullRequest: prRef });
          prRef.retryable = true;
          continue;
        }
      }
      if (replayed) {
        pushSkipped({
          id,
          reason: 'pr-replayed-after-manual-change',
          source: 'completed-pr',
          message: 'Work item changed after the PR closed; not replaying completed PR evidence.',
          pullRequest: prRef,
        });
        continue;
      }
      const comment = completedPrComment(pr, repository, resolveTargetBucket(typeMap, targetBucket));
      const outcome = await applyMove({
        id,
        targetBucket,
        comment,
        reason: 'completed-pr',
        source: 'completed-pr',
        pullRequest: prRef,
      });
      prRef.retryable = prRef.retryable || outcome?.disposition === 'retryable-skip';
    }
    if (!prRef.retryable) {
      processedPullRequestKeys.add(prKey);
      processedPullRequests.push({
        key: prKey,
        pullRequestId: prRef.id,
        repository,
        targetRefName: pr.targetRefName || null,
        sourceRefName: pr.sourceRefName || null,
        closedDate: pr.closedDate || null,
        workItemIds: ids,
      });
    } else {
      retryablePullRequests.push({
        key: prKey,
        pullRequestId: prRef.id,
        repository,
        targetRefName: pr.targetRefName || null,
        sourceRefName: pr.sourceRefName || null,
        closedDate: pr.closedDate || null,
        workItemIds: ids,
      });
    }
  }

  const activeItems = await transport.listTrackedItemsInBuckets(context, stateMap, ['doing', 'verify']);
  const now = new Date();
  const staleDoing = [];
  const verifyWaitingForQa = [];
  for (const item of activeItems) {
    if (hasIdpTag(item)) continue;
    const typeMap = stateMap[item.fields['System.WorkItemType']];
    const bucket = inferBucketForState(typeMap, item.fields['System.State']);
    const matchingBranches = branchScan.branches.filter((branch) => branch.parsed && branch.parsed.id === String(item.id));
    const latest = matchingBranches.sort((a, b) => new Date(b.committedAt) - new Date(a.committedAt))[0];
    const ageDays = latest ? daysBetween(now, latest.committedAt) : null;
    const reportEntry = {
      id: String(item.id),
      type: item.fields['System.WorkItemType'],
      title: item.fields['System.Title'],
      bucket,
      branch: latest ? latest.name : null,
      lastCommitAt: latest ? latest.committedAt : null,
      ageDays: ageDays == null ? null : Number(ageDays.toFixed(1)),
    };
    if (bucket === 'verify') {
      verifyWaitingForQa.push(reportEntry);
      continue;
    }
    if (!latest || (ageDays != null && ageDays >= staleDays)) staleDoing.push(reportEntry);
  }

  if (stateFile && projectState) {
    const nextReconcile = buildNextReconcileState(projectState, processedPullRequests, retryablePullRequests);
    if (reconcileStateChanged(projectState, nextReconcile)) {
      saveProjectState(stateFile, {
        ...projectState,
        reconcile: nextReconcile,
      });
    }
  }
  if (throttleHours > 0) markReconcileThrottle({ root, env });

  return {
    ok: true,
    command: 'reconcile',
    throttled: false,
    changed: moves,
    skipped,
    report: {
      doingWithNoPushedCommit: staleDoing,
      verifyWaitingForQa,
      untrackedBranches: branchScan.branches
        .filter((entry) => !entry.parsed)
        .map((entry) => ({ branch: entry.name, sha: entry.sha, committedAt: entry.committedAt })),
      blueprintDrift: blueprintDrift(root),
      warnings: [
        ...(branchScan.baseMissing ? [{ code: 'base-not-found', message: 'Could not resolve origin/HEAD, main, or master for ahead-of-base comparisons.' }] : []),
      ],
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

function resolveAdoContext({
  env = process.env,
  platform = process.platform,
  contextName,
  cwd = process.cwd(),
  state = null,
} = {}) {
  const root = repoRoot(cwd) || cwd;
  const remote = parseAzureReposRemote(remoteOrigin(root));
  const configPath = path.join(homeDir(env), '.ado-credentials', 'config.json');
  let configured = null;

  if (fs.existsSync(configPath)) {
    configured = loadContextFromConfig(parseJsonFile(configPath), contextName);
  } else if (platform === 'win32') {
    throw new Error('Azure DevOps config not found in ~/.ado-credentials/config.json. Run ado-credentials first.');
  } else {
    const raw = execFileSync('az', ['devops', 'configure', '--list', '--output', 'json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const defaults = parseAzDefaults(raw);
    if (!defaults.organization || !defaults.project) {
      throw new Error('Azure DevOps defaults are incomplete. Run ado-credentials first.');
    }
    configured = {
      organization: normalizeOrganization(defaults.organization),
      project: String(defaults.project).trim(),
      contextName: null,
    };
  }

  if (remote) {
    assertAdoContextMatches(configured, remote, 'Configured Azure DevOps context', 'repository origin');
    if (state?.organization || state?.project) {
      assertAdoContextMatches(
        { organization: state.organization, project: state.project },
        remote,
        'ado-board state file',
        'repository origin',
      );
    }
    return {
      organization: remote.organization,
      project: remote.project,
      repository: remote.repository,
      contextName: configured.contextName,
      source: 'remote',
    };
  }

  if (state?.organization || state?.project) {
    assertAdoContextMatches(
      configured,
      { organization: state.organization, project: state.project },
      'Configured Azure DevOps context',
      'ado-board state file',
    );
  }

  return configured;
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

const PAGE_LIMIT = 50;
const PR_PAGE_SIZE = 100;
const UPDATES_PAGE_SIZE = 200;

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
    return this.request(`/_apis/wit/workitems/${id}?fields=System.WorkItemType,System.State,System.Tags,System.Title,System.ChangedDate,Microsoft.VSTS.Common.StateChangeDate&api-version=7.1`);
  }

  async getWorkItemUpdates(_context, id) {
    const updates = [];
    for (let skip = 0; skip < PAGE_LIMIT * UPDATES_PAGE_SIZE; skip += UPDATES_PAGE_SIZE) {
      const data = await this.request(`/_apis/wit/workitems/${id}/updates?%24top=${UPDATES_PAGE_SIZE}&%24skip=${skip}&api-version=7.1`);
      const page = data?.value || [];
      updates.push(...page);
      if (page.length < UPDATES_PAGE_SIZE) break;
    }
    return updates;
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

  async listCompletedPullRequests(_context, { repository, targetRefName = null, minTime = null, queryTimeRangeType = null } = {}) {
    if (!repository) return [];
    const pulls = [];
    for (let skip = 0; skip < PAGE_LIMIT * PR_PAGE_SIZE; skip += PR_PAGE_SIZE) {
      const params = new URLSearchParams({
        'searchCriteria.status': 'completed',
        '$top': String(PR_PAGE_SIZE),
        '$skip': String(skip),
        'api-version': '7.1',
      });
      if (targetRefName) params.set('searchCriteria.targetRefName', targetRefName);
      if (minTime) params.set('searchCriteria.minTime', minTime);
      if (queryTimeRangeType) params.set('searchCriteria.queryTimeRangeType', queryTimeRangeType);
      const data = await this.request(`/_apis/git/repositories/${encodeURIComponent(repository)}/pullrequests?${params.toString()}`);
      const page = data?.value || [];
      pulls.push(...page);
      if (page.length < PR_PAGE_SIZE) break;
    }
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
      const states = uniqueStrings(buckets.flatMap((bucket) => statesForBucket(mapped, bucket)));
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
  parseAzureReposRemote,
  listRemoteBranches,
  blueprintDrift,
  requiredFieldName,
  chooseState,
  discoverStates,
  moveWorkItem,
  reconcileBoard,
  resolveAdoContext,
  createTransport,
  HttpAzureDevOpsTransport,
  manualEvidenceComment,
  repoRoot,
  parseRepositoryName,
  gitRefExists,
  readReconcileThrottle,
  markReconcileThrottle,
  resolveTargetBucket,
  parseAzureReposRemote,
  shouldSkipBranchReplay,
  shouldSkipCompletedPrReplay,
  isOwnStateTransitionUpdate,
};
