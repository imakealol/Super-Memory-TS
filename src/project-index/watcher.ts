/**
 * File watcher for project directories
 * 
 * Uses chokidar to watch for file changes and emits events
 * for the indexer to process.
 */

import { EventEmitter } from 'events';
import chokidar, { type FSWatcher } from 'chokidar';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { FileEvent, WatcherConfig } from './types.js';
import { loadGitignorePatterns } from './indexer.js';
import { ALWAYS_EXCLUDED_PATTERNS } from './constants.js';

// Default watcher configuration

/**
 * ProjectWatcher - monitors project files for changes
 * 
 * Extends EventEmitter to notify about file changes.
 */
export class ProjectWatcher extends EventEmitter {
  private watcher: FSWatcher | null = null;
  private config: Required<WatcherConfig>;
  private isReady: boolean = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  
  constructor(config: WatcherConfig) {
    super();
    this.setMaxListeners(50); // Allow many listeners for testing

    // Load .gitignore patterns from the first path (root)
    const gitignorePatterns = config.paths.length > 0
      ? loadGitignorePatterns(config.paths[0])
      : [];

    // Merge config with defaults
    this.config = {
      paths: config.paths,
      includePatterns: config.includePatterns.length > 0
        ? config.includePatterns
        : ['**/*'],
      excludePatterns: [
        ...gitignorePatterns,
        ...ALWAYS_EXCLUDED_PATTERNS,
        ...config.excludePatterns,
      ],
      debounceMs: config.debounceMs ?? 500,
      ignoreHidden: config.ignoreHidden ?? true,
      ignoreInitial: config.ignoreInitial ?? false,
    };
  }
  
  /**
   * Start watching the configured paths
   */
  start(): void {
    if (this.watcher) {
      logger.warn('Watcher already started');
      return;
    }
    
    logger.info(`Starting watcher for: ${this.config.paths.join(', ')}`);
    
    // Build glob patterns
    const patterns = this.buildGlobPatterns();
    logger.debug(`Watching patterns: ${patterns.join(', ')}`);
    logger.debug(`Excluding: ${this.config.excludePatterns.join(', ')}`);
    
    // Create promise that resolves when ready
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    
    // For watching, we use direct paths and filter in code
    // This is more reliable than glob patterns for detecting all files
    const watchTargets = this.config.paths;
    logger.debug(`Watch targets (direct): ${watchTargets.join(', ')}`);
    
    // Create watcher with polling for better fs event detection in tests
    this.watcher = chokidar.watch(watchTargets, {
      ignored: (path: string) => {
        // Skip paths that are likely sockets or special files
        if (this.isSpecialFile(path)) {
          return true;
        }
        // Use the isPathExcluded check directly for proper filtering
        // This ensures we detect files at all directory levels
        return this.isPathExcluded(path);
      },
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false,
      usePolling: true,
      interval: 100,
      awaitWriteFinish: {
        stabilityThreshold: 300,
      },
      // Ignore permission errors on special files like sockets
      ignorePermissionErrors: true,
      // Disable atomic writes optimization for safety
      atomic: false,
    });
    
    // Set up handlers AFTER watcher is created
    this.setupEventHandlers();
  }
  
  /**
   * Build the actual glob patterns to watch
   */
  private buildGlobPatterns(): string[] {
    const patterns: string[] = [];
    
    for (const path of this.config.paths) {
      for (const include of this.config.includePatterns) {
        if (include.startsWith('**/*')) {
          // Already a glob pattern, use as-is
          patterns.push(join(path, include));
        } else {
          // Wrap in **/*
          patterns.push(join(path, '**', include));
        }
      }
    }
    
    return patterns;
  }
  
