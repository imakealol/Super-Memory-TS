/**
 * MCP Server implementation for Super-Memory
 *
 * Provides MCP tools for:
 * - query_memories: Search memories using semantic similarity
 * - add_memory: Store a new memory entry
 * - search_project: Search indexed project files
 * - index_project: Manually trigger project indexing
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { loadConfigSync, validateConfig, type Config } from './config.js';
import { ModelManager } from './model/index.js';
import { MemorySystem, getMemorySystem } from './memory/index.js';
import { ProjectIndexer } from './project-index/indexer.js';
import { logger } from './utils/logger.js';
import type { SearchOptions, SearchStrategy, MemorySourceType } from './memory/schema.js';

// ==================== Job Tracking ====================

interface JobProgress {
  totalFiles: number;
  indexedFiles: number;
  failedFiles: number;
  totalChunks: number;
}

interface JobState {
  status: 'running' | 'completed' | 'failed';
  progress: JobProgress;
  error?: string;
  startedAt: Date;
  completedAt?: Date;
}

/**
 * In-memory job tracking for background indexing tasks.
 * Jobs are automatically cleaned up after 1 hour of completion.
 */
class JobTracker {
  private jobs: Map<string, JobState> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

  constructor() {
    this.startCleanupTimer();
  }

  /**
   * Create a new job and return its ID
   */
  createJob(): string {
    const jobId = randomUUID();
    this.jobs.set(jobId, {
      status: 'running',
      progress: {
        totalFiles: 0,
        indexedFiles: 0,
        failedFiles: 0,
        totalChunks: 0,
      },
      startedAt: new Date(),
    });
    return jobId;
  }

  /**
   * Update job progress
   */
  updateProgress(jobId: string, progress: Partial<JobProgress>): void {
    const job = this.jobs.get(jobId);
    if (job && job.status === 'running') {
      Object.assign(job.progress, progress);
    }
  }

  /**
   * Mark job as completed
   */
  completeJob(jobId: string, finalProgress: JobProgress): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'completed';
      job.progress = finalProgress;
      job.completedAt = new Date();
    }
  }

  /**
   * Mark job as failed
   */
  failJob(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.completedAt = new Date();
    }
  }

  /**
   * Get job status
   */
  getJob(jobId: string): JobState | undefined {
    return this.jobs.get(jobId);
  }

  /**
   * Start periodic cleanup of old jobs
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [jobId, job] of this.jobs.entries()) {
        if (job.completedAt && (now - job.completedAt.getTime()) > this.JOB_TTL_MS) {
          this.jobs.delete(jobId);
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  /**
   * Stop cleanup timer (for shutdown)
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}

// Global job tracker instance
const jobTracker = new JobTracker();

// ==================== Helper Functions ====================

/**
 * Wraps a promise with an operation-level timeout.
 * If the operation exceeds the timeout, it will be rejected with a timeout error.
 */
