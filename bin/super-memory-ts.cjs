#!/usr/bin/env node
// Auto-increase heap size for large model + project indexing
const os = require('os');
const path = require('path');
const fs = require('fs');

// Get config path (respects XDG_CONFIG_HOME)
function getConfigPath() {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const configHome = xdgConfigHome || path.join(os.homedir(), '.config');
  return path.join(configHome, 'super-memory-ts', 'config.json');
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