  /**
   * Check if a path should be excluded
   */
  private isPathExcluded(path: string): boolean {
    for (const pattern of this.config.excludePatterns) {
      if (this.matchGlob(pattern, path)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a path is a special file (socket, FIFO, etc.) that shouldn't be watched
   */
  private isSpecialFile(path: string): boolean {
    const normalizedPath = path.replace(/\\/g, '/');
    const basename = normalizedPath.split('/').pop() || '';

    // Skip common special files and patterns
    if (basename.startsWith('.')) {
      // Hidden files (except known safe ones like .gitignore)
      const safeHiddenFiles = ['.gitignore', '.gitattributes', '.editorconfig', '.eslintrc', '.prettierrc'];
      if (!safeHiddenFiles.includes(basename)) {
        return true;
      }
    }

    // Skip socket files and pipes
    if (normalizedPath.includes('.socket') ||
        normalizedPath.endsWith('.sock') ||
        normalizedPath.includes('/.X11-unix/') ||
        normalizedPath.includes('/.ICE-unix/')) {
      return true;
    }

    return false;
  }

  /**
   * Simple glob pattern matching
   */
  private matchGlob(pattern: string, path: string): boolean {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, '/');
    const normalizedPattern = pattern.replace(/\\/g, '/');
    
    // Handle ** (match any directory) separately from * (match within directory)
    // Replace ** first with a placeholder that won't be affected by * replacement
    let regexPattern = normalizedPattern
      .replace(/\./g, '\\.')  // Escape dots first
      .replace(/\*\*/g, '{{GLOB_STAR_STAR}}')  // Placeholder for **
      .replace(/\*/g, '[^/]*');  // * -> [^/]* (match any except /)
    
    // Now replace the placeholder with proper regex
    regexPattern = regexPattern.replace(/{{GLOB_STAR_STAR}}/g, '.*');
    
    // For patterns like *.log or **/*.log, we need to match the filename ending
    // Anchor the pattern to match the end of the path
    const regex = new RegExp(`.*${regexPattern}$`);
    return regex.test(normalizedPath);
  }

  /**
   * Set up chokidar event handlers
   */
  private setupEventHandlers(): void {
    if (!this.watcher) return;
    
    // File added
    this.watcher.on('add', (path: string) => {
      logger.debug(`chokidar add: ${path}`);
      if (this.isPathExcluded(path)) {
        logger.debug(`Path excluded, skipping: ${path}`);
        return;
      }
      this.emitFileEvent('add', path);
    });
    
    // File changed
    this.watcher.on('change', (path: string) => {
      logger.debug(`chokidar change: ${path}`);
      if (this.isPathExcluded(path)) {
        return;
      }
      this.emitFileEvent('change', path);
    });
    
    // File removed
    this.watcher.on('unlink', (path: string) => {
      logger.debug(`chokidar unlink: ${path}`);
      if (this.isPathExcluded(path)) {
        return;
      }
      this.emitFileEvent('unlink', path);
    });
    
    // Directory added
    this.watcher.on('addDir', (path: string) => {
      logger.debug(`Directory added: ${path}`);
    });
    
    // Directory removed
    this.watcher.on('unlinkDir', (path: string) => {
      logger.debug(`Directory removed: ${path}`);
    });
    
    // Error handler
    this.watcher.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error('Watcher error', { error: error.message });
      this.emit('error', error);
    });
    
    // Ready event - all initial files have been discovered
    this.watcher.on('ready', async () => {
      logger.info('Watcher ready - initial scan complete');
      this.isReady = true;
      this.emit('ready');
      
      // Emit 'scanComplete' after ready to signal that all initial events have been emitted
      // This is different from 'ready' - it's for indexers that need to wait for processing
      setTimeout(() => {
        this.emit('scanComplete');
      }, 100);
      
      if (this.readyResolve) {
        this.readyResolve();
        this.readyResolve = null;
        this.readyPromise = null;
      }
    });
  }
  
  /**
   * Emit a file event
   */
  private emitFileEvent(type: 'add' | 'change' | 'unlink', path: string, size?: number): void {
    try {
      const event: FileEvent = {
        type,
        path,
        timestamp: new Date(),
        size,
      };
      
      logger.debug(`Emitting ${type} event: ${path}`);
      this.emit('file', event);
    } catch (err) {
      logger.error(`Failed to emit file event: ${err}`);
    }
  }
  
  /**
   * Stop watching and close the watcher
   */
  async stop(): Promise<void> {
    if (!this.watcher) {
      return;
    }
    
    logger.info('Stopping watcher');
    await this.watcher.close();
    this.watcher = null;
    this.isReady = false;
  }
  
  /**
   * Check if watcher is ready
   */
  isWatcherReady(): boolean {
    return this.isReady;
  }
  
  /**
   * Wait for watcher to be ready
   */
  async waitForReady(): Promise<void> {
    if (this.isReady) {
      return;
    }
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }
  
  /**
   * Get the current watched paths
   */
  getWatchedPaths(): string[] {
    if (!this.watcher) return [];
    return Object.keys(this.watcher.getWatched());
  }
}

/**
 * Create a new watcher instance
 */
export function createWatcher(config: WatcherConfig): ProjectWatcher {
  return new ProjectWatcher(config);
}