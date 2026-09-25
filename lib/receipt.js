'use strict';
const fs = require('fs');
const path = require('path');
const { hashContent } = require('./units');

const RECEIPT_DIR = '.engineering-catalog';
const receiptPath = (baseDir) => path.join(baseDir, RECEIPT_DIR, 'receipt.json');

function readReceipt(baseDir) {
  const file = receiptPath(baseDir);
  if (!fs.existsSync(file)) return { schema: 1, installs: [] };
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { throw new Error(`cannot read ${file}: ${err.message}`); }
}

function writeReceipt(baseDir, receipt) {
  const file = receiptPath(baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}

function makeInstall({ target, scope, catalogVersion, source, bundles = [], units = [], date = new Date().toISOString() }) {
  return { target, scope, catalogVersion, source, bundles, date, units };
}

function upsertInstall(receipt, record) {
  const installs = receipt.installs.filter((i) => !(i.target === record.target && i.scope === record.scope));
  installs.push(record);
  installs.sort((a, b) => a.target.localeCompare(b.target) || a.scope.localeCompare(b.scope));
  return { ...receipt, schema: 1, installs };
}

function findInstall(receipt, target, scope) {
  return receipt.installs.find((i) => i.target === target && i.scope === scope) || null;
}

function recordFromOutputs({ target, scope, catalogVersion, source, bundles, planned, date }) {
  const units = planned.map(({ unit, outputs }) => ({
    kind: unit.kind, name: unit.name, version: unit.version,
    files: Object.fromEntries(outputs.map((o) => [o.path, hashContent(o.content)])),
  }));
  return makeInstall({ target, scope, catalogVersion, source, bundles, units, date });
}

module.exports = { RECEIPT_DIR, receiptPath, readReceipt, writeReceipt, makeInstall, upsertInstall, findInstall, recordFromOutputs, hashContent };
