#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { apiUrl, request, resolveAuth } = require('./ado');

const DEFAULT_ORG = 'https://dev.azure.com/Contoso';
const DEFAULT_PROJECT = 'Platform';
const DEFAULT_TYPE = 'Task';

function parseArgs(argv) {
  const out = { _: [], org: DEFAULT_ORG, project: DEFAULT_PROJECT, type: DEFAULT_TYPE, cwd: process.cwd(), home: os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--draft') out.draft = argv[++i];
    else if (arg === '--approved-hash') out.approvedHash = argv[++i];
    else if (arg === '--org') out.org = argv[++i];
    else if (arg === '--project') out.project = argv[++i];
    else if (arg === '--type') out.type = argv[++i];
    else if (arg === '--cwd') out.cwd = path.resolve(argv[++i]);
    else if (arg === '--home') out.home = path.resolve(argv[++i]);
  }
  out.command = out._[0] || 'preview';
  return out;
}

function readDraft(args, stdin = process.stdin.read ? null : null) {
  if (args.draft) return JSON.parse(fs.readFileSync(args.draft, 'utf8'));
  const text = fs.readFileSync(0, 'utf8').trim();
  if (!text) throw new Error('draft missing: pass --draft <file> or pipe JSON on stdin');
  return JSON.parse(text);
}

function firstInstall(receipt) {
  return receipt && Array.isArray(receipt.installs) && receipt.installs.length ? receipt.installs[0] : null;
}

function readReceipt(cwd, home) {
  const candidates = [
    path.join(cwd, '.engineering-catalog', 'receipt.json'),
    path.join(home, '.engineering-catalog', 'receipt.json'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      const install = firstInstall(receipt);
      if (install) return { file, install };
    } catch { /* ignore bad local state in the preview */ }
  }
  return null;
}

