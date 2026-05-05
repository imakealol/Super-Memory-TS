/**
 * Memory Storage Layer
 *
 * Complete memory system with Qdrant storage and HNSW indexing,
 * supporting TIERED, VECTOR_ONLY, and TEXT_ONLY search strategies.
 */

// Schema and types
export {
  MEMORY_TABLE_NAME,
  QDRANT_HNSW_CONFIG,
  DEFAULT_SEARCH_OPTIONS,
  type MemoryEntry,
  type MemoryEntryInput,
  type MemorySourceType,
  type SearchOptions,
  type SearchFilter,
  type SearchStrategy,
  type ContentHash,
} from './schema.js';

// Database layer
export {
  MemoryDatabase,
  getDatabase,
  initializeDatabase,
} from './database.js';

// Search layer
export {
  MemorySearch,
} from './search.js';

// Import for local use (in MemorySystem class)
import { MemoryDatabase } from './database.js';
import { MemorySearch } from './search.js';
import { MEMORY_TABLE_NAME, type MemoryEntry, type MemoryEntryInput, type SearchOptions } from './schema.js';
import { generateEmbeddings } from '../model/embeddings.js';
import { logger } from '../utils/logger.js';

/**
 * Options for memory initialization
 */
export interface InitializeOptions {
  maxRetries?: number;
  retryDelayMs?: number;
}

/**
 * MemorySystem - High-level memory interface
 *
 * Combines database and search operations into a single interface.
 */
export class MemorySystem {
  private db: MemoryDatabase;
  private search: MemorySearch;
  private initialized: boolean = false;
  private initializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  private projectId?: string;
  /** Collections to search. Defaults to [MEMORY_TABLE_NAME] for backward compatibility */
  private queryCollections: string[];

  constructor(db?: MemoryDatabase, search?: MemorySearch, config?: { dbUri?: string; projectId?: string; queryCollections?: string[] }) {
    this.db = db ?? new MemoryDatabase(config?.dbUri, config?.projectId);
    this.search = search ?? new MemorySearch(this.db);
    this.projectId = config?.projectId;
    this.queryCollections = config?.queryCollections ?? [MEMORY_TABLE_NAME];
  }

  /**
   * Initialize the memory system with optional retry options
   * Must be called before any memory operations
   * Prevents multiple simultaneous initialization calls
   */
  async initialize(dbUri?: string, options?: InitializeOptions): Promise<void> {
    // If already initializing, wait for that to complete
    if (this.initializing && this.initPromise) {
      return this.initPromise;
    }

    // If already initialized with same URI, return immediately
    if (this.initialized && this.db) {
      return;
    }

    this.initializing = true;
    this.initPromise = this._doInitialize(dbUri, options);

    try {
      await this.initPromise;
      this.initialized = true;
    } finally {
      this.initializing = false;
      this.initPromise = null;
    }
  }

  /**
   * Internal initialization logic
   */
  private async _doInitialize(dbUri?: string, _options?: InitializeOptions): Promise<void> {
    // If dbUri provided and different from current, create new database
    if (dbUri) {
      this.db = new MemoryDatabase(dbUri, this.projectId);
    }
    await this.db.initialize();

    // Create new search with the database instance
    this.search = new MemorySearch(this.db);
    await this.search.refreshIndex();
  }

  /**
   * Check if the memory system is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Check if the memory system is ready (initialized and connected to Qdrant)
   */
  isReady(): boolean {
    return this.initialized && this.db.isConnected();
  }

  /**
   * Add a memory entry
   */
  async addMemory(input: MemoryEntryInput): Promise<string> {
    const id = await this.db.addMemory(input);
    await this.search.refreshIndex();
    return id;
  }

  /**
   * Get a memory by ID
   */
  async getMemory(id: string): Promise<MemoryEntry | null> {
    return this.db.getMemory(id);
  }

  /**
   * Delete a memory entry
   */
  async deleteMemory(id: string): Promise<void> {
    await this.db.deleteMemory(id);
    await this.search.refreshIndex();
  }

