#!/usr/bin/env node
/**
 * Super-Memory MCP Server
 *
 * Main entry point for the MCP server that provides local-first
 * memory capabilities with embeddings and vector search.
 *
 * Usage:
 *   npx tsx src/index.ts
 *   node dist/index.js
 */

import os from 'os';
import path from 'path';

// Set transformers cache to user home to avoid permission issues in global installs
process.env.TRANSFORMERS_CACHE = path.join(os.homedir(), '.cache', 'transformers');

import { SuperMemoryServer } from './server.js';
import { loadConfig } from './config.js';
import { logger } from './utils/logger.js';

let server: SuperMemoryServer | null = null;
let isShuttingDown = false;

/**
 * Create and start the MCP server
 */
async function main(): Promise<void> {
  try {
    // Load config async to enable performance settings
    const config = await loadConfig();
    server = new SuperMemoryServer(config);
    await server.start();
  } catch (error) {
    logger.error('Failed to start server', error);
    // Give the server a chance to log its initialization error
    await new Promise(resolve => setTimeout(resolve, 100));
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler
 */
function setupShutdownHandlers(): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  for (const signal of signals) {
    process.on(signal, async () => {
      if (isShuttingDown) {
        logger.warn('Shutdown already in progress, forcing exit');
        process.exit(1);
      }
      isShuttingDown = true;
      logger.info(`Received ${signal}, initiating graceful shutdown...`);
      try {
        if (server) {
          await server.shutdown();
        }
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown', error);
        process.exit(1);
      }
    });
  }

  // Handle uncaught exceptions - log before exit with graceful shutdown
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', error);
    // Give logger and in-flight requests time to complete before exit
    setTimeout(() => process.exit(1), 5000);
  });

  // Handle unhandled promise rejections - log before exit with graceful shutdown
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection', { reason, promise });
    // Give logger and in-flight requests time to complete before exit
    setTimeout(() => process.exit(1), 5000);
  });
}

// Start the server
setupShutdownHandlers();
main().catch((error) => {
  logger.error('Unhandled error in main', error);
  process.exit(1);
});

export { SuperMemoryServer } from './server.js';
export { loadConfig, validateConfig } from './config.js';
export * from './utils/errors.js';
export * from './utils/logger.js';
export * from './utils/hash.js';
