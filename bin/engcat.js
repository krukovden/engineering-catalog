#!/usr/bin/env node
'use strict';
const { run } = require('../cli/index');

// `engcat list | head` closes stdout early; that is the reader's choice, not a failure.
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

run(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`\nError: ${err.message}`); process.exitCode = 1; });
