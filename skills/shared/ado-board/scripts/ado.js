#!/usr/bin/env node
'use strict';
// Azure DevOps REST helpers for this skill. Zero dependencies, built-in fetch only.
// Copied from ado-pr-feedback/scripts/ado.js (skills are self-contained) and extended with a
// content type per request, the response body on errors, and a timeout.
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
      const eq = a.indexOf('=');
      if (eq > 2) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
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

function defaultRunAz(args, timeout = 20000) {
  return execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout }).toString();
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

// `deps.fallback` is what the git remote said: flags and env win over it, ado-credentials
// state and az defaults fill what is still missing.
function resolveContext(args, env = process.env, deps = {}) {
  const runAz = deps.runAz || defaultRunAz;
  const home = deps.home || os.homedir();
  const fb = deps.fallback || {};
  let org = args.org || env.ADO_ORG || fb.org || '';
  let project = args.project || env.ADO_PROJECT || fb.project || '';
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
const PAT_SCOPE = 'Work Items (Read & write)';
function forbidden(method, url) {
  return new Error(`${method} ${url.split('?')[0]} -> the token can sign in but is not allowed to ${method === 'GET' ? 'read this' : 'change this'}: create a new PAT with ${PAT_SCOPE}`);
}

// Errors carry `status` and the parsed `body`, so a caller can read a rule-validation error.
async function request(auth, method, url, body, opts = {}) {
  assertAdoUrl(url);
  const fetchImpl = opts.fetch || fetch;
  const headers = { Authorization: auth.header, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = opts.contentType || 'application/json';
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  if (opts.timeoutMs) init.signal = AbortSignal.timeout(opts.timeoutMs);
  const res = await fetchImpl(url, init);
  const text = await res.text();
  const where = `${method} ${url.split('?')[0]}`;
  if (res.status === 403) { const err = forbidden(method, url); err.status = 403; throw err; }
  if (!res.ok) {
    const err = new Error(`${where} -> HTTP ${res.status}${res.status === 401 ? ' (credential rejected: run the ado-credentials check)' : ''}`);
    err.status = res.status;
    try { err.body = JSON.parse(text); } catch { err.body = text; }
    throw err;
  }
  const ct = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
  // A rejected PAT can come back as a 200/203 sign-in page.
  if (ct.includes('text/html')) throw new Error(`${where} -> sign-in page (credential rejected: run the ado-credentials check)`);
  if (!text) return null;
  return ct.includes('json') || /^\s*[{[]/.test(text) ? JSON.parse(text) : text;
}

module.exports = { API, parseArgs, basicAuthHeader, resolveAuth, parseConfigureList, pickContext, resolveContext, apiUrl, request };
