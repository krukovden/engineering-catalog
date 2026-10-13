#!/usr/bin/env node
'use strict';
// Shared Azure DevOps REST helpers for this skill. Zero dependencies, built-in fetch only.
// The credential is read from the environment at call time and never written anywhere.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = '7.1';
// Azure DevOps resource id for `az account get-access-token` (macOS/Linux fallback).
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const PAT_ENV = ['AZURE_DEVOPS_EXT_PAT', 'ADO_PAT'];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function basicAuthHeader(pat) {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64');
}

// PAT from the environment, else (macOS/Linux) an az bearer token. Returns { header } or throws.
function resolveAuth(env = process.env, runAz = defaultRunAz) {
  for (const name of PAT_ENV) if (env[name]) return { header: basicAuthHeader(env[name]), source: name };
  try {
    const token = runAz(['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']).trim();
    if (token) return { header: 'Bearer ' + token, source: 'az' };
  } catch { /* fall through */ }
  throw new Error('no credential: set AZURE_DEVOPS_EXT_PAT (see SKILL.md) or run `az login`');
}

function defaultRunAz(args) {
  return execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

// Parses `az devops configure --list` output.
function parseConfigureList(text) {
  const pick = (k) => {
    const m = new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*$', 'm').exec(text || '');
    return m ? m[1] : '';
  };
  return { organization: pick('organization'), project: pick('project') };
}

// Windows keeps the active project in %USERPROFILE%\.ado-credentials\config.json (no secret in it).
function pickContext(config, name) {
  if (!config || !Array.isArray(config.contexts)) return null;
  const want = name || config.activeContext;
  const c = config.contexts.find((x) => x.name === want);
  return c ? { organization: c.organization, project: c.project } : null;
}

function resolveContext(args, env = process.env, deps = {}) {
  const runAz = deps.runAz || defaultRunAz;
  const home = deps.home || os.homedir();
  let org = args.org || env.ADO_ORG || '';
  let project = args.project || env.ADO_PROJECT || '';
  if (!org || !project) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(home, '.ado-credentials', 'config.json'), 'utf8'));
      const c = pickContext(cfg, args.context);
      if (c) { org = org || c.organization; project = project || c.project; }
    } catch { /* not Windows state */ }
  }
  if (!org || !project) {
    try {
      const c = parseConfigureList(runAz(['devops', 'configure', '--list']));
      org = org || c.organization; project = project || c.project;
    } catch { /* az absent */ }
  }
  if (!org || !project) throw new Error('organization/project unknown: pass --org and --project, or run the ado-credentials check');
  return { org: org.replace(/\/+$/, ''), project };
}

function apiUrl(base, route, query = {}) {
  const q = new URLSearchParams({ 'api-version': API, ...query });
  const r = route.replace(/^\/+/, '');
  return `${base.replace(/\/+$/, '')}${r ? '/' + r : ''}?${q}`;
}

// The credential only goes to https Azure DevOps hosts (dev.azure.com, *.dev.azure.com, <org>.visualstudio.com).
function assertAdoUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('not an Azure DevOps organization URL'); }
  const h = u.hostname.toLowerCase();
  const ok = u.protocol === 'https:' && !u.username && !u.password
    && (h === 'dev.azure.com' || h.endsWith('.dev.azure.com') || /^[a-z0-9-]+\.visualstudio\.com$/.test(h));
  if (!ok) throw new Error('not an Azure DevOps organization URL');
}

// The scope this skill's PAT needs, shown when Azure DevOps answers 403.
const PAT_SCOPE = 'Code (Read & write), Build (Read) and Work Items (Read)';
function forbidden(method, url) {
  return new Error(`${method} ${url.split('?')[0]} -> the token can sign in but is not allowed to ${method === 'GET' ? 'read this' : 'change this'}: create a new PAT with ${PAT_SCOPE}`);
}

async function request(auth, method, url, body, fetchImpl = fetch) {
  assertAdoUrl(url);
  const headers = { Authorization: auth.header, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const where = `${method} ${url.split('?')[0]}`;
  if (res.status === 403) throw forbidden(method, url);
  if (!res.ok) throw new Error(`${where} -> HTTP ${res.status}${res.status === 401 ? ' (credential rejected: run the ado-credentials check)' : ''}`);
  const ct = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
  // A rejected PAT can come back as a 200/203 sign-in page.
  if (ct.includes('text/html')) throw new Error(`${where} -> sign-in page (credential rejected: run the ado-credentials check)`);
  if (!text) return null;
  return ct.includes('json') || /^\s*[{[]/.test(text) ? JSON.parse(text) : text;
}

// Org-level lookup: GET {org}/_apis/git/pullrequests/{id} returns the repository and project ids
// (verify: this route is documented as "Pull Requests - Get Pull Request By Id").
async function getPullRequest(auth, org, prId, fetchImpl = fetch) {
  const pr = await request(auth, 'GET', apiUrl(org, `_apis/git/pullrequests/${prId}`), undefined, fetchImpl);
  return {
    id: pr.pullRequestId,
    title: pr.title,
    status: pr.status,
    repositoryId: pr.repository && pr.repository.id,
    projectId: pr.repository && pr.repository.project && pr.repository.project.id,
    projectName: pr.repository && pr.repository.project && pr.repository.project.name,
  };
}

module.exports = { getPullRequest, API, parseArgs, basicAuthHeader, resolveAuth, parseConfigureList, pickContext, resolveContext, apiUrl, request };