function withTimeout<T>(operation: Promise<T>, timeoutMs: number, operationName: string): Promise<T> {
  return Promise.race([
    operation,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${operationName} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Map user-friendly source type to internal type
 */
function mapSourceType(input: string): MemorySourceType {
  const mapping: Record<string, MemorySourceType> = {
    manual: 'session',
    file: 'file',
    conversation: 'session',
    web: 'web',
  };
  return mapping[input] || 'session';
}

// ==================== SuperMemoryServer ====================

export class SuperMemoryServer {
  private server: McpServer;
  private context: {
    memory: MemorySystem;
    indexer: ProjectIndexer | null;
  };
  private config: Config;
  private initialized: boolean = false;
  private initError: Error | null = null;

  constructor(config?: Config) {
    this.config = config || loadConfigSync();
    this.validateConfig();

    // Resolve projectId from config
    const projectId = this.config.database.projectId;

    this.context = {
      memory: getMemorySystem({ 
        dbUri: this.config.database.qdrantUrl || this.config.database.dbPath,
        projectId,
      }),
      indexer: null,
    };

    // Create MCP server
    this.server = new McpServer({
      name: 'super-memory',
      version: '2.1.0',
    });

    this.registerTools();
    this.setupShutdownHandlers();
  }

  /**
   * Validate configuration and log warnings
   */
  private validateConfig(): void {
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      logger.warn('Configuration warnings:', validation.errors);
    }
  }

  /**
   * Set up graceful shutdown handlers
   */
  private setupShutdownHandlers(): void {
    const shutdown = async () => {
      await this.shutdown();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /**
   * Check if server is initialized and ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Get initialization error if any
   */
  getInitError(): Error | null {
    return this.initError;
  }

  /**
   * Map source type to internal format
   */
  private mapSourceType(input: string): MemorySourceType {
    return mapSourceType(input);
  }

  /**
   * Format a memory entry for JSON output
   */
  private formatMemoryEntry(entry: { id: string; text: string; sourceType: string; sourcePath?: string; timestamp: Date }): object {
    return {
      id: entry.id,
      content: entry.text,
      sourceType: entry.sourceType,
      sourcePath: entry.sourcePath,
      timestamp: entry.timestamp,
    };
  }

  /**
   * Spawn background indexing task for a job
   */
  private spawnBackgroundIndexing(jobId: string): void {
    const indexer = this.context.indexer;
    if (!indexer) {
      jobTracker.failJob(jobId, 'Project indexer not initialized');
      return;
    }

    // Start indexing without waiting
    indexer.start().then(async () => {
      try {
        // Set up progress tracking via polling
        const pollInterval = setInterval(() => {
          const job = jobTracker.getJob(jobId);
          if (!job || job.status !== 'running') {
            clearInterval(pollInterval);
            return;
          }

          const stats = indexer.getStats();
          jobTracker.updateProgress(jobId, {
            totalFiles: stats.totalFiles,
            indexedFiles: stats.indexedFiles,
            failedFiles: stats.failedFiles,
            totalChunks: stats.totalChunks,
          });
        }, 1000); // Poll every second

        // Wait for initial indexing to complete
        await new Promise<void>((resolve) => {
          indexer.once('stats', () => resolve());
          // Safety timeout - if no stats event within 15 minutes, complete anyway
          setTimeout(resolve, 15 * 60 * 1000);
        });

        clearInterval(pollInterval);

        // Final stats update
        const finalStats = indexer.getStats();
        jobTracker.completeJob(jobId, {
          totalFiles: finalStats.totalFiles,
          indexedFiles: finalStats.indexedFiles,
          failedFiles: finalStats.failedFiles,
          totalChunks: finalStats.totalChunks,
        });
      } catch (error) {
        jobTracker.failJob(jobId, error instanceof Error ? error.message : 'Unknown error');
      }
    }).catch((error) => {
      jobTracker.failJob(jobId, error instanceof Error ? error.message : 'Unknown error');
    });
  }

  /**
   * Register all MCP tools with Zod schemas
   */
  private registerTools(): void {
    // query_memories tool
    this.server.registerTool(
      'query_memories',
      {
        description: 'Query memories using semantic similarity. Returns memories most relevant to the query.',
        inputSchema: {
          query: z.string().min(1).describe('The search query to find relevant memories'),
          limit: z.number().int().min(1).max(100).default(10).describe('Maximum number of results'),
          strategy: z.enum(['tiered', 'vector_only', 'text_only']).default('tiered').describe('Search strategy'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, limit, strategy }: { query: string; limit: number; strategy: 'tiered' | 'vector_only' | 'text_only' }) => {
        // Ensure memory is ready before operation
        this.ensureMemoryReady();

        // Convert strategy to internal format
        const strategyMap: Record<string, SearchStrategy> = {
          'tiered': 'TIERED',
          'vector_only': 'VECTOR_ONLY',
          'text_only': 'TEXT_ONLY',
        };
        const internalStrategy = strategyMap[strategy] || 'TIERED';

        const searchOpts: SearchOptions = {
          topK: limit,
          strategy: internalStrategy,
        };

        // Wrap query operation with 30s timeout to prevent hanging
        const results = await withTimeout(
          this.context.memory.queryMemories(query, searchOpts),
          30000,
          'query_memories'
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              count: results.length,
              memories: results.map((r) => this.formatMemoryEntry(r)),
              strategy_used: internalStrategy,
            }),
          }],
        };
      }
    );

    // add_memory tool
    this.server.registerTool(
      'add_memory',
      {
        description: 'Add a new memory entry to the memory store.',
        inputSchema: {
          content: z.string().min(1).describe('The content to store in memory'),
          sourceType: z.enum(['manual', 'file', 'conversation', 'web']).default('manual'),
          sourcePath: z.string().optional().describe('Optional source path or URL'),
          metadata: z.record(z.string(), z.unknown()).optional().describe('Optional metadata'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ content, sourceType, sourcePath, metadata }: { content: string; sourceType: 'manual' | 'file' | 'conversation' | 'web'; sourcePath?: string; metadata?: Record<string, unknown> }) => {
        // Ensure memory is ready before operation
        this.ensureMemoryReady();

        try {
          // Check for duplicate content
          const exists = await this.context.memory.contentExists(content);
          if (exists) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  message: 'Memory with identical content already exists',
                  duplicate: true,
                }),
              }],
            };
          }

          const internalSourceType = this.mapSourceType(sourceType);

          const input = {
            text: content,
            sourceType: internalSourceType,
            sourcePath: sourcePath || '',
            metadataJson: metadata ? JSON.stringify(metadata) : undefined,
          };

          console.error('[add_memory handler] Calling addMemory with input:', JSON.stringify({ text: input.text, sourceType: input.sourceType, sourcePath: input.sourcePath }));
          // Wrap addMemory with 30s timeout to prevent hanging
          const id = await withTimeout(
            this.context.memory.addMemory(input),
            30000,
            'add_memory'
          );
          console.error('[add_memory handler] addMemory returned id:', id);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                id,
                message: 'Memory added successfully',
              }),
            }],
          };
        } catch (err) {
          console.error('[add_memory handler] ERROR:', err);
          console.error('[add_memory handler] Stack:', err instanceof Error ? err.stack : 'unknown');
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                message: `Error adding memory: ${err instanceof Error ? err.message : 'Unknown error'}`,
              }),
            }],
            isError: true,
          };
        }
      }
    );

    // search_project tool
    this.server.registerTool(
      'search_project',
      {
        description: 'Search the indexed project files for relevant code or content.',
        inputSchema: {
          query: z.string().min(1).describe('The search query'),
          topK: z.number().int().min(1).max(100).default(20),
          fileTypes: z.array(z.string()).optional().describe('File type filters'),
          paths: z.array(z.string()).optional().describe('Path filters'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ query, topK, fileTypes, paths }: { query: string; topK: number; fileTypes?: string[]; paths?: string[] }) => {
        if (!this.context.indexer) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Project indexer not initialized',
              }),
            }],
            isError: true,
          };
        }

        // Pause indexing during search
        if (this.context.indexer.isIndexerRunning()) {
          this.context.indexer.pause();
        }

        try {
          const results = await this.context.indexer.search(query, {
            topK,
            filters: {
              fileTypes,
              paths,
            },
          });

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                count: results.length,
                chunks: results.map((r) => ({
                  filePath: r.filePath,
                  content: r.chunk.content,
                  lineStart: r.lineStart,
                  lineEnd: r.lineEnd,
                  score: r.score,
                })),
              }),
            }],
          };
        } finally {
          if (this.context.indexer.isIndexerRunning()) {
            this.context.indexer.resume();
          }
        }
      }
    );

      // index_project tool
    this.server.registerTool(
      'index_project',
      {
        description: 'Trigger project indexing. Scans and indexes all supported files in the project. Use background=true for large directories to avoid MCP timeouts.',
        inputSchema: {
          path: z.string().optional().describe('Directory to index'),
          force: z.boolean().default(false).describe('Force re-indexing'),
          background: z.boolean().default(true).describe('Run indexing in background (recommended for large projects)'),
        },
        annotations: { destructiveHint: true },
      },
      async ({ path, force, background }: { path?: string; force: boolean; background: boolean }) => {
        // Handle path parameter - reconfigure or create indexer with specified path
        if (path) {
          if (this.context.indexer) {
            // Reconfigure existing indexer to use the new path
            await this.context.indexer.setRootPath(path);
          } else {
            // Create new indexer with specified path
            const projectId = this.config.database.projectId;
            this.context.indexer = new ProjectIndexer({
              rootPath: path,
              includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
              excludePatterns: this.config.indexer?.excludePatterns || ['node_modules', '.git', 'dist'],
              chunkSize: this.config.indexer?.chunkSize || 512,
              chunkOverlap: this.config.indexer?.chunkOverlap || 50,
              maxFileSize: this.config.indexer?.maxFileSize || 10 * 1024 * 1024,
            }, undefined, this.config.database.qdrantUrl, projectId);
          }
        } else if (!this.context.indexer) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Project indexer not initialized',
              }),
            }],
            isError: true,
          };
        }

        if (force) {
          this.context.indexer.clearIndex();
        }

        const indexPath = this.context.indexer.getRootPath();
        logger.info(`Indexing project: ${indexPath} (force: ${force}, background: ${background})`);

        // Background mode: spawn indexing asynchronously
        if (background) {
          const jobId = jobTracker.createJob();

          // Spawn background indexing
          this.spawnBackgroundIndexing(jobId);

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                jobId,
                status: 'started',
                message: 'Indexing started in background. Use index_project_status to check progress.',
              }),
            }],
          };
        }

        // Synchronous mode (backward compatible)
        try {
          await this.context.indexer.start();

          // Small delay to allow initial files to be processed
          await new Promise(resolve => setTimeout(resolve, 500));

          const stats = this.context.indexer.getStats();

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                message: 'Indexing completed',
                stats: {
                  totalFiles: stats.totalFiles,
                  indexedFiles: stats.indexedFiles,
                  failedFiles: stats.failedFiles,
                  totalChunks: stats.totalChunks,
                  lastIndexing: stats.lastIndexing,
                },
              }),
            }],
          };
        } catch (error) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: `Failed to index project: ${error instanceof Error ? error.message : 'Unknown error'}`,
              }),
            }],
            isError: true,
          };
        }
      }
    );

    // index_project_status tool
    this.server.registerTool(
      'index_project_status',
      {
        description: 'Check the status of a background indexing job. Use the jobId returned from index_project with background=true.',
        inputSchema: {
          jobId: z.string().describe('The job ID returned from index_project'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ jobId }: { jobId: string }) => {
        const job = jobTracker.getJob(jobId);

        if (!job) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                error: 'Job not found. The job may have expired or never existed.',
              }),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: job.status,
              progress: {
                totalFiles: job.progress.totalFiles,
                indexedFiles: job.progress.indexedFiles,
                failedFiles: job.progress.failedFiles,
                totalChunks: job.progress.totalChunks,
              },
              error: job.error,
              startedAt: job.startedAt,
              completedAt: job.completedAt,
            }),
          }],
        };
      }
    );

    // get_file_contents tool
    this.server.registerTool(
      'get_file_contents',
      {
        description: 'Reconstruct file contents from indexed chunks. Returns the full file content by concatenating all chunks in order.',
        inputSchema: {
          filePath: z.string().min(1).describe('The path to the file to reconstruct'),
          triggerIndex: z.boolean().default(false).describe('If true and file not found in index, trigger indexing'),
        },
        annotations: { readOnlyHint: true },
      },
      async ({ filePath, triggerIndex }: { filePath: string; triggerIndex: boolean }) => {
        if (!this.context.indexer) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Project indexer not initialized',
              }),
            }],
            isError: true,
          };
        }

        // Pause indexing during read
        if (this.context.indexer.isIndexerRunning()) {
          this.context.indexer.pause();
        }

        try {
          const result = await this.context.indexer.getFileContents(filePath);

          if (!result) {
            // File not indexed - optionally trigger indexing
            if (triggerIndex) {
              // Trigger background indexing
              const jobId = jobTracker.createJob();
              this.spawnBackgroundIndexing(jobId);

              return {
                content: [{
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    filePath,
                    message: 'File not found in index. Indexing triggered.',
                    jobId,
                    status: 'started',
                  }),
                }],
              };
            }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  filePath,
                  error: 'File not found in index',
                  message: 'Use triggerIndex=true to index this file',
                }),
              }],
            };
          }

          // Check content size - truncate if exceeds 100KB
          const MAX_CONTENT_SIZE = 100 * 1024; // 100KB
          const contentSize = Buffer.byteLength(result.content, 'utf8');
          const truncated = contentSize > MAX_CONTENT_SIZE;

          let content = result.content;
          if (truncated) {
            content = result.content.slice(0, MAX_CONTENT_SIZE);
          }

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                filePath,
                content,
                chunks: result.chunks.map(c => ({
                  chunkIndex: c.chunkIndex,
                  lineStart: c.lineStart,
                  lineEnd: c.lineEnd,
                })),
                lineCount: result.lineCount,
                indexedAt: result.indexedAt,
                truncated,
              }),
            }],
          };
        } finally {
          if (this.context.indexer.isIndexerRunning()) {
            this.context.indexer.resume();
          }
        }
      }
    );

    // get_status tool - returns current server status
    this.server.registerTool(
      'get_status',
      {
        description: 'Get the current status of the Super-Memory server including memory, model, and indexer state.',
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      async () => {
        const memoryReady = this.context.memory.isReady();
        let modelReady = false;
        const indexerReady = this.context.indexer !== null;
        try {
          const modelManager = ModelManager.getInstance();
          modelReady = modelManager.getMetadata().isLoaded;
        } catch {
          // Model manager not available
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              memoryReady,
              modelReady,
              indexerReady,
              initError: this.initError?.message ?? null,
            }),
          }],
        };
      }
    );
  }

  /**
   * Initialize the server and connect to transport
   * Implements graceful degradation - server starts even if memory Qdrant is unavailable
   */
  async start(): Promise<void> {
    if (this.initialized) {
      logger.warn('Server already initialized');
      return;
    }

    // Create MCP transport early so we can connect even if memory init fails
    const transport = new StdioServerTransport();

    // Transport error/close handlers are not supported by StdioServerTransport
    // The transport manages its own lifecycle internally

    try {
      // Connect MCP transport BEFORE memory initialization
      // This allows the server to accept connections even if Qdrant is unavailable
      await this.server.connect(transport);
      logger.info('MCP transport connected');

      // Initialize memory system with retry loop and exponential backoff
      await this.initializeMemoryWithRetry();

      // Initialize model: lazy by default, eager only if SUPER_MEMORY_EAGER_LOAD is set
      const eagerLoad = process.env.SUPER_MEMORY_EAGER_LOAD === '1' || 
                        process.env.SUPER_MEMORY_EAGER_LOAD === 'true';

      if (eagerLoad) {
        try {
          const modelManager = ModelManager.getInstance();
          logger.info('Preloading embedding model (SUPER_MEMORY_EAGER_LOAD is set)...');
          const preloadStart = Date.now();
          await modelManager.acquire();
          logger.info(`Model preloaded successfully (${Date.now() - preloadStart}ms)`);
        } catch (modelError) {
          logger.warn('Model preload failed - will retry on first embedding request', { 
            error: modelError instanceof Error ? modelError.message : String(modelError) 
          });
        }
      } else {
        logger.info('Model loading deferred to first embedding request (set SUPER_MEMORY_EAGER_LOAD=1 to preload at startup)');
      }

      // Initialize project indexer (non-critical)
      try {
        if (this.config.indexer && this.config.indexer.chunkSize) {
          // Resolve projectId from config (same as used for MemorySystem)
          const projectId = this.config.database.projectId;

          this.context.indexer = new ProjectIndexer({
            rootPath: process.env.BOOMERANG_ROOT_PATH || process.cwd(),
            includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
            excludePatterns: this.config.indexer.excludePatterns || ['node_modules', '.git', 'dist'],
            chunkSize: this.config.indexer.chunkSize || 512,
            chunkOverlap: this.config.indexer.chunkOverlap || 50,
            maxFileSize: this.config.indexer.maxFileSize || 10 * 1024 * 1024,
          }, undefined, this.config.database.qdrantUrl, projectId);

          logger.info('Project indexer initialized');
        }
      } catch (indexerError) {
        logger.warn('Project indexer initialization failed - search_project tool may not work', { error: indexerError instanceof Error ? indexerError.message : String(indexerError) });
      }

      this.initialized = true;
      logger.info('Super-Memory MCP Server started successfully');
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to initialize server', { error: this.initError.message });
      // Don't throw - server is running in degraded mode
      this.initialized = true;
    }
  }

  /**
   * Initialize memory system with retry loop and exponential backoff
   */
  private async initializeMemoryWithRetry(): Promise<void> {
    const maxRetries = this.config.performance.qdrantMaxRetries ?? 3;
    const baseDelayMs = this.config.performance.qdrantRetryDelayMs ?? 1000;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.context.memory.initialize(this.config.database.qdrantUrl || this.config.database.dbPath);
        logger.info('Memory system initialized');
        return;
      } catch (memError) {
        lastError = memError instanceof Error ? memError : new Error(String(memError));
        logger.error(`Memory system initialization attempt ${attempt + 1}/${maxRetries + 1} failed`, { error: lastError.message });

        if (attempt < maxRetries) {
          // Exponential backoff: 1s, 2s, 4s, etc.
          const delayMs = baseDelayMs * Math.pow(2, attempt);
          logger.info(`Retrying memory initialization in ${delayMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }

    // All retries exhausted - store error but don't throw
    this.initError = lastError;
    logger.error('Memory system initialization failed after all retries', { error: lastError?.message });
  }

  /**
   * Ensure memory is ready before operations, throws structured MCP error if not
   */
  private ensureMemoryReady(): void {
    if (!this.context.memory.isReady()) {
      const error = new Error('Memory system not ready. Qdrant may be unavailable.');
      (error as Error & { code?: string; initError?: string }).code = 'MEMORY_NOT_READY';
      (error as Error & { code?: string; initError?: string }).initError = this.initError?.message;
      throw error;
    }
  }

  /**
   * Gracefully shut down the server
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down Super-Memory server...');

    try {
      // Release model
      const modelManager = ModelManager.getInstance();
      modelManager.release();

      // Stop indexer
      if (this.context.indexer) {
        await this.context.indexer.stop();
      }

      // Stop job tracker
      jobTracker.stop();

      // Close server
      await this.server.close();
      logger.info('Server shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}