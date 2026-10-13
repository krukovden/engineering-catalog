#!/usr/bin/env node
'use strict';

const {
  DEFAULT_STALE_DAYS,
  DEFAULT_THROTTLE_HOURS,
  defaultProjectStatePath,
  loadProjectState,
  discoverStates,
  moveWorkItem,
  reconcileBoard,
  readReconcileThrottle,
  resolveAdoContext,
  createTransport,
  manualEvidenceComment,
  repoRoot,
} = require('./lib');

function usage() {
  return [
    'usage:',
    '  node ado-board.js states discover [--state-file FILE] [--choose "Type:bucket=State"]... [--non-interactive] [--json]',
    '  node ado-board.js move <id> <todo|doing|verify|done> [--comment TEXT] [--allow-idp] [--state-file FILE] [--json]',
    '  node ado-board.js reconcile [--state-file FILE] [--stale-days N] [--throttle-hours N] [--allow-unconfigured] [--json]',
  ].join('\n');
}

function parse(argv) {
  const positionals = [];
  const options = { choose: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--non-interactive') options.nonInteractive = true;
    else if (arg === '--allow-unconfigured') options.allowUnconfigured = true;
    else if (arg === '--allow-idp') options.allowIdp = true;
    else if (arg === '--comment') options.comment = argv[++i];
    else if (arg.startsWith('--comment=')) options.comment = arg.slice('--comment='.length);
    else if (arg === '--state-file') options.stateFile = argv[++i];
    else if (arg.startsWith('--state-file=')) options.stateFile = arg.slice('--state-file='.length);
    else if (arg === '--choose') options.choose.push(argv[++i]);
    else if (arg.startsWith('--choose=')) options.choose.push(arg.slice('--choose='.length));
    else if (arg === '--stale-days') options.staleDays = Number(argv[++i]);
    else if (arg.startsWith('--stale-days=')) options.staleDays = Number(arg.slice('--stale-days='.length));
    else if (arg === '--throttle-hours') options.throttleHours = Number(argv[++i]);
    else if (arg.startsWith('--throttle-hours=')) options.throttleHours = Number(arg.slice('--throttle-hours='.length));
    else if (arg === '--context') options.contextName = argv[++i];
    else if (arg.startsWith('--context=')) options.contextName = arg.slice('--context='.length);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}`);
    else positionals.push(arg);
  }
  return { positionals, options };
}

function print(value, json) {
  if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else if (typeof value === 'string') process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const { positionals, options } = parse(process.argv.slice(2));
  if (options.help || positionals.length === 0) {
    print(usage(), false);
    process.exit(options.help ? 0 : 1);
  }

  const stateFile = options.stateFile || defaultProjectStatePath(process.cwd());
  const [command, subcommand, ...rest] = positionals;

  if (command === 'states' && subcommand === 'discover') {
    const context = resolveAdoContext({ contextName: options.contextName, cwd: process.cwd() });
    const transport = createTransport({ context });
    const result = await discoverStates({
      transport,
      context,
      stateFile,
      choose: options.choose,
      nonInteractive: options.nonInteractive === true,
    });
    print(result, options.json);
    return;
  }

  if (command === 'move') {
    const id = subcommand;
    const targetBucket = rest[0];
    if (!id || !targetBucket) throw new Error(usage());
    const state = loadProjectState(stateFile);
    if (!state?.stateMap) throw new Error(`No ado-board state map at ${stateFile}. Run "states discover" first.`);
    const context = resolveAdoContext({
      contextName: options.contextName,
      cwd: process.cwd(),
      state,
    });
    const transport = createTransport({ context });
    const result = await moveWorkItem({
      transport,
      context,
      stateMap: state.stateMap,
      id,
      targetBucket,
      comment: options.comment || manualEvidenceComment(process.cwd(), targetBucket),
      allowIdp: options.allowIdp === true,
      cwd: process.cwd(),
    });
    if (!result.ok) {
      print(result, options.json);
      process.exit(1);
    }
    print(result, options.json);
    return;
  }

  if (command === 'reconcile') {
    const state = loadProjectState(stateFile);
    if (!state?.stateMap) {
      if (options.allowUnconfigured) {
        print({ ok: true, command: 'reconcile', skipped: 'state-map-missing' }, options.json);
        return;
      }
      throw new Error(`No ado-board state map at ${stateFile}. Run "states discover" first.`);
    }
    const root = repoRoot(process.cwd());
    if (!root) throw new Error('reconcile needs a git repository.');
    const throttleHours = Number.isFinite(options.throttleHours) ? options.throttleHours : DEFAULT_THROTTLE_HOURS;
    const throttle = readReconcileThrottle({ root, hours: throttleHours });
    if (throttle.throttled) {
      print({ ok: true, command: 'reconcile', throttled: true, lastRunAt: throttle.lastRunAt }, options.json);
      return;
    }
    const context = resolveAdoContext({
      contextName: options.contextName,
      cwd: process.cwd(),
      state,
    });
    const transport = createTransport({ context });
    const result = await reconcileBoard({
      transport,
      context,
      stateMap: state.stateMap,
      cwd: process.cwd(),
      staleDays: Number.isFinite(options.staleDays) ? options.staleDays : DEFAULT_STALE_DAYS,
      throttleHours,
      stateFile,
      projectState: state,
    });
    print(result, options.json);
    return;
  }

  throw new Error(usage());
}

main().catch((error) => {
  const json = process.argv.includes('--json');
  const payload = { ok: false, error: error.message };
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