  /**
   * Query memories using search strategies
   * When multiple collections are configured, uses RRF to merge results
   */
  async queryMemories(
    question: string,
    options?: SearchOptions
  ): Promise<MemoryEntry[]> {
    // Single collection - use existing search
    if (this.queryCollections.length === 1) {
      return this.search.query(question, options);
    }

    // Multiple collections - RRF merge
    return this.queryMultiCollection(question, options ?? {});
  }

  /**
   * Query across multiple collections using Reciprocal Rank Fusion (RRF)
   */
  private async queryMultiCollection(
    question: string,
    options: SearchOptions
  ): Promise<MemoryEntry[]> {
    const limit = options.topK ?? 5;
    const k = 60; // RRF constant
    const currentDim = await this.getCurrentEmbeddingDimension();

    // Generate embedding once
    const embeddingResults = await generateEmbeddings([question]);
    const queryVector = new Float32Array(embeddingResults[0].embedding);

    // Search all collections in parallel
    const searches = this.queryCollections.map(async collection => {
      try {
        // Validate dimension match
        if (currentDim !== null) {
          const collectionDim = await this.db.getCollectionDimension(collection);
          if (collectionDim !== null && collectionDim !== currentDim) {
            logger.warn(`Collection ${collection} dimension mismatch (${collectionDim} vs ${currentDim}), skipping`);
            return [];
          }
        }
        // Fetch more results per collection for RRF
        const results = await this.db.queryMemories(queryVector, { ...options, topK: limit * 2 }, collection);
        return results;
      } catch (err) {
        logger.warn(`Collection ${collection} search failed, skipping`, { error: err instanceof Error ? err.message : String(err) });
        return [];
      }
    });

    const results = await Promise.all(searches);

    // RRF merge
    const scores = new Map<string, number>();
    const entries = new Map<string, MemoryEntry>();

    for (const collectionResults of results) {
      for (let rank = 0; rank < collectionResults.length; rank++) {
        const memory = collectionResults[rank];
        const rrfScore = 1.0 / (k + rank + 1);
        scores.set(memory.id, (scores.get(memory.id) || 0) + rrfScore);
        entries.set(memory.id, memory);
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => entries.get(id)!)
      .filter(Boolean);
  }

  /**
   * Get current embedding dimension from model manager
   */
  private async getCurrentEmbeddingDimension(): Promise<number> {
    try {
      const { ModelManager } = await import('../model/index.js');
      return ModelManager.getInstance().getDimensions();
    } catch {
      return 1024; // Default fallback
    }
  }

  /**
   * Search with a pre-computed vector
   */
  async searchWithVector(
    vector: Float32Array,
    options?: SearchOptions
  ): Promise<MemoryEntry[]> {
    return this.search.searchWithVector(vector, options);
  }

  /**
   * Get memories similar to a given memory
   */
  async getSimilar(
    memoryId: string,
    options?: SearchOptions
  ): Promise<MemoryEntry[]> {
    return this.search.getSimilar(memoryId, options);
  }

  /**
   * List memories with optional filter
   */
  async listMemories(filter?: SearchOptions['filter']): Promise<MemoryEntry[]> {
    return this.db.listMemories(filter);
  }

  /**
   * Get memory statistics
   */
  async getStats(): Promise<{ count: number }> {
    const count = await this.db.countMemories();
    return { count };
  }

  /**
   * Check if content already exists
   */
  async contentExists(text: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return this.db.contentExists(hash);
  }
}

/**
 * Default memory system instance
 */
let defaultMemorySystem: MemorySystem | null = null;

/**
 * Get the default memory system instance
 */
export function getMemorySystem(config?: { dbUri?: string; projectId?: string; queryCollections?: string[] }): MemorySystem {
  if (!defaultMemorySystem) {
    defaultMemorySystem = new MemorySystem(undefined, undefined, config);
  }
  return defaultMemorySystem;
}

/**
 * Reset the default memory system instance (for testing or recovery)
 */
export function resetMemorySystem(): void {
  if (defaultMemorySystem) {
    defaultMemorySystem = null;
  }
}
