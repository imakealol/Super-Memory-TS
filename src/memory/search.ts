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
} from './database.js';
import {
  type MemoryEntry,
  type SearchOptions,
  DEFAULT_SEARCH_OPTIONS,
} from './schema.js';
import { generateEmbeddings } from '../model/embeddings.js';
import { logger } from '../utils/logger.js';

/** Qdrant search result with similarity score */
interface QdrantMemoryResult extends MemoryEntry {
  _similarity?: number;
}

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
    const { threshold, topK } = options;

    // Try to generate embedding for the question
    let vectorResults: MemoryEntry[] = [];
    try {
      const embeddingResults = await generateEmbeddings([question]);
      const queryVector = new Float32Array(embeddingResults[0].embedding);
      vectorResults = await this.db.queryMemories(queryVector, { topK: topK * 2 });
    } catch (err) {
      // Embedding generation failed, fall back to text-only
      logger.warn('Vector search failed, falling back to text search', { error: err instanceof Error ? err.message : String(err) });
    }

    // If we have vector results and top score meets threshold, return them
    if (vectorResults.length > 0) {
      const topScore = (vectorResults[0] as QdrantMemoryResult)._similarity ?? 0;
      if (topScore >= threshold) {
        return vectorResults.slice(0, topK);
      }
    }

    // Vector results below threshold or unavailable - also do text search and merge
    const textResults = await this.textSearchInternal(question, topK * 2);
    if (textResults.length === 0) {
      return vectorResults.slice(0, topK);
    }

    // Merge vector and text results
    return this.mergeVectorAndTextResults(vectorResults, textResults, topK);
  }

  /**
   * VECTOR_ONLY strategy: Pure vector similarity search
   */
  private async vectorOnlySearch(
    question: string,
    options: Required<SearchOptions>
  ): Promise<MemoryEntry[]> {
    // Generate embedding for the question
    const embeddingResults = await generateEmbeddings([question]);
    const queryVector = new Float32Array(embeddingResults[0].embedding);

    // Query database with vector
    return this.db.queryMemories(queryVector, options);
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
      return []; // Return empty instead of throwing
    }

    const results = this.fuse.search(query, { limit });

    return results.map(result => ({
      entry: result.item,
      score: result.score ?? 1,
    }));
  }

  /**
   * Merge vector and text search results, deduplicating by contentHash
   * Vector results rank higher than text results
   */
  private mergeVectorAndTextResults(
    vectorResults: MemoryEntry[],
    textResults: TextSearchResult[],
    limit: number
  ): MemoryEntry[] {
    const seen = new Set<string>();
    const merged: MemoryEntry[] = [];

    // Interleave: vector results first, then text results
    const maxLen = Math.max(vectorResults.length, textResults.length);
    for (let i = 0; i < maxLen && merged.length < limit; i++) {
      // Add vector result at position i (if exists)
      if (i < vectorResults.length) {
        const entry = vectorResults[i];
        if (!seen.has(entry.contentHash)) {
          seen.add(entry.contentHash);
          merged.push(entry);
          if (merged.length >= limit) break;
        }
      }
      // Add text result at position i (if exists)
      if (i < textResults.length) {
        const entry = textResults[i].entry;
        if (!seen.has(entry.contentHash)) {
          seen.add(entry.contentHash);
          merged.push(entry);
          if (merged.length >= limit) break;
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
