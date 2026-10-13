#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const API = '7.1';
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';
const PAT_ENV = ['AZURE_DEVOPS_EXT_PAT', 'ADO_PAT'];

function basicAuthHeader(pat) {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64');
}

function defaultRunAz(args) {
  return execFileSync('az', args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
}

function resolveAuth(env = process.env, runAz = defaultRunAz) {
  for (const name of PAT_ENV) if (env[name]) return { header: basicAuthHeader(env[name]), source: name };
  try {
    const token = runAz(['account', 'get-access-token', '--resource', ADO_RESOURCE, '--query', 'accessToken', '-o', 'tsv']).trim();
    if (token) return { header: 'Bearer ' + token, source: 'az' };
  } catch { /* fall through */ }
  throw new Error('no credential: set AZURE_DEVOPS_EXT_PAT (see SKILL.md) or run `az login`');
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

async function request(auth, method, url, body, fetchImpl = fetch, contentType = 'application/json') {
  assertAdoUrl(url);
  const headers = { Authorization: auth.header, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = contentType;
  const init = { method, headers };
  if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
  const res = await fetchImpl(url, init);
  const text = await res.text();
  const where = `${method} ${url.split('?')[0]}`;
  if (res.status === 403) { const err = forbidden(method, url); err.status = 403; throw err; }
  if (!res.ok) {
    const err = new Error(`${where} -> HTTP ${res.status}${res.status === 401 ? ' (credential rejected: run the ado-credentials check)' : ''}`);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers && res.headers.get ? res.headers.get('content-type') || '' : '';
  if (ct.includes('text/html')) throw new Error(`${where} -> sign-in page (credential rejected: run the ado-credentials check)`);
  if (!text) return null;
  return ct.includes('json') || /^\s*[{[]/.test(text) ? JSON.parse(text) : text;
}

module.exports = { API, PAT_ENV, basicAuthHeader, defaultRunAz, resolveAuth, apiUrl, request };