function detectPlatform(env, receipt) {
  if (env.COPILOT_PLUGIN_ROOT || env.COPILOT_PROJECT_DIR) return 'copilot';
  if (env.CLAUDE_PLUGIN_ROOT || env.CLAUDE_PROJECT_DIR) return 'claude';
  if (receipt && receipt.install && receipt.install.target) return receipt.install.target;
  return 'unknown';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normaliseDraft(draft) {
  if (!draft || typeof draft !== 'object') throw new Error('draft must be a JSON object');
  if (!draft.unit || !String(draft.unit).trim()) throw new Error('draft.unit is required');
  if (!draft.title || !String(draft.title).trim()) throw new Error('draft.title is required');
  if (!draft.details || !String(draft.details).trim()) throw new Error('draft.details is required');
  return {
    unit: String(draft.unit).trim(),
    title: String(draft.title).trim(),
    details: String(draft.details).trim(),
  };
}

function buildDescription(draft, context) {
  const body = escapeHtml(draft.details).replace(/\r?\n/g, '<br/>');
  const lines = [
    `<p><strong>Catalog feedback</strong></p>`,
    `<p><strong>Unit</strong>: ${escapeHtml(draft.unit)}<br/>`,
    `<strong>Platform</strong>: ${escapeHtml(context.platform)}<br/>`,
    `<strong>Receipt version</strong>: ${escapeHtml(context.receiptVersion)}<br/>`,
    `<strong>Receipt source</strong>: ${escapeHtml(context.receiptSource || 'not installed')}</p>`,
    `<p>${body}</p>`,
  ];
  return lines.join('\n');
}

function buildPreview(args, draftInput, env = process.env) {
  const draft = normaliseDraft(draftInput);
  const receipt = readReceipt(args.cwd, args.home);
  const context = {
    platform: detectPlatform(env, receipt),
    receiptVersion: receipt && receipt.install.catalogVersion ? receipt.install.catalogVersion : 'not installed',
    receiptSource: receipt && receipt.install.source ? receipt.install.source : 'not installed',
  };
  const fields = {
    title: draft.title,
    description: buildDescription(draft, context),
    tags: ['engineering-catalog', 'catalog-feedback', `unit:${draft.unit}`, `platform:${context.platform}`].join('; '),
  };
  const patch = [
    { op: 'add', path: '/fields/System.Title', value: fields.title },
    { op: 'add', path: '/fields/System.Description', value: fields.description },
    { op: 'add', path: '/fields/System.Tags', value: fields.tags },
  ];
  const patchJson = JSON.stringify(patch);
  const draftHash = crypto.createHash('sha256')
    .update([args.org, args.project, args.type, patchJson].join('|'))
    .digest('hex')
    .slice(0, 16);
  return {
    mode: 'PREVIEW',
    organization: args.org.replace(/\/+$/, ''),
    project: args.project,
    type: args.type,
    draftHash,
    unit: draft.unit,
    platform: context.platform,
    receiptVersion: context.receiptVersion,
    receiptSource: context.receiptSource,
    fields,
    patchJson,
  };
}

// Exclusive creation is the lock: of two concurrent commits exactly one creates the receipt.
function claimReceipt(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

function refusedByReceipt(file) {
  let receipt = null;
  try { receipt = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as unknown */ }
  if (receipt && receipt.state === 'created') {
    return { mode: 'ALREADY-PUBLISHED', id: receipt.id, url: receipt.url, draftHash: receipt.draftHash, detail: 'This draft was already filed. No second item was created.' };
  }
  const why = receipt && receipt.state === 'failed' ? `failed at ${receipt.failedAt} with: ${receipt.error}`
    : receipt && receipt.state === 'in-flight' ? `started at ${receipt.startedAt} and never recorded an outcome`
      : 'left a receipt that cannot be read';
  throw new Error(`an earlier commit of this draft ${why}. It may have created the item. Search the board for it; `
    + `if it exists, record its id and url in ${file} with "state": "created", otherwise delete ${file} and commit again.`);
}

async function commit(args, draftInput, env = process.env, fetchImpl = fetch) {
  const preview = buildPreview(args, draftInput, env);
  if (!args.approvedHash) throw new Error('commit requires --approved-hash from the approved preview');
  if (String(args.approvedHash).trim().toLowerCase() !== preview.draftHash.toLowerCase()) {
    throw new Error(`approved hash ${args.approvedHash} does not match current draft ${preview.draftHash}`);
  }
  const auth = resolveAuth(env);
  // Claim the receipt before the POST: if the item is created but the response is lost,
  // a retry of the same approved draft finds the receipt and refuses instead of filing twice.
  const receiptPath = path.join(args.home, '.engineering-catalog', 'feedback', `${preview.draftHash}.json`);
  const stamp = { draftHash: preview.draftHash, organization: preview.organization, project: preview.project, title: preview.fields.title };
  if (!claimReceipt(receiptPath, { state: 'in-flight', ...stamp, startedAt: new Date().toISOString() })) {
    return refusedByReceipt(receiptPath);
  }
  let created;
  try {
    created = await request(
      auth,
      'POST',
      apiUrl(preview.organization, `${encodeURIComponent(preview.project)}/_apis/wit/workitems/$${encodeURIComponent(preview.type)}`),
      preview.patchJson,
      fetchImpl,
      'application/json-patch+json',
    );
  } catch (err) {
    // A definitive 4xx (other than a timeout or throttle) means nothing was created: release
    // the receipt so the draft can be fixed. Anything else looks like a lost success: keep it.
    if (err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
      fs.rmSync(receiptPath, { force: true });
    } else {
      fs.writeFileSync(receiptPath, `${JSON.stringify({ state: 'failed', ...stamp, failedAt: new Date().toISOString(), error: err.message }, null, 2)}\n`);
      err.message += `. Recorded in ${receiptPath}: check the board for "${preview.fields.title}" before running again.`;
    }
    throw err;
  }
  const url = created._links && created._links.html && created._links.html.href
    ? created._links.html.href
    : `${preview.organization}/${encodeURIComponent(preview.project)}/_workitems/edit/${created.id}`;
  fs.writeFileSync(receiptPath, `${JSON.stringify({ state: 'created', id: created.id, url, ...stamp, publishedAt: new Date().toISOString() }, null, 2)}\n`);
  return {
    mode: 'COMMITTED',
    id: created.id,
    url,
    type: created.fields && created.fields['System.WorkItemType'] ? created.fields['System.WorkItemType'] : preview.type,
    title: created.fields && created.fields['System.Title'] ? created.fields['System.Title'] : preview.fields.title,
    state: created.fields && created.fields['System.State'] ? created.fields['System.State'] : 'new',
    draftHash: preview.draftHash,
    unit: preview.unit,
    platform: preview.platform,
    receiptVersion: preview.receiptVersion,
  };
}

async function run(argv = process.argv.slice(2), env = process.env, fetchImpl = fetch) {
  const args = parseArgs(argv);
  const draft = readDraft(args);
  if (args.command === 'preview') return `${JSON.stringify(buildPreview(args, draft, env), null, 2)}\n`;
  if (args.command === 'commit') return `${JSON.stringify(await commit(args, draft, env, fetchImpl), null, 2)}\n`;
  throw new Error(`unknown command "${args.command}" — use preview or commit`);
}

if (require.main === module) {
  run().then((output) => process.stdout.write(output)).catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_ORG,
  DEFAULT_PROJECT,
  DEFAULT_TYPE,
  parseArgs,
  readReceipt,
  detectPlatform,
  normaliseDraft,
  buildDescription,
  buildPreview,
  commit,
  run,
};
