#!/usr/bin/env node
'use strict';
// `npm run e2e:install` — runs scripts/e2e/run-scenarios.js inside the same podman/docker
// image the eval harness already builds (evals/container/Containerfile: Node 20 + git, no
// engcat dependencies to install — catalog.json is committed and engcat has zero runtime npm
// deps). Simulates an unrelated host machine installing the catalog for the first time,
// which running run-scenarios.js directly on this dev machine cannot: this repo's own
// checkout is never a clean install target.
//
// Reuses scripts/eval/isolation.js's runtime detection instead of a second copy: podman
// first, docker second, and — matching evals/container's own `--container auto` behaviour —
// a missing runtime skips with exit 0 rather than failing the build. The repo is mounted
// read-only; every scenario's scratch state lives on the container's own /tmp, never on a
// host bind mount, so there is nothing to clean up here afterward.
const path = require('path');
const { spawnSync } = require('child_process');
const { detectRuntime, buildImage, imageTag } = require('../eval/isolation');

const ROOT = path.resolve(__dirname, '..', '..');

function main() {
  const runtime = detectRuntime();
  if (!runtime) {
    console.log('e2e install smoke: skipped — no podman or docker on PATH');
    return 0;
  }

  console.log(`e2e install smoke: building image with ${runtime}...`);
  try {
    buildImage({ runtime, root: ROOT });
  } catch (e) {
    console.error(`e2e install smoke: image build failed: ${e.message}`);
    return 1;
  }

  const script = path.join(ROOT, 'scripts/e2e/run-scenarios.js');
  const res = spawnSync(runtime, ['run', '--rm', '-v', `${ROOT}:${ROOT}:ro`, imageTag(), 'node', script], { stdio: 'inherit' });
  if (res.error) {
    console.error(`e2e install smoke: ${runtime} run failed: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

process.exit(main());
