#!/usr/bin/env node
'use strict';
// Azure DevOps REST helpers for this skill. Zero dependencies, built-in fetch only.
// Copied from ado-board/scripts/ado.js (skills are self-contained); context resolution also
// reports the team and where each value came from, and az runs on Windows too.
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

// On Windows az is az.cmd, which Node runs only through a shell. Every caller passes constant
// arguments, never user text, so the shell sees nothing it could expand.
function defaultRunAz(args, timeout = 20000) {
  const win = process.platform === 'win32';
  return execFileSync(win ? 'az.cmd' : 'az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout, shell: win }).toString();
}

// Parses `az devops configure --list` output.
function parseConfigureList(text) {
  const pick = (k) => {
    const m = new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*$', 'm').exec(text || '');
    return m ? m[1] : '';
  };
  return { organization: pick('organization'), project: pick('project') };
}

// %USERPROFILE%\.ado-credentials\config.json (no secret in it): the active context, or one by name.
function pickContext(config, name) {
  if (!config || !Array.isArray(config.contexts)) return null;
  const want = name || config.activeContext;
  const c = config.contexts.find((x) => x.name === want);
  return c ? { organization: c.organization, project: c.project, team: c.team || '', areaPath: c.areaPath || '' } : null;
}

const sameOrg = (a, b) => String(a || '').replace(/\/+$/, '').toLowerCase() === String(b || '').replace(/\/+$/, '').toLowerCase();

// Order: flags and env, then the git remote (`deps.fallback`), then the ado-credentials current
// context, then `az devops configure` defaults. The team (and its area path) is taken from the
// credentials context only when that context names the same organization and project.
// Returns { org, project, team, areaPath, source: { org, project, team } }; throws with
// code 'needs-choice' when organization or project stays unknown.
function resolveContext(args, env = process.env, deps = {}) {
  const runAz = deps.runAz || defaultRunAz;
  const home = deps.home || os.homedir();
  const fb = deps.fallback || {};
  const source = {};
  const take = (key, pairs) => { for (const [v, from] of pairs) if (v) { source[key] = from; return v; } return ''; };
  let org = take('org', [[args.org, 'flag'], [env.ADO_ORG, 'env'], [fb.org, 'remote']]);
  let project = take('project', [[args.project, 'flag'], [env.ADO_PROJECT, 'env'], [fb.project, 'remote']]);
  let cred = null;
  try {
    cred = pickContext(JSON.parse(fs.readFileSync(path.join(home, '.ado-credentials', 'config.json'), 'utf8')), args.context);
  } catch { /* no ado-credentials state (macOS/Linux) */ }
  if (cred) {
    if (!org) { org = cred.organization || ''; if (org) source.org = 'credentials'; }
    if (!project) { project = cred.project || ''; if (project) source.project = 'credentials'; }
  }
  if (!org || !project) {
    try {
      const c = parseConfigureList(runAz(['devops', 'configure', '--list']));
      if (!org && c.organization) { org = c.organization; source.org = 'az'; }
      if (!project && c.project) { project = c.project; source.project = 'az'; }
    } catch { /* az absent */ }
  }
  if (!org || !project) {
    const err = new Error('organization/project unknown: pass --org and --project, or run the ado-credentials check');
    err.code = 'needs-choice';
    err.partial = { org: org.replace(/\/+$/, ''), project };
    throw err;
  }
  let team = take('team', [[args.team, 'flag'], [env.ADO_TEAM, 'env']]);
  let areaPath = '';
  if (cred && sameOrg(cred.organization, org) && String(cred.project).toLowerCase() === project.toLowerCase()) {
    if (!team && cred.team) { team = cred.team; source.team = 'credentials'; }
    if (team === cred.team) areaPath = cred.areaPath;
  }
  if (!team) source.team = 'project-default';
  return { org: org.replace(/\/+$/, ''), project, team: team || null, areaPath: areaPath || null, source };
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
