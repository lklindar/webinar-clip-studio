#!/usr/bin/env node
// Polish command line (shared by all polish-* skills): node polish.cjs <command> VIDEO [options]
// The code lives in shared-agent-capabilities/lib/polish (TypeScript source in src/, built into dist/).
const path = require('node:path');
require(path.join(__dirname, '..', '..', '..', 'lib', 'polish', 'dist', 'node', 'cli.js'));
