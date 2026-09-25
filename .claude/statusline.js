#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paint = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

const PR_CACHE_FILE = path.join(os.tmpdir(), 'claude-statusline-pr-cache.json');
const PR_CACHE_TTL_MS = 30000;

// When `origin` is an Azure DevOps remote, org/project/repo are parsed from it rather than
// assumed — `az devops configure --defaults` may point at a different project.
function parseAdoRemote(url) {
  if (!url) return null;
  let m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/)
    || url.match(/ssh\.dev\.azure\.com[:/]v3\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/)
    || url.match(/https?:\/\/([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+?)(?:\.git)?$/);
  if (!m) return null;
  return { org: decodeURIComponent(m[1]), project: decodeURIComponent(m[2]), repo: decodeURIComponent(m[3]) };
}

// Claude Code populates the statusline JSON's `pr` only for GitHub pull requests and GitLab
// merge requests (`pr.kind: "mr"`), and this repository's origin is Azure DevOps — so `data.pr`
// is always absent here and this shells out to `az repos pr` instead. Cached per branch to
// avoid a ~1s round trip on every status-line refresh (which fires at most every 300ms while
// the conversation updates).
function getCurrentPr(cwd, branch) {
  const key = `${cwd}:${branch}`;
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(PR_CACHE_FILE, 'utf8')); } catch { /* no cache yet */ }

  const cached = cache[key];
  if (cached && Date.now() - cached.time < PR_CACHE_TTL_MS) return cached.pr;

  let pr = null;
  try {
    const remoteUrl = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const ado = parseAdoRemote(remoteUrl);
    if (ado) {
      const orgUrl = `https://dev.azure.com/${ado.org}`;
      const found = JSON.parse(execFileSync('az', [
        'repos', 'pr', 'list',
        '--organization', orgUrl, '--project', ado.project, '--repository', ado.repo,
        '--source-branch', branch, '--status', 'active',
        '--query', '[0].{id:pullRequestId, isDraft:isDraft}', '--output', 'json',
      ], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString());

      if (found && found.id) {
        pr = { id: found.id, isDraft: found.isDraft, reviewState: 'pending' };
        try {
          const votes = JSON.parse(execFileSync('az', [
            'repos', 'pr', 'reviewer', 'list',
            '--id', String(found.id), '--organization', orgUrl,
            '--query', '[].vote', '--output', 'json',
          ], { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString());
          // ADO vote codes: 10/5 approved, 0 no vote, -5 waiting on author, -10 rejected.
          if (votes.some((v) => v === -10)) pr.reviewState = 'changes';
          else if (votes.some((v) => v === -5)) pr.reviewState = 'waiting';
          else if (votes.length && votes.every((v) => v >= 5)) pr.reviewState = 'approved';
        } catch { /* leave as pending */ }
      }
    }
  } catch { /* no az CLI, no ADO remote, not authenticated, network, etc. */ }

  cache = { [key]: { time: Date.now(), pr } }; // single-entry cache: only ever one active branch
  try { fs.writeFileSync(PR_CACHE_FILE, JSON.stringify(cache)); } catch { /* best effort */ }
  return pr;
}

let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(raw); } catch { data = {}; }

  const cwd = (data.workspace && data.workspace.current_dir) || process.cwd();
  const folder = path.basename(cwd);
  const model = (data.model && data.model.display_name) || '';
  const effortLevel = data.effort && data.effort.level;
  const costUsd = (data.cost && data.cost.total_cost_usd) || 0;
  const linesAdded = (data.cost && data.cost.total_lines_added) || 0;
  const linesRemoved = (data.cost && data.cost.total_lines_removed) || 0;
  const remainingPct = data.context_window && data.context_window.remaining_percentage;

  let branch = '';
  let dirty = false;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch { /* not a git repo, or git unavailable */ }

  const pr = branch ? getCurrentPr(cwd, branch) : null;

  const parts = [];
  if (folder !== branch) parts.push(folder);
  if (branch) {
    const branchText = branch + (dirty ? '*' : '');
    parts.push(dirty ? paint(33, branchText) : branchText);
  }
  if (pr) {
    const label = pr.isDraft ? 'draft' : pr.reviewState;
    const color = pr.isDraft ? 90
      : pr.reviewState === 'approved' ? 32
      : pr.reviewState === 'changes' ? 31
      : 33; // pending or waiting
    parts.push(paint(color, `PR#${pr.id}(${label})`));
  }
  if (model) parts.push(model + (effortLevel ? ` (${effortLevel})` : ''));
  parts.push(`$${costUsd.toFixed(2)}`);
  if (linesAdded || linesRemoved) parts.push(`+${linesAdded}/-${linesRemoved}`);
  if (typeof remainingPct === 'number') {
    const ctxText = `${Math.round(remainingPct)}% left`;
    parts.push(remainingPct < 15 ? paint(31, ctxText) : ctxText);
  }

  console.log(parts.join(' · '));
});
