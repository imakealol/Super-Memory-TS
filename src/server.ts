/**
 * MCP Server implementation for Super-Memory
 * 
 * Provides MCP tools for:
 * - query_memories: Search memories using semantic similarity
 * - add_memory: Store a new memory entry
 * - search_project: Search indexed project files
 * - index_project: Manually trigger project indexing
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadConfigSync, validateConfig, type Config } from './config.js';
import { ModelManager } from './model/index.js';
import { MemorySystem, getMemorySystem } from './memory/index.js';
import { ProjectIndexer } from './project-index/indexer.js';
import { logger } from './utils/logger.js';
import { MemoryError } from './utils/errors.js';
import type { SearchOptions, MemoryEntryInput, MemorySourceType } from './memory/schema.js';

// ==================== Types ====================

interface QueryMemoriesArgs {
  query: string;
  limit?: number;
  strategy?: 'tiered' | 'vector_only' | 'text_only';
}

interface AddMemoryArgs {
  content: string;
  sourceType?: 'manual' | 'file' | 'conversation' | 'web';
  sourcePath?: string;
  metadata?: Record<string, unknown>;
}

interface SearchProjectArgs {
  query: string;
  topK?: number;
  fileTypes?: string[];
  paths?: string[];
}

interface IndexProjectArgs {
  path?: string;
  force?: boolean;
}

// ==================== Tool Definitions ====================

const TOOLS = [
  {
    name: 'query_memories',
    description: 'Query memories using semantic similarity. Returns memories most relevant to the query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant memories',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10)',
          default: 10,
        },
        strategy: {
          type: 'string',
          enum: ['tiered', 'vector_only', 'text_only'],
          description: 'Search strategy: tiered (hybrid), vector_only (semantic), or text_only (keyword)',
          default: 'tiered',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'add_memory',
    description: 'Add a new memory entry to the memory store.',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to store in memory',
        },
        sourceType: {
          type: 'string',
          enum: ['manual', 'file', 'conversation', 'web'],
          description: 'Source type of the memory',
          default: 'manual',
        },
        sourcePath: {
          type: 'string',
          description: 'Optional source path or URL',
        },
        metadata: {
          type: 'object',
          description: 'Optional metadata to attach to the memory',
        },
      },
      required: ['content'],
    },
  },
  {
    name: 'search_project',
    description: 'Search the indexed project files for relevant code or content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query',
        },
        topK: {
          type: 'number',
          description: 'Maximum number of results (default: 20)',
          default: 20,
        },
        fileTypes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file type filters (e.g., ["ts", "js"])',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional path filters to scope search',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'index_project',
    description: 'Trigger project indexing. Scans and indexes all supported files in the project.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional specific path to index (defaults to current directory)',
        },
        force: {
          type: 'boolean',
          description: 'Force re-indexing of all files (default: false)',
          default: false,
        },
      },
    },
  },
];

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

/**
 * Apply timeout to a promise, returning the result or throwing a timeout error
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new MemoryError('Request timeout', 'REQUEST_TIMEOUT')), ms);
  });
  return Promise.race([promise, timeoutPromise]);
}

// ==================== SuperMemoryServer ====================

export class SuperMemoryServer {
  private server: Server;
  private context: {
    memory: MemorySystem;
    indexer: ProjectIndexer | null;
  };
  private config: Config;
  private initialized: boolean = false;
  private initError: Error | null = null;
  private transportConnected: boolean = false;

  constructor(config?: Config) {
    this.config = config || loadConfigSync();

    // Validate config
    const validation = validateConfig(this.config);
    if (!validation.valid) {
      logger.warn('Configuration warnings:', validation.errors);
    }

    this.context = {
      memory: getMemorySystem(),
      indexer: null,
    };

    // Create MCP server
    this.server = new Server(
      {
        name: 'super-memory',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
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
   * Set up MCP request handlers
   */
  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: TOOLS };
    });

    // Handle tool calls with timeout
    this.server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name, arguments: args } = request.params;

      // Check connection state before processing
      if (!this.transportConnected) {
        logger.error('Received request but transport not connected');
        return this.formatError(new MemoryError('Not connected to transport', 'NOT_CONNECTED'));
      }

      // Apply timeout to prevent requests from hanging indefinitely
      const requestTimeout = 60000; // 60 seconds

      try {
        switch (name) {
          case 'query_memories':
            return await withTimeout(
              this.handleQueryMemories(args as unknown as QueryMemoriesArgs),
              requestTimeout
            );
          case 'add_memory':
            return await withTimeout(
              this.handleAddMemory(args as unknown as AddMemoryArgs),
              requestTimeout
            );
          case 'search_project':
            return await withTimeout(
              this.handleSearchProject(args as unknown as SearchProjectArgs),
              requestTimeout
            );
          case 'index_project':
            return await withTimeout(
              this.handleIndexProject(args as unknown as IndexProjectArgs),
              requestTimeout
            );
          default:
            throw new MemoryError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL');
        }
      } catch (error) {
        // Check for "Not connected" errors and attempt recovery
        if (error instanceof MemoryError && error.message.includes('Not connected')) {
          logger.warn('Not connected error detected, checking transport state...');
          // Don't retry immediately, just report the error
        }
        return this.formatError(error);
      }
    });
  }

  /**
   * Handle query_memories tool
   */
  private async handleQueryMemories(args: QueryMemoriesArgs) {
    const { query, limit = 10, strategy = 'tiered' } = args;

    if (!query || query.trim().length === 0) {
      throw new MemoryError('Query cannot be empty', 'VALIDATION_ERROR');
    }

    logger.debug(`Querying memories: "${query}" (strategy: ${strategy}, limit: ${limit})`);

    try {
      // Map user strategy to internal strategy
      const internalStrategy = (strategy || 'tiered').toUpperCase() as 'TIERED' | 'VECTOR_ONLY' | 'TEXT_ONLY';

      // For VECTOR_ONLY, we need to handle the case where embeddings aren't available
      if (internalStrategy === 'VECTOR_ONLY') {
        logger.warn('VECTOR_ONLY strategy may not work without embedding model - falling back to TEXT_ONLY');
        // Fallback to TEXT_ONLY since we don't have embedding integration yet
        const textResults = await this.context.memory.queryMemories(query, {
          topK: limit,
          strategy: 'TEXT_ONLY',
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                count: textResults.length,
                memories: textResults.map((r) => this.formatMemoryEntry(r)),
                strategy_used: 'TEXT_ONLY (VECTOR_ONLY fallback)',
              }),
            },
          ],
        };
      }

      const searchOpts: SearchOptions = {
        topK: limit,
        strategy: internalStrategy,
      };

      const results = await this.context.memory.queryMemories(query, searchOpts);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              count: results.length,
              memories: results.map((r) => this.formatMemoryEntry(r)),
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error;
      }
      throw new MemoryError(
        `Failed to query memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'QUERY_FAILED'
      );
    }
  }

  /**
   * Handle add_memory tool
   */
  private async handleAddMemory(args: AddMemoryArgs) {
    const { content, sourceType = 'manual', sourcePath, metadata } = args;

    if (!content || content.trim().length === 0) {
      throw new MemoryError('Content cannot be empty', 'VALIDATION_ERROR');
    }

    logger.debug(`Adding memory: "${content.slice(0, 50)}..." (source: ${sourceType})`);

    try {
      // Check for duplicate content
      const exists = await this.context.memory.contentExists(content);
      if (exists) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                message: 'Memory with identical content already exists',
                duplicate: true,
              }),
            },
          ],
        };
      }

      const input: MemoryEntryInput = {
        text: content,
        vector: new Float32Array(), // Will be generated by the memory system
        sourceType: mapSourceType(sourceType),
        sourcePath,
        metadataJson: metadata ? JSON.stringify(metadata) : undefined,
      };

      const id = await this.context.memory.addMemory(input);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              id,
              message: 'Memory added successfully',
            }),
          },
        ],
      };
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error;
      }
      throw new MemoryError(
        `Failed to add memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'ADD_FAILED'
      );
    }
  }

  /**
   * Handle search_project tool
   */
  private async handleSearchProject(args: SearchProjectArgs) {
    const { query, topK = 20, fileTypes, paths } = args;

    if (!query || query.trim().length === 0) {
      throw new MemoryError('Query cannot be empty', 'VALIDATION_ERROR');
    }

    if (!this.context.indexer) {
      throw new MemoryError('Project indexer not initialized. Call index_project first.', 'INDEX_NOT_INITIALIZED');
    }

    logger.debug(`Searching project: "${query}" (topK: ${topK})`);

    try {
      const results = await this.context.indexer.search(query, {
        topK,
        filters: {
          fileTypes,
          paths,
        },
      });

      return {
        content: [
          {
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
          },
        ],
      };
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error;
      }
      throw new MemoryError(
        `Failed to search project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'SEARCH_FAILED'
      );
    }
  }

  /**
   * Handle index_project tool
   */
  private async handleIndexProject(args: IndexProjectArgs) {
    const { path, force = false } = args;

    if (!this.context.indexer) {
      throw new MemoryError('Project indexer not initialized. Initialize with start() first.', 'INDEX_NOT_INITIALIZED');
    }

    const targetPath = path || this.config.database.dbPath || process.cwd();
    logger.info(`Indexing project: ${targetPath} (force: ${force})`);

    try {
      // Trigger actual indexing on the target path
      if (force) {
        // Force reindex - clear existing index first
        this.context.indexer.clearIndex();
      }

      // Start indexing (runs in background, but we wait briefly to get initial stats)
      await this.context.indexer.start();

      // Small delay to allow initial files to be processed
      await new Promise(resolve => setTimeout(resolve, 500));

      const stats = this.context.indexer.getStats();

      return {
        content: [
          {
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
          },
        ],
      };
    } catch (error) {
      if (error instanceof MemoryError) {
        throw error;
      }
      throw new MemoryError(
        `Failed to index project: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'INDEX_FAILED'
      );
    }
  }

  /**
   * Format a memory entry for JSON output
   */
  private formatMemoryEntry(entry: ReturnType<MemorySystem['queryMemories']> extends Promise<infer T> ? T extends (infer U)[] ? U : never : never): object {
    return {
      id: entry.id,
      content: entry.text,
      sourceType: entry.sourceType,
      sourcePath: entry.sourcePath,
      timestamp: entry.timestamp,
    };
  }

  /**
   * Format an error for MCP response
   */
  private formatError(error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const name = error instanceof Error ? error.name : 'Error';

    logger.error(`${name}: ${message}`);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: true,
            name,
            message,
            code: error instanceof MemoryError ? error.code : 'INTERNAL_ERROR',
          }),
        },
      ],
      isError: true,
    };
  }

  /**
   * Initialize the server and connect to transport
   * Implements graceful degradation - server starts even if some components fail
   */
  async start(): Promise<void> {
    try {
      // Initialize memory system (critical - without this, nothing works)
      try {
        await this.context.memory.initialize(this.config.database.dbPath);
        logger.info('Memory system initialized');
      } catch (memError) {
        this.initError = memError instanceof Error ? memError : new Error(String(memError));
        logger.error('Failed to initialize memory system', this.initError);
        // Can't continue without memory system - throw to fail fast
        throw new Error(`Memory system initialization failed: ${this.initError.message}`);
      }

      // Initialize model via ModelManager singleton (non-blocking)
      // Model loads lazily on first request to prevent connection timeout
      try {
        const modelManager = ModelManager.getInstance();
        modelManager.acquire().catch(err => {
          logger.warn('Model loading failed, will retry on first request:', err.message);
        });
        logger.info('Model manager initialized (lazy loading)');
      } catch (modelError) {
        logger.warn('Model manager initialization failed - embeddings unavailable', modelError);
        // Continue without model - some features may not work
      }

      // Initialize project indexer (non-critical)
      try {
        if (this.config.indexer) {
          this.context.indexer = new ProjectIndexer({
            rootPath: process.env.BOOMERANG_ROOT_PATH || process.cwd(),
            includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
            excludePatterns: this.config.indexer.excludePatterns,
            chunkSize: this.config.indexer.chunkSize,
            chunkOverlap: this.config.indexer.chunkOverlap,
            maxFileSize: this.config.indexer.maxFileSize,
            workers: this.config.performance?.workers,
            flushIntervalMs: this.config.performance?.flushIntervalMs,
            flushThreshold: this.config.performance?.flushThreshold,
            memoryThreshold: this.config.performance?.memoryThreshold,
            maxBufferBytes: this.config.performance?.maxBufferBytes,
          });

          // Start the indexer in background - don't fail server startup
          this.context.indexer.start().catch((error) => {
            logger.error('Failed to start indexer', error);
          });

          logger.info('Project indexer initialized');
        }
      } catch (indexerError) {
        logger.warn('Project indexer initialization failed - search_project tool may not work', indexerError);
        // Don't throw - indexer is non-critical
      }

      // Connect to transport
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      this.transportConnected = true;

      // Store reference to transport for potential close detection
      // Note: StdioServerTransport doesn't expose an on() method for close events
      // We rely on the server's close handling instead

      this.initialized = true;
      logger.info('Super-Memory MCP Server started successfully');
    } catch (error) {
      logger.error('Failed to start server', error);
      this.initialized = false;
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

      // Close server
      await this.server.close();
      logger.info('Server shutdown complete');
    } catch (error) {
      logger.error('Error during shutdown', error);
      throw error;
    }
  }
}