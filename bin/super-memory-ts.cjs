#!/usr/bin/env node
// Auto-increase heap size for large model + project indexing
/* global process */
const path = require('path');
const fs = require('fs');

// Get config path (project-local, relative to cwd)
function getConfigPath() {
  return path.join(process.cwd(), '.opencode', 'super-memory-ts', 'config.json');
}

// Read maxHeapMB from config file
function getMaxHeapMB() {
  try {
    const configPath = getConfigPath();
    const content = fs.readFileSync(configPath, 'utf-8');
    const config = JSON.parse(content);
    return config.performance?.maxHeapMB || 8192;
  } catch {
    return 8192;
  }
}

const maxHeapMB = getMaxHeapMB();
require('v8').setFlagsFromString(`--max-old-space-size=${maxHeapMB}`);
require('../dist/index.js');