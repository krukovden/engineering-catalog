'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// The script is Windows PowerShell and cannot run in this offline suite, so these pin the
// structure of the two guarantees instead.
const SRC = fs.readFileSync(path.join(__dirname, '..', 'skills/qa/qa-ado-work-item/scripts/publish-work-item.ps1'), 'utf8');
const code = SRC.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

test('approval hash covers the resolved organization and project', () => {
  const m = code.match(/\$canonical = "(.*)"/);
  assert.ok(m, 'canonical string present');
  assert.match(m[1], /\$organization/);
  assert.match(m[1], /\$project/);
});

test('receipts record the destination', () => {
  const receipts = code.match(/\[ordered\]@\{ state = "[a-z-]+"[^\n]*/g);
  assert.equal(receipts.length, 3);
  for (const r of receipts) assert.match(r, /organization = \$organization; project = \$project/);
});

test('the receipt is claimed with exclusive creation before the POST', () => {
  const open = code.indexOf('[IO.FileMode]::CreateNew');
  const post = code.indexOf('-Method "Post"');
  assert.ok(open > 0 && post > open, 'CreateNew precedes the POST');
  assert.match(code, /if \(-not \(New-ReceiptLock/);
  assert.doesNotMatch(code, /if \(Test-Path -LiteralPath \$receiptPath\) \{\s*\$receipt = /, 'no check-then-write race');
});

test('a definitive 4xx rejection releases the receipt; an ambiguous failure keeps it', () => {
  const catchBlock = code.slice(code.indexOf('-Method "Post"'), code.indexOf('$itemUrl ='));
  const release = catchBlock.indexOf('Remove-Item -LiteralPath $receiptPath');
  const keep = catchBlock.indexOf('state = "failed"');
  assert.ok(release > 0 && keep > release);
  assert.match(catchBlock, /HTTP \(400\|401\|403\|404\|422\)/);
});
