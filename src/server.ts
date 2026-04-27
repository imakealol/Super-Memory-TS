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
          // Safety timeout - if no stats event within 5 minutes, complete anyway
          setTimeout(resolve, 5 * 60 * 1000);
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

        const results = await this.context.memory.queryMemories(query, searchOpts);

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
          const id = await this.context.memory.addMemory(input);
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
  }

  /**
   * Initialize the server and connect to transport
   * Implements graceful degradation - server starts even if some components fail
   */
  async start(): Promise<void> {
    if (this.initialized) {
      logger.warn('Server already initialized');
      return;
    }

    try {
      // Initialize memory system (critical - without this, nothing works)
      try {
        await this.context.memory.initialize(this.config.database.qdrantUrl || this.config.database.dbPath);
        logger.info('Memory system initialized');
      } catch (memError) {
        this.initError = memError instanceof Error ? memError : new Error(String(memError));
        logger.error('Failed to initialize memory system', { error: this.initError.message });
        throw new Error(`Memory system initialization failed: ${this.initError.message}`);
      }

      // Initialize model via ModelManager singleton (preload model)
      // Model loads eagerly at startup to prevent timeouts on first request
      try {
        const modelManager = ModelManager.getInstance();
        await modelManager.acquire();
        logger.info('Model manager initialized (model preloaded)');
      } catch (modelError) {
        logger.warn('Model manager initialization failed - embeddings will be generated on first request', { error: modelError instanceof Error ? modelError.message : String(modelError) });
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

      // Start MCP server with stdio transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.initialized = true;

      logger.info('Super-Memory MCP Server started successfully');
    } catch (error) {
      this.initError = error instanceof Error ? error : new Error(String(error));
      logger.error('Failed to initialize server', { error: this.initError.message });
      throw this.initError;
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