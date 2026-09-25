'use strict';
// Normalises a `claude plugin eval --json` payload (and, later, the Copilot equivalent) into
// the flat RunRecord shape the rest of the harness works with, plus the append-only JSONL
// store those records live in and the fingerprint that makes a comparison reproducible.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// One entry per invalid kind, in the order they are tried. A new wording is a one-line change.
const INVALID_PATTERNS = {
  'rate-limit': /rate limit|429|overloaded|rate_limit_error/i,
  'usage-limit': /usage limit|quota|credit balance|insufficient/i,
  auth: /authentication|unauthorized|401|invalid api key|oauth|not logged in/i,
};

/** null for a normal run — including one that carries an `error` string, like a max-turns exit. */
function classifyInvalid({ error, partial, score }) {
  if (partial) return { kind: 'partial', reason: 'run payload marked partial' };
  if (typeof error === 'string') {
    for (const [kind, pattern] of Object.entries(INVALID_PATTERNS)) {
      if (pattern.test(error)) return { kind, reason: error };
    }
  }
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return { kind: 'crash', reason: 'no score reported' };
  }
  return null;
}

function toCaseMap(cases) {
  if (cases instanceof Map) return cases;
  const map = new Map();
  for (const c of cases || []) map.set(c.name, c);
  return map;
}

// evals/<group>/<case> — used only when the case isn't in the suite map (e.g. a stale record).
function groupFromDir(dir) {
  const parts = String(dir || '').split('/');
  return parts[1];
}

function mapGrader(g) {
  return { name: g.name, passed: g.passed, weight: g.weight, scored: g.scored, explanation: g.explanation };
}

function buildRecord({ cell, arm, payloadCase, meta, run, index, partial }) {
  return {
    cell,
    arm,
    caseName: payloadCase.name,
    group: meta.group,
    tags: meta.tags,
    run: index,
    score: run.score,
    passed: run.passed,
    graders: (run.graders || []).map(mapGrader),
    turns: run.turns,
    costUsd: run.costUsd,
    durationSeconds: run.durationSeconds,
    startedAt: run.startedAt,
    error: run.error === undefined ? null : run.error,
    invalid: classifyInvalid({ error: run.error, partial, score: run.score, skippedPaidGraders: run.skippedPaidGraders }),
  };
}

/** One `RunRecord` per run in `json.cases[].arms.{with,without}`; `without` always reads as arm 'none'. */
function fromClaudeJson(json, { cell, arm, cases }) {
  const caseMap = toCaseMap(cases);
  const records = [];
  for (const payloadCase of json.cases || []) {
    const found = caseMap.get(payloadCase.name);
    const meta = found ? { group: found.group, tags: found.tags || [] } : { group: groupFromDir(payloadCase.dir), tags: [] };
    const arms = payloadCase.arms || {};
    for (const [runs, armLabel] of [[arms.with, arm], [arms.without, 'none']]) {
      if (!Array.isArray(runs)) continue;
      runs.forEach((run, index) => {
        records.push(buildRecord({ cell, arm: armLabel, payloadCase, meta, run, index, partial: json.partial }));
      });
    }
  }
  return records;
}

const validRuns = (records) => records.filter((r) => r.invalid === null);
const invalidRuns = (records) => records.filter((r) => r.invalid !== null);

function writeRecords(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = records.map((r) => `${JSON.stringify(r)}\n`).join('');
  fs.appendFileSync(file, lines);
}

function readRecords(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const records = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`${file}:${i + 1}: malformed JSONL record (${e.message})`);
    }
  });
  return records;
}

/** 12-hex sha256 over every case's relDir + prompt + serialised graders, sorted by relDir. */
function hashSuite(cases) {
  const sorted = [...cases].sort((a, b) => (a.relDir < b.relDir ? -1 : a.relDir > b.relDir ? 1 : 0));
  const hash = crypto.createHash('sha256');
  for (const c of sorted) {
    hash.update(c.relDir);
    hash.update(c.prompt);
    hash.update(JSON.stringify(c.graders));
  }
  return hash.digest('hex').slice(0, 12);
}

/** Drops undefined keys and sorts the rest, so the same inputs serialise identically regardless of call order. */
function fingerprint(parts = {}) {
  const out = {};
  for (const key of Object.keys(parts).sort()) {
    if (parts[key] !== undefined) out[key] = parts[key];
  }
  return out;
}

module.exports = {
  INVALID_PATTERNS,
  classifyInvalid,
  fromClaudeJson,
  validRuns,
  invalidRuns,
  writeRecords,
  readRecords,
  hashSuite,
  fingerprint,
};
