#!/usr/bin/env node
'use strict';
// Alias of ado-board.js, kept for callers and docs that name board.js.
const cli = require('./ado-board.js');

if (require.main === module) cli.main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = cli;
