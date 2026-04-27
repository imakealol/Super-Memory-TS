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
  getSearch,
  initializeSearch,
} from './search.js';

// Import for local use (in MemorySystem class)
import { MemoryDatabase } from './database.js';
import { MemorySearch } from './search.js';
import type { MemoryEntry, MemoryEntryInput, SearchOptions } from './schema.js';

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

  constructor(db?: MemoryDatabase, search?: MemorySearch, config?: { dbUri?: string; projectId?: string }) {
    this.db = db ?? new MemoryDatabase(config?.dbUri, config?.projectId);
    this.search = search ?? new MemorySearch(this.db);
    this.projectId = config?.projectId;
  }

  /**
   * Initialize the memory system
   * Must be called before any memory operations
   * Prevents multiple simultaneous initialization calls
   */
  async initialize(dbUri?: string): Promise<void> {
    // If already initializing, wait for that to complete
    if (this.initializing && this.initPromise) {
      return this.initPromise;
    }

    // If already initialized with same URI, return immediately
    if (this.initialized && this.db) {
      return;
    }

    this.initializing = true;
    this.initPromise = this._doInitialize(dbUri);

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
  private async _doInitialize(dbUri?: string): Promise<void> {
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
   * Add a memory entry
   */
  async addMemory(input: MemoryEntryInput): Promise<string> {
    console.error('[MemorySystem.addMemory] input:', JSON.stringify({ text: input.text, sourceType: input.sourceType, sourcePath: input.sourcePath }));
    const id = await this.db.addMemory(input);
    console.error('[MemorySystem.addMemory] db.addMemory completed, id:', id);
    await this.search.refreshIndex();
    console.error('[MemorySystem.addMemory] refreshIndex completed');
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
   */
  async queryMemories(
    question: string,
    options?: SearchOptions
  ): Promise<MemoryEntry[]> {
    return this.search.query(question, options);
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
    console.error('[MemorySystem.contentExists] text:', text);
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    console.error('[MemorySystem.contentExists] data encoded, calling crypto.subtle.digest');
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    console.error('[MemorySystem.contentExists] digest completed');
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    console.error('[MemorySystem.contentExists] hash:', hash);

    return this.db.contentExists(hash);
  }
}

/**
 * Create a new MemorySystem instance
 */
export function createMemorySystem(): MemorySystem {
  return new MemorySystem();
}

/**
 * Default memory system instance
 */
let defaultMemorySystem: MemorySystem | null = null;

/**
 * Get the default memory system instance
 */
export function getMemorySystem(config?: { dbUri?: string; projectId?: string }): MemorySystem {
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
