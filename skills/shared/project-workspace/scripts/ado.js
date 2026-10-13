#!/usr/bin/env node
'use strict';
// Azure DevOps REST helpers for this skill. Zero dependencies, built-in fetch only.
// Copied from ado-board/scripts/ado.js (skills are self-contained); only the parts that list a
// project's teams are kept.
// The credential is read from the environment at call time and never written anywhere.
const { execFileSync } = require('child_process');

const API = '7.1';
// Azure DevOps resource id for `az account get-access-token` (macOS/Linux fallback).
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const PAT_ENV = ['AZURE_DEVOPS_EXT_PAT', 'ADO_PAT'];

function basicAuthHeader(pat) {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64');
}

// The PAT the model put in this command's environment (Windows: ado-credentials' get-pat step).
// Git and REST both read it here, so one handoff authenticates both.
function patFromEnv(env = process.env) {
  for (const name of PAT_ENV) if (env[name]) return { pat: env[name], source: name };
  return null;
}

// PAT from the environment, else (macOS/Linux) an az bearer token. Returns { header } or throws.
function resolveAuth(env = process.env, runAz = defaultRunAz) {
  const found = patFromEnv(env);
  if (found) return { header: basicAuthHeader(found.pat), source: found.source };
  try {
    const token = runAz(['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']).trim();
    if (token) return { header: 'Bearer ' + token, source: 'az' };
  } catch { /* fall through */ }
  throw new Error('no credential: set AZURE_DEVOPS_EXT_PAT (see SKILL.md) or run `az login`');
}

function defaultRunAz(args, timeout = 20000) {
  return execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'], timeout }).toString();
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
const PAT_SCOPE = 'Code (Read)';
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

module.exports = { API, basicAuthHeader, patFromEnv, resolveAuth, apiUrl, request };
