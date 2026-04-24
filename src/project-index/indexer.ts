/**
 * Project file indexer
 * 
 * Handles file indexing with:
 * - Incremental updates using SHA-256 hash comparison
 * - Background indexing on startup
 * - Support for multiple file types
 * - HNSW index for fast search
 */

import { readFile, stat } from 'fs/promises';
import { createHash } from 'crypto';
import { EventEmitter } from 'events';
import { logger } from '../utils/logger.js';
import { ProjectWatcher, createWatcher } from './watcher.js';
import { FileChunker, createChunker } from './chunker.js';
import { generateEmbeddings } from '../model/embeddings.js';
import { MemoryDatabase } from '../memory/database.js';
import type {
  ProjectIndexConfig,
  ProjectChunk,
  FileEvent,
  ProjectSearchOptions,
  ProjectSearchResult,
  ProjectIndexerStats,
} from './types.js';

// Default configuration
const DEFAULT_CONFIG: Required<ProjectIndexConfig> = {
  rootPath: '.',
  includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
  excludePatterns: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/*.log',
    '**/.cache/**',
  ],
  maxFileSize: 1024 * 1024, // 1MB
  chunkSize: 512,
  chunkOverlap: 50,
};

/**
 * ProjectIndexer - indexes project files for semantic search
 */
export class ProjectIndexer extends EventEmitter {
  private config: Required<ProjectIndexConfig>;
  private watcher: ProjectWatcher | null = null;
  private chunker: FileChunker;
  private db: MemoryDatabase;
  private indexedFiles: Map<string, { hash: string; lastModified: Date; chunkCount: number }> = new Map();
  private isRunning: boolean = false;
  private processingPromises: Map<string, Promise<void>> = new Map();
  private pendingEventCount: number = 0;
  private processingCompleteResolve: (() => void) | null = null;
  private processingCompletePromise: Promise<void> | null = null;

  constructor(config: ProjectIndexConfig, db?: MemoryDatabase) {
    super();
    
    // Merge config with defaults
    this.config = {
      rootPath: config.rootPath || DEFAULT_CONFIG.rootPath,
      includePatterns: config.includePatterns?.length 
        ? config.includePatterns 
        : DEFAULT_CONFIG.includePatterns,
      excludePatterns: [
        ...DEFAULT_CONFIG.excludePatterns,
        ...(config.excludePatterns || []),
      ],
      maxFileSize: config.maxFileSize || DEFAULT_CONFIG.maxFileSize,
      chunkSize: config.chunkSize || DEFAULT_CONFIG.chunkSize,
      chunkOverlap: config.chunkOverlap || DEFAULT_CONFIG.chunkOverlap,
    };
    
    // Use provided database or create new instance (not singleton)
    this.db = db || new MemoryDatabase();
    this.chunker = createChunker({
      maxChunkSize: this.config.chunkSize,
      overlap: this.config.chunkOverlap,
      minChunkSize: 50,
      splitBy: 'semantic',
    });
  }

  /**
   * Start the indexer - begin watching and initial indexing
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Indexer already running');
      return;
    }

    logger.info('Starting project indexer');
    this.isRunning = true;

    // Ensure database is initialized
    if (!this.db) {
      this.db = new MemoryDatabase();
    }
    await this.db.initialize().catch(err => {
      logger.error('Failed to initialize database', { error: err.message });
    });

    // Create and start the watcher
    this.watcher = createWatcher({
      paths: [this.config.rootPath],
      includePatterns: this.config.includePatterns,
      excludePatterns: this.config.excludePatterns,
      debounceMs: 500,
      ignoreHidden: true,
    });

    // Handle file events
    this.watcher!.on('file', (event: FileEvent) => {
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
      logger.info(`Final stats before emit: indexedFiles=${this.indexedFiles.size}, totalChunks=${Array.from(this.indexedFiles.values()).reduce((sum, f) => sum + f.chunkCount, 0)}`);
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
    
    logger.debug(`start() returning. indexedFiles=${this.indexedFiles.size}`);
  }

  /**
   * Stop the indexer
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    logger.info('Stopping project indexer');

    // Wait for any pending processing to complete
    await this.waitForProcessingComplete();

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
  async processFile(filePath: string): Promise<void> {
    logger.debug(`processFile called: ${filePath}`);
    try {
      // Check file size
      const stats = await stat(filePath);
      if (stats.size > this.config.maxFileSize) {
        logger.warn(`File too large, skipping: ${filePath} (${stats.size} bytes)`);
        return;
      }

      // Read file content
      const content = await readFile(filePath, 'utf-8');
      logger.debug(`Read file ${filePath}: ${content.length} chars`);
      
      // Compute hash
      const hash = this.computeHash(content);
      
      // Check if file has changed
      const existing = this.indexedFiles.get(filePath);
      if (existing?.hash === hash) {
        logger.debug(`File unchanged, skipping: ${filePath}`);
        return;
      }

      // Delete old chunks for this file
      await this.deleteChunksForFile(filePath);

      // Chunk the file
      const chunks = this.chunker.chunkFile(content, filePath);
      logger.debug(`Chunked ${filePath} into ${chunks.length} chunks`);

      // Process each chunk
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        
        // Generate embedding for the chunk
        const results = await generateEmbeddings([chunk.content]);
        const embedding = results[0].embedding;
        
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

        // Store in database (as a memory entry with project metadata)
        await this.db.addMemory({
          text: chunk.content,
          vector: new Float32Array(embedding),
          sourceType: 'project',
          sourcePath: filePath,
          metadataJson: JSON.stringify(chunkMetadata),
        });
      }

      // Update tracking
      this.indexedFiles.set(filePath, {
        hash,
        lastModified: new Date(),
        chunkCount: chunks.length,
      });

      logger.info(`Indexed: ${filePath} (${chunks.length} chunks)`);
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
      this.indexedFiles.delete(filePath);
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
        score: (entry as any)._similarity || 0,
        filePath: entry.sourcePath || '',
        lineStart: chunkMeta.lineStart || 0,
        lineEnd: chunkMeta.lineEnd || 0,
      });

      if (searchResults.length >= topK) break;
    }

    return searchResults;
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
    // Query for entries with this source path
    const entries = await this.db.listMemories({ sourceType: 'project' });
    
    for (const entry of entries) {
      if (entry.sourcePath === filePath) {
        await this.db.deleteMemory(entry.id);
      }
    }
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
    return {
      totalFiles: this.indexedFiles.size,
      totalChunks: Array.from(this.indexedFiles.values()).reduce(
        (sum, f) => sum + f.chunkCount, 0
      ),
      indexedFiles: this.indexedFiles.size,
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
   * Clear the index - removes all indexed files from tracking
   */
  clearIndex(): void {
    this.indexedFiles.clear();
    logger.info('Index cleared');
  }

  /**
   * Force re-start the indexer (e.g., after clearing index)
   */
  async restart(): Promise<void> {
    await this.stop();
    this.indexedFiles.clear();
    await this.start();
  }
}

/**
 * Create a new project indexer
 */
export function createIndexer(config: ProjectIndexConfig, db?: MemoryDatabase): ProjectIndexer {
  return new ProjectIndexer(config, db);
}