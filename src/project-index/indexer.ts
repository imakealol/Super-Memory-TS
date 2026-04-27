/**
 * Project file indexer
 * 
 * Handles file indexing with:
 * - Incremental updates using SHA-256 hash comparison
 * - Background indexing on startup
 * - Support for multiple file types
 * - HNSW index for fast search
 */

import os from 'os';
import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { extname, sep, resolve } from 'path';
import { logger } from '../utils/logger.js';
import { ProjectWatcher, createWatcher } from './watcher.js';
import { FileChunker, createChunker } from './chunker.js';
import { generateEmbeddings } from '../model/embeddings.js';
import { MemoryDatabase, getDatabase, type MemoryEntryInput } from '../memory/database.js';
import { FileTracker } from './file-tracker.js';
import { SnapshotIndex } from './snapshot.js';
import { PauseController } from './pause-controller.js';
import type {
  ProjectIndexConfig,
  ProjectIndexConfigInternal,
  ProjectChunk,
  FileEvent,
  ProjectSearchOptions,
  ProjectSearchResult,
  ProjectIndexerStats,
} from './types.js';

// File types and directories to skip during indexing
const SKIP_EXTENSIONS = new Set(['.db', '.har', '.db-journal', '.db-wal', '.sqlite', '.sqlite3']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

// Memory management constants
const MAX_FILE_SIZE_MB = 5; // Skip files larger than 5MB
const DEFAULT_MEMORY_THRESHOLD = 0.85; // Force flush if heap usage exceeds 85%

const DEFAULT_FLUSH_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50MB

/**
 * Check if a file should be skipped based on extension or directory
 */
function shouldSkipFile(filePath: string): boolean {
  const fileExt = extname(filePath).toLowerCase();
  if (SKIP_EXTENSIONS.has(fileExt)) return true;

  const parts = filePath.split(sep);
  if (parts.some(p => SKIP_DIRS.has(p))) return true;

  return false;
}

/**
 * ProjectIndexer - indexes project files for semantic search
 */
export class ProjectIndexer extends EventEmitter {
  private config: ProjectIndexConfigInternal;
  private watcher: ProjectWatcher | null = null;
  private chunker: FileChunker;
  private db: MemoryDatabase;
  private fileTracker: FileTracker;
  private isRunning: boolean = false;
  private processingPromises: Map<string, Promise<void>> = new Map();
  private pendingEventCount: number = 0;
  private processingCompleteResolve: (() => void) | null = null;
  private processingCompletePromise: Promise<void> | null = null;

  // In-memory buffer for batch writes
  private pendingChunks: MemoryEntryInput[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private currentBufferBytes: number = 0;

  // Pause/resume for priority indexing
  private pauseController: PauseController = new PauseController();
  private periodicScanTimer: NodeJS.Timeout | null = null;
  private snapshotIndex: SnapshotIndex | null = null;

  // Memory warning cooldown to reduce log spam
  private lastMemoryWarning = 0;
  private readonly MEMORY_WARNING_COOLDOWN_MS = 5000; // Only warn every 5 seconds

  constructor(config: ProjectIndexConfig, db?: MemoryDatabase, dbUri?: string, _projectId?: string) {
    super();
    
    // Build internal config with all required fields
    const cpuCount = os.cpus().length;
    this.config = {
      rootPath: config.rootPath || '.',
      includePatterns: config.includePatterns?.length 
        ? config.includePatterns 
        : ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
      excludePatterns: [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/*.log',
        '**/.cache/**',
        ...(config.excludePatterns || []),
      ],
      maxFileSize: config.maxFileSize || 1024 * 1024,
      chunkSize: config.chunkSize || 512,
      chunkOverlap: config.chunkOverlap || 50,
      workers: config.workers ?? cpuCount,
      flushIntervalMs: config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      flushThreshold: config.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD,
      memoryThreshold: config.memoryThreshold ?? DEFAULT_MEMORY_THRESHOLD,
      maxBufferBytes: config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      indexingPriority: config.indexingPriority || 'normal',
      pauseIndexingDuringRequests: config.pauseIndexingDuringRequests ?? true,
      periodicScanIntervalMs: config.periodicScanIntervalMs ?? 300000,
      yieldMs: config.yieldMs ?? 10,
    };
    
    // Use provided database, or create with projectId if dbUri provided
    if (db) {
      this.db = db;
    } else if (dbUri) {
      this.db = getDatabase(dbUri, _projectId);
    } else {
      this.db = getDatabase(undefined, _projectId);
    }
    
    this.chunker = createChunker({
      maxChunkSize: this.config.chunkSize,
      overlap: this.config.chunkOverlap,
      minChunkSize: 50,
      splitBy: 'semantic',
    });

    // Initialize persistent file tracker
    this.fileTracker = new FileTracker(resolve(dbUri || './memory_data', '../file_tracker.db'));
  }

  /**
   * Start the indexer - begin watching and initial indexing
   */
  async start(snapshotPath?: string): Promise<void> {
    if (this.isRunning) {
      logger.warn('Indexer already running');
      return;
    }

    logger.info('Starting project indexer');
    this.isRunning = true;

    // Ensure database is initialized (use shared singleton)
    if (!this.db) {
      this.db = getDatabase();
    }
    try {
      await this.db.initialize();
    } catch (err) {
      logger.error('Failed to initialize database', { error: err instanceof Error ? err.message : String(err) });
      this.isRunning = false;
      throw new Error(
        `Database initialization failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Initialize snapshot index for incremental updates
    const snapshotRootPath = this.config.rootPath;
    const defaultSnapshotPath = snapshotPath || resolve(snapshotRootPath, '.opencode/super-memory-ts/snapshot.json');
    
    const snapshotIndex = new SnapshotIndex(snapshotRootPath, defaultSnapshotPath);
    await snapshotIndex.init();
    
    // Store snapshot index reference
    this.snapshotIndex = snapshotIndex;
    
    // Run snapshot scan to detect changed files
    logger.info('Running snapshot scan...');
    const delta = await snapshotIndex.scan();
    logger.info(`Snapshot scan complete: ${delta.unchanged.length} unchanged, ${delta.new.length} new, ${delta.changed.length} changed, ${delta.deleted.length} deleted`);
    
    // Handle deleted files - remove from database
    for (const relPath of delta.deleted) {
      const fullPath = resolve(snapshotRootPath, relPath);
      await this.removeFile(fullPath);
      snapshotIndex.markDeleted(relPath);
    }
    
    // Process new and changed files
    const filesToProcess = [...delta.new, ...delta.changed];
    logger.info(`Processing ${filesToProcess.length} files (${delta.new.length} new, ${delta.changed.length} changed)`);
    
    for (const relPath of filesToProcess) {
      // Yield to event loop for pause control
      await this.pauseController.shouldYield();
      
      const fullPath = resolve(snapshotRootPath, relPath);
      // Use precomputed hash from snapshot if available (from changed files)
      const precomputedHash = snapshotIndex.getFileHash(relPath);
      await this.processFile(fullPath, precomputedHash);
      
      // Yield to event loop after each file to prevent blocking
      await this.yieldToEventLoop();
    }
    
    // Save snapshot after processing
    await snapshotIndex.save();

    // Start periodic scan for incremental updates
    this.startPeriodicScan();

    // Create and start the watcher with ignoreInitial so it doesn't re-process files
    this.watcher = createWatcher({
      paths: [this.config.rootPath],
      includePatterns: this.config.includePatterns,
      excludePatterns: this.config.excludePatterns,
      debounceMs: 500,
      ignoreHidden: true,
      ignoreInitial: true, // Snapshot scan handled initial indexing
    });

    // Handle file events
    this.watcher!.on('file', (event: FileEvent) => {
      // Skip files that shouldn't be indexed
      if (shouldSkipFile(event.path)) {
        logger.debug(`Skipping file due to extension/directory filter: ${event.path}`);
        return;
      }
      logger.debug(`Indexer received file event: ${event.type} ${event.path}`);
      this.handleFileEvent(event);
    });
    
    // Handle watcher errors
    this.watcher!.on('error', (error: Error) => {
      logger.error('Watcher error in indexer', { error: error.message });
      this.emit('error', error);
    });

    // Handle ready event - use 'scanComplete' to know all initial events have been emitted
    this.watcher!.on('scanComplete', async () => {
      logger.info('Watcher scanComplete event received');
      logger.info(`Initial scan complete, pendingEventCount=${this.pendingEventCount}, waiting for indexing to finish`);
      // Wait for initial file processing to complete before signaling ready
      await this.waitForProcessingComplete();
      logger.info('Initial indexing complete');
      const allFiles = this.fileTracker.getAllFiles();
      logger.info(`Final stats before emit: indexedFiles=${allFiles.size}, totalChunks=${Array.from(allFiles.values()).reduce((sum, f) => sum + f.chunkCount, 0)}`);
      this.emit('stats', this.getStats());
    });
    
    // Also listen for 'ready' to ensure watcher is fully initialized
    this.watcher!.on('ready', () => {
      logger.debug('Watcher ready event received');
    });

    logger.debug('Starting watcher...');
    // Start watching
    this.watcher!.start();
    logger.debug('Watcher started');

    // Wait for scanComplete event to fire and initial processing to complete
    // This ensures start() doesn't return until initial indexing is done
    await new Promise<void>((resolve) => {
      // Listen for 'stats' event which indicates initial indexing is complete
      this.once('stats', () => {
        logger.debug('Received stats event, start() complete');
        resolve();
      });
      
      // Also set a timeout as a safety net
      setTimeout(() => {
        logger.warn('start() timeout reached, proceeding anyway');
        resolve();
      }, 30000);
    });
    
    logger.debug(`start() returning. indexedFiles=${this.fileTracker.getAllFiles().size}`);
  }

  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping project indexer');

    // Flush any pending chunks before stopping
    await this.flush();

    // Wait for any pending processing to complete
    await this.waitForProcessingComplete();

    // Clear periodic scan timer
    if (this.periodicScanTimer) {
      clearInterval(this.periodicScanTimer);
      this.periodicScanTimer = null;
    }

    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }

    this.processingPromises.clear();
    this.isRunning = false;
  }

  /**
   * Handle file events from the watcher
   */
  private async handleFileEvent(event: FileEvent): Promise<void> {
    logger.debug(`handleFileEvent called: ${event.type} ${event.path}, pendingEventCount before=${this.pendingEventCount}`);
    
    // Yield to event loop if paused
    await this.pauseController.shouldYield();
    
    // Avoid duplicate processing
    const existingPromise = this.processingPromises.get(event.path);
    if (existingPromise) {
      logger.debug(`Event already being processed, waiting for it: ${event.path}`);
      await existingPromise;
      return;
    }

    this.pendingEventCount++;
    logger.debug(`pendingEventCount incremented to ${this.pendingEventCount}`);
    
    const promise = this.processEvent(event);
    this.processingPromises.set(event.path, promise);

    try {
      await promise;
      logger.debug(`Event processed successfully: ${event.type} ${event.path}`);
    } finally {
      this.processingPromises.delete(event.path);
      this.pendingEventCount--;
      logger.debug(`pendingEventCount decremented to ${this.pendingEventCount}, processingCompleteResolve=${this.processingCompleteResolve ? 'set' : 'null'}`);
      if (this.pendingEventCount === 0 && this.processingCompleteResolve) {
        logger.debug('Calling processingCompleteResolve');
        this.processingCompleteResolve();
        this.processingCompleteResolve = null;
        this.processingCompletePromise = null;
      }
    }
  }

  /**
   * Wait for all pending file events to be processed
   */
  async waitForProcessingComplete(): Promise<void> {
    logger.debug(`waitForProcessingComplete called. pendingEventCount=${this.pendingEventCount}`);
    
    // Keep waiting until pending count is 0 and we've had a chance to process
    // any events that might be queued in the event loop
    let lastCount = -1;
    let sameCountTicks = 0;
    
    while (this.pendingEventCount > 0 || sameCountTicks < 2) {
      // If we have pending events and no resolve promise, create one
      if (this.pendingEventCount > 0 && !this.processingCompletePromise) {
        logger.debug(`Creating processingCompletePromise with ${this.pendingEventCount} pending events`);
        this.processingCompletePromise = new Promise((resolve) => {
          this.processingCompleteResolve = resolve;
        });
      }
      
      // If we have a promise to await, wait for it
      if (this.processingCompletePromise) {
        logger.debug(`Awaiting processingCompletePromise...`);
        await this.processingCompletePromise;
        this.processingCompletePromise = null;
        this.processingCompleteResolve = null;
        logger.debug(`ProcessingCompletePromise resolved. pendingEventCount=${this.pendingEventCount}`);
      }
      
      // Yield to event loop to process any pending callbacks
      if (this.pendingEventCount === lastCount) {
        sameCountTicks++;
        if (sameCountTicks >= 2 && this.pendingEventCount === 0) {
          logger.debug(`waitForProcessingComplete ending: stable state with 0 pending`);
          break;
        }
      } else {
        sameCountTicks = 0;
        lastCount = this.pendingEventCount;
      }
      
      // Yield to event loop
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  /**
   * Process a single file event
   */
  private async processEvent(event: FileEvent): Promise<void> {
    switch (event.type) {
      case 'add':
      case 'change':
        await this.processFile(event.path);
        break;
      case 'unlink':
        await this.removeFile(event.path);
        break;
    }
  }

  /**
   * Process a file - read, hash, chunk, embed, and store
   */
  async processFile(filePath: string, precomputedHash?: string): Promise<void> {
    // Skip bad files at processFile level as safeguard
    const SKIP_EXTS = new Set(['.db', '.har', '.db-journal', '.db-wal', '.tmp']);
    const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build'];
    if (SKIP_EXTS.has(extname(filePath).toLowerCase())) return;
    if (SKIP_DIRS.some(d => filePath.includes(d))) return;

    logger.debug(`processFile called: ${filePath}`);
    try {
      // Check file size BEFORE reading (prevent OOM)
      const stats = await stat(filePath);
      const fileSizeMB = stats.size / (1024 * 1024);
      if (fileSizeMB > MAX_FILE_SIZE_MB) {
        logger.warn(`File too large (${fileSizeMB.toFixed(1)}MB), skipping: ${filePath}`);
        return;
      }

      // Check memory pressure before processing
      const memUsage = process.memoryUsage();
      const heapUsageRatio = memUsage.heapUsed / memUsage.heapTotal;
      if (heapUsageRatio > this.config.memoryThreshold) {
        const now = Date.now();
        if (now - this.lastMemoryWarning > this.MEMORY_WARNING_COOLDOWN_MS) {
          logger.warn(`Memory pressure high (${(heapUsageRatio * 100).toFixed(0)}%), forcing buffer flush`);
          this.lastMemoryWarning = now;
        }
        await this.flushPendingChunks();
      }

      // Check file size
      if (stats.size > this.config.maxFileSize) {
        logger.warn(`File too large, skipping: ${filePath} (${stats.size} bytes)`);
        return;
      }

      // Read file content
      const content = await readFile(filePath, 'utf-8');
      logger.debug(`Read file ${filePath}: ${content.length} chars`);
      
      // Compute hash - use precomputed xxhash from snapshot if available, otherwise compute SHA-256
      const hash = precomputedHash || this.computeHash(content);
      
      // Check if file has changed
      const existing = this.fileTracker.getFile(filePath);
      if (existing?.hash === hash) {
        logger.debug(`File unchanged, skipping: ${filePath}`);
        return;
      }

      // Delete old chunks for this file
      await this.deleteChunksForFile(filePath);

      // Chunk the file
      const chunks = this.chunker.chunkFile(content, filePath);
      logger.debug(`Chunked ${filePath} into ${chunks.length} chunks`);

      // Queue chunks to in-memory buffer for batch writing
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Create chunk metadata
        const chunkMetadata = {
          id: `${filePath}:${i}`,
          filePath,
          content: chunk.content,
          chunkIndex: i,
          totalChunks: chunks.length,
          fileType: this.getFileType(filePath),
          contentHash: hash,
          lastModified: new Date(),
          lineStart: chunk.startLine,
          lineEnd: chunk.endLine,
        };

        // Queue chunk to buffer (embedding will be generated during flush)
        // Check buffer size limit to prevent OOM
if (this.pendingChunks.length >= this.config.flushThreshold) {
          logger.debug(`Buffer full (${this.config.flushThreshold}), forcing flush before adding more chunks`);
          await this.flushPendingChunks();
        }

        // Check buffer bytes limit to prevent OOM
        const chunkSize = Buffer.byteLength(JSON.stringify(chunkMetadata), 'utf8');
        if (this.currentBufferBytes + chunkSize > this.config.maxBufferBytes) {
          logger.debug(`Buffer bytes limit reached (${this.currentBufferBytes + chunkSize} > ${this.config.maxBufferBytes}), forcing flush before adding more chunks`);
          await this.flushPendingChunks();
        }

        this.pendingChunks.push({
          text: chunk.content,
          sourceType: 'project',
          sourcePath: filePath,
          metadataJson: JSON.stringify(chunkMetadata),
        });
        
        // Track buffer bytes
        this.currentBufferBytes += chunkSize;
      }

      // Schedule a flush if needed
      this.scheduleFlush();

      // Update tracking
      this.fileTracker.setFile(filePath, hash, chunks.length);

      logger.info(`Queued for indexing: ${filePath} (${chunks.length} chunks)`);
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : { raw: String(error), type: typeof error };
      logger.error(`Failed to process file: ${filePath}`, errorDetails);
      this.emit('error', error);
    }
  }

  /**
   * Remove a file from the index
   */
  async removeFile(filePath: string): Promise<void> {
    try {
      await this.deleteChunksForFile(filePath);
      this.fileTracker.removeFile(filePath);
      logger.info(`Removed from index: ${filePath}`);
    } catch (error) {
      const errorDetails = error instanceof Error
        ? { message: error.message, stack: error.stack, name: error.name }
        : { raw: String(error), type: typeof error };
      logger.error(`Failed to remove file: ${filePath}`, errorDetails);
    }
  }

  /**
   * Search project chunks
   */
  async search(query: string, options: ProjectSearchOptions = {}): Promise<ProjectSearchResult[]> {
    const topK = options.topK || 10;
    
    // Generate query embedding
    const embeddingResults = await generateEmbeddings([query]);
    const queryVector = new Float32Array(embeddingResults[0].embedding);

    // Search database
    const entries = await this.db.queryMemories(queryVector, { topK });

    // Filter and transform results
    const searchResults: ProjectSearchResult[] = [];
    const seenPaths = new Set<string>();

    for (const entry of entries) {
      if (entry.sourceType !== 'project') continue;
      
      // Apply filters
      if (options.fileTypes?.length) {
        const fileType = this.getFileType(entry.sourcePath || '');
        if (!options.fileTypes.includes(fileType)) continue;
      }

      if (options.filters?.paths?.length) {
        const matchesPath = options.filters.paths.some(p => 
          entry.sourcePath?.startsWith(p)
        );
        if (!matchesPath) continue;
      }

      // Deduplicate by file path
      if (entry.sourcePath && seenPaths.has(entry.sourcePath)) continue;
      if (entry.sourcePath) seenPaths.add(entry.sourcePath);

      // Parse chunk metadata
      let chunkMeta: Partial<ProjectChunk> = {};
      if (entry.metadataJson) {
        try {
          chunkMeta = JSON.parse(entry.metadataJson);
        } catch {
          // Ignore parse errors
        }
      }

      searchResults.push({
        chunk: {
          id: entry.id,
          filePath: entry.sourcePath || '',
          content: entry.text,
          vector: entry.vector,
          chunkIndex: chunkMeta.chunkIndex || 0,
          totalChunks: chunkMeta.totalChunks || 1,
          fileType: chunkMeta.fileType || this.getFileType(entry.sourcePath || ''),
          contentHash: entry.contentHash,
          lastModified: entry.timestamp,
          lineStart: chunkMeta.lineStart || 0,
          lineEnd: chunkMeta.lineEnd || 0,
        },
        score: entry.score ?? 0,
        filePath: entry.sourcePath || '',
        lineStart: chunkMeta.lineStart || 0,
        lineEnd: chunkMeta.lineEnd || 0,
      });

      if (searchResults.length >= topK) break;
    }

    return searchResults;
  }

  /**
   * Schedule a flush of pending chunks to the database.
   * Uses a timer to batch writes and avoid overwhelming LanceDB.
   */
  private scheduleFlush(): void {
    // If buffer exceeds threshold, flush immediately
    if (this.pendingChunks.length >= this.config.flushThreshold) {
      this.flushPendingChunks().catch(err => {
        logger.error('Flush failed', { error: err.message });
      });
      return;
    }

    // Otherwise, schedule a deferred flush
    if (this.flushTimer) return; // Already scheduled

    this.flushTimer = setTimeout(() => {
      this.flushPendingChunks().catch(err => {
        logger.error('Flush failed', { error: err.message });
      });
    }, this.config.flushIntervalMs);
  }

  /**
   * Flush all pending chunks to the database using batch insert.
   */
  private async flushPendingChunks(): Promise<void> {
    // Yield to event loop if paused
    await this.pauseController.shouldYield();
    
    if (this.pendingChunks.length === 0) {
      this.flushTimer = null;
      return;
    }

    // Take all pending chunks
    const chunks = this.pendingChunks.splice(0);
    const byteCount = this.currentBufferBytes;
    this.currentBufferBytes = 0;
    this.flushTimer = null;

    logger.debug(`Flushing ${chunks.length} chunks (${byteCount} bytes) to database`);

    try {
      await this.db.addMemories(chunks);
      logger.debug(`Successfully flushed ${chunks.length} chunks`);
    } catch (error) {
      // Put chunks back in queue to retry
      logger.error(`Batch insert failed, re-queuing ${chunks.length} chunks`, {
        error: error instanceof Error ? error.message : String(error)
      });
      this.pendingChunks.unshift(...chunks);
      // Re-calculate bytes for re-queued chunks
      for (const chunk of chunks) {
        this.currentBufferBytes += JSON.stringify(chunk).length;
      }
      // Schedule another flush attempt
      this.scheduleFlush();
    }
  }

  /**
   * Force flush pending chunks (call before shutdown)
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingChunks.length > 0) {
      await this.flushPendingChunks();
    }
  }

  /**
   * Compute SHA-256 hash of content
   */
  private computeHash(content: string): string {
    return createHash('sha256').update(content, 'utf8').digest('hex');
  }

  /**
   * Delete all chunks for a file from the database
   */
  private async deleteChunksForFile(filePath: string): Promise<void> {
    // Use the efficient batch delete method
    await this.db.deleteBySourcePath(filePath, 'project');
  }

  /**
   * Get file type from path
   */
  private getFileType(filePath: string): string {
    const lastDot = filePath.lastIndexOf('.');
    if (lastDot === -1) return '';
    return filePath.slice(lastDot + 1).toLowerCase();
  }

  /**
   * Get indexer statistics
   */
  getStats(): ProjectIndexerStats {
    const allFiles = this.fileTracker.getAllFiles();
    return {
      totalFiles: allFiles.size,
      totalChunks: Array.from(allFiles.values()).reduce(
        (sum, f) => sum + f.chunkCount, 0
      ),
      indexedFiles: allFiles.size,
      failedFiles: 0, // Would need to track this
      lastIndexing: new Date(),
    };
  }

  /**
   * Check if indexer is running
   */
  isIndexerRunning(): boolean {
    return this.isRunning;
  }

  /**
   * Pause indexing operations
   */
  pause(): void {
    this.pauseController.pause();
  }

  /**
   * Resume indexing operations
   */
  resume(): void {
    this.pauseController.resume();
  }

  /**
   * Yield to event loop to allow other operations to run
   */
  private async yieldToEventLoop(): Promise<void> {
    if (this.config.yieldMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.config.yieldMs));
    }
  }

  /**
   * Start periodic scan for incremental updates
   */
  private startPeriodicScan(): void {
    const interval = this.config.periodicScanIntervalMs;
    
    if (interval <= 0) {
      logger.debug('Periodic scan disabled');
      return;
    }

    logger.debug(`Starting periodic scan every ${interval}ms`);
    
    this.periodicScanTimer = setInterval(async () => {
      if (!this.isRunning) return;
      
      logger.debug('Running periodic scan...');
      
      try {
        // Yield to pause controller
        await this.pauseController.shouldYield();
        
        if (this.snapshotIndex) {
          const delta = await this.snapshotIndex.scan();
          
          // Process new and changed files
          for (const relPath of [...delta.new, ...delta.changed]) {
            await this.pauseController.shouldYield();
            const fullPath = resolve(this.config.rootPath, relPath);
            const precomputedHash = this.snapshotIndex.getFileHash(relPath);
            await this.processFile(fullPath, precomputedHash);
            await this.yieldToEventLoop();
          }
          
          // Handle deleted files
          for (const relPath of delta.deleted) {
            await this.pauseController.shouldYield();
            const fullPath = resolve(this.config.rootPath, relPath);
            await this.removeFile(fullPath);
            this.snapshotIndex.markDeleted(relPath);
          }
          
          // Save updated snapshot
          await this.snapshotIndex.save();
        }
      } catch (error) {
        logger.error('Periodic scan failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, interval);
  }

  /**
   * Clear the index - removes all indexed files from tracking
   */
  clearIndex(): void {
    // Clear in-memory map by removing all files from tracker
    const allFiles = this.fileTracker.getAllFiles();
    for (const filePath of allFiles.keys()) {
      this.fileTracker.removeFile(filePath);
    }
    logger.info('Index cleared');
  }

  /**
   * Force re-start the indexer (e.g., after clearing index)
   */
  async restart(): Promise<void> {
    await this.stop();
    // Clear tracker
    const allFiles = this.fileTracker.getAllFiles();
    for (const filePath of allFiles.keys()) {
      this.fileTracker.removeFile(filePath);
    }
    await this.start();
  }
}

/**
 * Create a new project indexer
 */
export function createIndexer(config: ProjectIndexConfig, db?: MemoryDatabase, dbUri?: string): ProjectIndexer {
  return new ProjectIndexer(config, db, dbUri);
}