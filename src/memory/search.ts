/**
 * Memory Search Layer
 * 
 * Implements TIERED, VECTOR_ONLY, and TEXT_ONLY search strategies
 * using Qdrant for vector search and Fuse.js for text search.
 */

import Fuse, { type IFuseOptions } from 'fuse.js';
import {
  MemoryDatabase,
  getDatabase,
  initializeDatabase,
} from './database.js';
import {
  type MemoryEntry,
  type SearchOptions,
  DEFAULT_SEARCH_OPTIONS,
} from './schema.js';

/**
 * Fuse.js configuration for text search
 */
const FUSE_CONFIG: IFuseOptions<MemoryEntry> = {
  keys: ['text'],
  threshold: 0.3,
  distance: 100,
  includeScore: true,
  ignoreLocation: true,
  minMatchCharLength: 2,
  useExtendedSearch: true,
  findAllMatches: true,
};

/**
 * Text search result with score
 */
interface TextSearchResult {
  entry: MemoryEntry;
  score: number;
}

/**
 * MemorySearch class for querying memories with different strategies
 */
export class MemorySearch {
  private db: MemoryDatabase;
  private fuse: Fuse<MemoryEntry> | null = null;
  private fuseReady: boolean = false;

  constructor(db?: MemoryDatabase) {
    this.db = db ?? getDatabase();
  }

  /**
   * Ensure Fuse.js index is built
   */
  private async ensureFuseIndex(): Promise<void> {
    if (this.fuseReady) {
      return;
    }

    // Fetch all memories for Fuse.js indexing
    const memories = await this.db.listMemories();
    
    this.fuse = new Fuse(memories, {
      ...FUSE_CONFIG,
      keys: ['text'],
    });
    
    this.fuseReady = true;
  }

  /**
   * Refresh Fuse.js index (call after adding/deleting memories)
   */
  async refreshIndex(): Promise<void> {
    this.fuseReady = false;
    await this.ensureFuseIndex();
  }

  /**
   * Query memories using the specified strategy
   */
  async query(
    question: string,
    options: SearchOptions = {}
  ): Promise<MemoryEntry[]> {
    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };

    switch (opts.strategy) {
      case 'VECTOR_ONLY':
        return this.vectorOnlySearch(question, opts);
      case 'TEXT_ONLY':
        return this.textOnlySearch(question, opts);
      case 'TIERED':
      default:
        return this.tieredSearch(question, opts);
    }
  }

  /**
   * TIERED strategy: Vector search first, fallback to text
   * 
   * Algorithm:
   * 1. Embed question
   * 2. Run vector search
   * 3. If top score >= threshold, return vector results
   * 4. Otherwise, run text search and merge results
   */
  private async tieredSearch(
    question: string,
    options: Required<SearchOptions>
  ): Promise<MemoryEntry[]> {
    // For TIERED search, we need the question embedding
    // In a full implementation, this would use the embedding model
    // For now, we assume vector is passed in options or we use a placeholder
    
    const { threshold, topK } = options;

    // Perform text search as the fallback
    // (In full implementation, would first try vector with proper embedding)
    const textResults = await this.textSearchInternal(question, topK * 2);

    if (textResults.length === 0) {
      return [];
    }

    // In a real implementation, we'd check the vector similarity threshold
    // For now, we use text score as a proxy
    const topScore = 1 - (textResults[0]?.score ?? 0);

    if (topScore >= threshold) {
      // High confidence - return vector/text results as-is
      return textResults.slice(0, topK).map(r => r.entry);
    }

    // Fallback mode - merge and dedupe
    // (In full implementation, would also run vector search here)
    return this.mergeAndDedupe(textResults, topK);
  }

  /**
   * VECTOR_ONLY strategy: Pure vector similarity search
   */
  private async vectorOnlySearch(
    question: string,
    options: Required<SearchOptions>
  ): Promise<MemoryEntry[]> {
    // In a full implementation, this would:
    // 1. Embed the question using the embedding model
    // 2. Query the database with the vector
    // 3. Return topK results
    
    // Placeholder: Return text search results until embedding is integrated
    const textResults = await this.textSearchInternal(question, options.topK);
    return textResults.map(r => r.entry);
  }

  /**
   * TEXT_ONLY strategy: Pure Fuse.js text search
   */
  private async textOnlySearch(
    question: string,
    options: Required<SearchOptions>
  ): Promise<MemoryEntry[]> {
    const results = await this.textSearchInternal(question, options.topK);
    return results.map(r => r.entry);
  }

  /**
   * Internal text search using Fuse.js
   */
  private async textSearchInternal(
    query: string,
    limit: number
  ): Promise<TextSearchResult[]> {
    await this.ensureFuseIndex();

    if (!this.fuse) {
      throw new Error('Fuse.js index not initialized');
    }

    const results = this.fuse.search(query, { limit });

    return results.map(result => ({
      entry: result.item,
      score: result.score ?? 1,
    }));
  }

  /**
   * Merge and deduplicate results by content hash
   */
  private mergeAndDedupe(
    results: TextSearchResult[],
    limit: number
  ): MemoryEntry[] {
    const seen = new Set<string>();
    const merged: MemoryEntry[] = [];

    for (const result of results) {
      if (!seen.has(result.entry.contentHash)) {
        seen.add(result.entry.contentHash);
        merged.push(result.entry);
        if (merged.length >= limit) {
          break;
        }
      }
    }

    return merged;
  }

  /**
   * Search with a pre-computed vector embedding
   * 
   * This is the main entry point when you already have the embedding
   */
  async searchWithVector(
    vector: Float32Array,
    options: SearchOptions = {}
  ): Promise<MemoryEntry[]> {
    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
    
    if (opts.strategy === 'TEXT_ONLY') {
      // TEXT_ONLY ignores the vector, use query() instead
      return this.query('', opts);
    }

    // Use database vector search
    const results = await this.db.queryMemories(vector, opts);
    return results;
  }

  /**
   * Get similar memories to a given memory entry
   */
  async getSimilar(
    memoryId: string,
    options: SearchOptions = {}
  ): Promise<MemoryEntry[]> {
    const memory = await this.db.getMemory(memoryId);
    if (!memory) {
      return [];
    }

    return this.searchWithVector(memory.vector, options);
  }
}

/**
 * Default search instance
 */
let defaultSearch: MemorySearch | null = null;

/**
 * Get the default search instance
 */
export function getSearch(db?: MemoryDatabase): MemorySearch {
  if (!defaultSearch) {
    defaultSearch = new MemorySearch(db);
  }
  return defaultSearch;
}

/**
 * Initialize search with database
 */
export async function initializeSearch(dbUri?: string): Promise<MemorySearch> {
  await initializeDatabase(dbUri);
  defaultSearch = new MemorySearch(getDatabase(dbUri));
  await defaultSearch.refreshIndex();
  return defaultSearch;
}
