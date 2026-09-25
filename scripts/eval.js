#!/usr/bin/env node
'use strict';
// `npm run eval -- <command>` — the local eval harness. Nothing here calls a model yet:
// lint, static and affected are the free tiers that run on every change.
const fs = require('fs');
const path = require('path');
const { ROOT, FOLDERS, scanUnits } = require('../lib/units');
const { scanHooks } = require('../lib/hooks');
const { loadSuite } = require('./eval/cases');
const { contextBudget } = require('./eval/static');
const { changedPaths, selectCases } = require('./eval/affected');

const USAGE = `engineering-catalog evals — local experiments against this repository.

  npm run eval -- lint                      check every case in evals/ loads and is gradable
  npm run eval -- static                    always-on description cost per target (no model calls)
  npm run eval -- affected --base <ref>     the cases a change can move [--tier 1|2|3] [--all]
  npm run eval -- compare --base <ref>      run those cases against both trees and score the change
                                            [--tier 1|2|3] [--all] [--targets claude,copilot]
                                            [--case <substring>] [--runs n] [--max-cost-usd n]
                                            [--container auto|off|required]
                                            [--record <slug> --hypothesis "…"]

Only \`compare\` calls a model; the other three are free. Run \`npm test\` for the
deterministic side of the harness.`;

function parseArgs(argv) {
  const args = { command: argv[0], tier: 2, all: false, targets: ['claude'], container: 'auto' };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--base') args.base = argv[++i];
    else if (flag === '--tier') args.tier = Number(argv[++i]);
    else if (flag === '--all') args.all = true;
    else if (flag === '--targets') args.targets = argv[++i].split(',').map((t) => t.trim());
    else if (flag === '--case') args.caseFilter = argv[++i];
    else if (flag === '--runs') args.runsOverride = Number(argv[++i]);
    else if (flag === '--max-cost-usd') args.maxCostUsd = Number(argv[++i]);
    else if (flag === '--container') {
      const value = argv[++i];
      if (!['auto', 'off', 'required'].includes(value)) args.unknown = `--container ${value}`;
      else args.container = value;
    }
    else if (flag === '--record') args.record = argv[++i];
    else if (flag === '--hypothesis') args.hypothesis = argv[++i];
    else if (flag === '--help' || flag === '-h') args.help = true;
    else args.unknown = flag;
  }
  return args;
}

function lint({ root }) {
  const { cases, errors } = loadSuite({ root });
  for (const e of errors) console.error(`✗ ${e}`);
  if (errors.length) return 1;
  const groups = [...new Set(cases.map((c) => c.group))].sort();
  const triggers = cases.filter((c) => c.tags.some((t) => t.startsWith('trigger:'))).length;
  console.log(`✓ ${cases.length} case(s) in ${groups.length} group(s): ${groups.join(', ')}`);
  console.log(`  ${triggers} trigger, ${cases.length - triggers} behaviour/scenario`);
  return 0;
}

function staticReport({ root }) {
  const { units } = scanUnits({ root, folders: FOLDERS });
  const budget = contextBudget({ units });
  for (const [target, b] of Object.entries(budget)) {
    console.log(`${target}: ${b.chars} chars ≈ ${b.tokens} tokens of always-on descriptions, ${b.items.length} unit(s)`);
    for (const item of b.items.slice(0, 5)) console.log(`    ${String(item.chars).padStart(5)}  ${item.kind} ${item.name}`);
    if (b.items.length > 5) console.log(`    …and ${b.items.length - 5} more`);
  }
  return 0;
}

function affected({ root, base, tier, all }) {
  if (!base) { console.error('✗ affected needs --base <ref>'); return 1; }
  const { units } = scanUnits({ root, folders: FOLDERS });
  const hooks = scanHooks({ root });
  const { cases, errors } = loadSuite({ root });
  if (errors.length) { console.error('✗ fix `npm run eval -- lint` first'); return 1; }
  const changed = changedPaths({ root, base });
  const selection = selectCases({ cases, units, hooks, changed, tier, all });
  console.log(`${changed.length} changed path(s) since ${base}`);
  console.log(`units: ${[...selection.unitNames].sort().join(', ') || '(none)'}`);
  if (selection.hookIds.size) console.log(`hooks: ${[...selection.hookIds].sort().join(', ')}`);
  console.log(`tier ${tier}: ${selection.cases.length} case(s)`);
  for (const c of selection.cases) console.log(`  ${c.relDir}`);
  return 0;
}

/** The one command that costs money; everything it needs is loaded lazily so the free
 *  commands never pay for parsing the runner. */
async function compareCommand({ root, base, ...rest }) {
  if (!base) { console.error('✗ compare needs --base <ref>'); return 1; }
  if (rest.record && !rest.hypothesis) { console.error('✗ --record needs --hypothesis: the claim is fixed before the run, not after'); return 1; }
  const { compare } = require('./eval/compare');
  const result = await compare({ root, base, ...rest });
  if (result.error) { console.error(`✗ ${result.error}`); return result.exitCode || 1; }
  return result.exitCode;
}

function run(argv, { root = ROOT } = {}) {
  const args = parseArgs(argv);
  if (args.help || !args.command) { console.log(USAGE); return args.command ? 0 : 1; }
  if (args.unknown) { console.error(`✗ unknown option ${args.unknown}`); return 1; }
  const commands = { lint, static: staticReport, affected, compare: compareCommand };
  const command = commands[args.command];
  if (!command) { console.error(`✗ unknown command "${args.command}"\n\n${USAGE}`); return 1; }
  return command({ ...args, root });
}

if (require.main === module) Promise.resolve(run(process.argv.slice(2))).then((code) => { process.exitCode = code; });
module.exports = { run, parseArgs, USAGE };
