'use strict';
const fs = require('fs');
const path = require('path');
const { hashFile } = require('./units');

const key = (u) => `${u.kind}:${u.name}`;

function diffUnits(record, plan) {
  const before = new Map(record.units.map((u) => [key(u), u]));
  const after = new Map(plan.items.map((i) => [key(i.unit), i.unit]));
  const added = [], changed = [], unchanged = [], removed = [];
  for (const [k, unit] of after) {
    const prev = before.get(k);
    if (!prev) added.push(unit);
    else if (prev.version !== unit.version) changed.push({ unit, from: prev.version });
    else unchanged.push(unit);
  }
  for (const [k, u] of before) if (!after.has(k)) removed.push({ kind: u.kind, name: u.name, version: u.version });
  return { added, changed, unchanged, removed };
}

function detectLocalEdits(record, baseDir) {
  const out = [];
  for (const u of record.units) {
    for (const [file, hash] of Object.entries(u.files)) {
      const abs = path.join(baseDir, file);
      if (!fs.existsSync(abs)) out.push({ kind: u.kind, name: u.name, file, status: 'missing' });
      else if (hashFile(abs) !== hash) out.push({ kind: u.kind, name: u.name, file, status: 'edited' });
    }
  }
  return out;
}

function staleFiles(record, plan) {
  const planned = new Set(plan.items.flatMap((i) => i.outputs.map((o) => o.path)));
  return record.units.flatMap((u) => Object.keys(u.files)).filter((f) => !planned.has(f)).sort();
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { diffUnits, detectLocalEdits, staleFiles, compareVersions };
