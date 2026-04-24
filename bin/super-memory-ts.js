#!/usr/bin/env node
// Auto-increase heap size for large model + project indexing
require('v8').setFlagsFromString('--max-old-space-size=8192');
require('../dist/index.js');