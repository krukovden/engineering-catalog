'use strict';
// memory-lib.js — parsing and arithmetic for the project-memory files (DESIGN §8).
// Self-contained on purpose: the skill directory is copied verbatim at install time.
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const STATUS = ['active', 'superseded', 'open', 'needs-review'];
const EVIDENCE = ['confirmed', 'inferred', 'unknown'];
const FIELDS = [['status', 'status'], ['evidence', 'evidence'], ['pr', 'pr'], ['sha-at-write', 'shaAtWrite'], ['merged-sha', 'mergedSha'], ['supersedes', 'supersedes'], ['superseded-by', 'supersededBy'], ['date', 'date']];
const none = (v) => (v === undefined || v === null || v === '' || v === 'none' ? null : v);

function mintEntryId(date = new Date(), rnd = crypto) {
  const d = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `e-${d}-${rnd.randomBytes(2).toString('hex')}`;
}

function parseIndex(text) {
  const line = (k) => { const m = new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(text); return m ? m[1].trim() : ''; };
  const units = [];
  const rowRe = /^\|\s*\[\[([^\]]+)\]\]\s*\|\s*(.*?)\s*\|\s*$/gm;
  let m;
  while ((m = rowRe.exec(text)) !== null) units.push({ slug: m[1], summary: m[2] });
  const rejected = [];
  const sec = /## Rejected at project level\s*\n([\s\S]*?)(?:\n## |$)/.exec(text);
  if (sec) for (const l of sec[1].split('\n')) { const r = /^-\s+(.*)$/.exec(l.trim()); if (r) rejected.push(r[1]); }
  return { reconciledSha: none(line('reconciled-sha')), store: none(line('store')), units, rejected };
}

function parseUnitFile(text) {
  const slugM = /<!--\s*memory:unit\s+(\S+)/.exec(text);
  const titleM = /^#\s+(.*)$/m.exec(text);
  const entries = [];
  // Split only on entry headers themselves (anchored to the id pattern), not on
  // any "### " heading — otherwise an H3 in a body truncates the entry and
  // leaves a spurious id:null entry behind.
  const parts = text.split(/^### (?=e-\d{8}-[0-9a-f]{4}\s)/m).slice(1);
  for (const part of parts) {
    const lines = part.split('\n');
    const head = /^(e-\d{8}-[0-9a-f]{4})\s+(.*)$/.exec(lines[0].trim());
    const entry = { id: head ? head[1] : null, title: head ? head[2].trim() : lines[0].trim() };
    for (const [, key] of FIELDS) entry[key] = null;
    let i = 1;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === '' && i === 1) continue;
      const f = /^-\s+([a-z-]+):\s*(.*)$/.exec(lines[i]);
      // Stop at the first line that is not one of the eight canonical fields —
      // an unrecognised "- key: value" line (or anything else) starts the body,
      // it is never silently swallowed as metadata.
      if (!f) break;
      const field = FIELDS.find(([k]) => k === f[1]);
      if (!field) break;
      entry[field[1]] = none(f[2].trim());
    }
    entry.body = lines.slice(i).join('\n').trim();
    entry.links = [...entry.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((x) => x[1]);
    entries.push(entry);
  }
  return { slug: slugM ? slugM[1] : null, title: titleM ? titleM[1].trim() : null, entries };
}

function renderEntry(e) {
  const v = (x) => (x === null || x === undefined ? 'none' : x);
  const lines = [`### ${e.id} ${e.title}`];
  for (const [k, key] of FIELDS) lines.push(`- ${k}: ${v(e[key])}`);
  return `${lines.join('\n')}\n\n${e.body || ''}\n`;
}

function validateEntry(e) {
  const errs = [];
  if (!e.id) errs.push('entry has no id (e-YYYYMMDD-xxxx)');
  if (!STATUS.includes(e.status)) errs.push(`${e.id || '?'}: status "${e.status}" is not one of ${STATUS.join(', ')}`);
  if (!EVIDENCE.includes(e.evidence)) errs.push(`${e.id || '?'}: evidence "${e.evidence}" is not one of ${EVIDENCE.join(', ')}`);
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push(`${e.id || '?'}: date must be YYYY-MM-DD`);
  return errs;
}

function checkSupersedeLinks(unitFiles) {
  const byId = new Map();
  for (const u of unitFiles) for (const e of u.entries) if (e.id) byId.set(e.id, e);
  const errs = [];
  for (const e of byId.values()) {
    if (e.supersedes) {
      const t = byId.get(e.supersedes);
      if (!t) errs.push(`${e.id} supersedes ${e.supersedes} which does not exist`);
      else if (t.supersededBy !== e.id) errs.push(`${e.id} supersedes ${t.id} but ${t.id} does not name ${e.id} as superseded-by`);
    }
    if (e.supersededBy) {
      const t = byId.get(e.supersededBy);
      if (!t) errs.push(`${e.id} is superseded-by ${e.supersededBy} which does not exist`);
      else if (t.supersedes !== e.id) errs.push(`${e.id} is superseded-by ${t.id} but ${t.id} does not name ${e.id} as supersedes`);
    }
  }
  return errs;
}

function upsertIndexRow(text, slug, summary) {
  const row = `| [[${slug}]] | ${summary} |`;
  const re = new RegExp(`^\\|\\s*\\[\\[${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\]\\s*\\|.*$`, 'm');
  if (re.test(text)) return text.replace(re, row);
  const table = /(\| Unit \| Summary \|\n\|---\|---\|\n(?:\|.*\|\n)*)/.exec(text);
  if (table) return text.replace(table[1], `${table[1]}${row}\n`);
  return `${text.replace(/\s*$/, '')}\n\n## Units\n| Unit | Summary |\n|---|---|\n${row}\n`;
}

function setReconciledSha(text, sha) {
  if (/^reconciled-sha:.*$/m.test(text)) return text.replace(/^reconciled-sha:.*$/m, `reconciled-sha: ${sha}`);
  return text.replace(/^(# .*\n)/m, `$1\nreconciled-sha: ${sha}\n`);
}

function readPending(file) {
  if (!fs.existsSync(file)) return [];
  return [...new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean))];
}
function writePending(file, shas) {
  fs.writeFileSync(file, [...new Set(shas)].map((s) => `${s}\n`).join(''));
}

function computeUnrecorded({ pending, reachable }) {
  const p = new Set(pending);
  return { queued: reachable.filter((s) => p.has(s)), unqueued: reachable.filter((s) => !p.has(s)) };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}

module.exports = { STATUS, EVIDENCE, FIELDS, mintEntryId, parseIndex, parseUnitFile, renderEntry, validateEntry, checkSupersedeLinks, upsertIndexRow, setReconciledSha, readPending, writePending, computeUnrecorded, git };
