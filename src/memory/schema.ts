/**
 * Memory Schema Definitions
 * 
 * Defines the core data structures for the memory storage layer.
 */

/**
 * Source type for memory entries
 */
export type MemorySourceType = 'session' | 'file' | 'web' | 'boomerang' | 'project';

/**
 * Memory entry stored in the database
 */
export interface MemoryEntry {
  /** UUID primary key */
  id: string;
  /** Content text */
  text: string;
  /** BGE-large embedding vector (1024-dim) */
  vector: Float32Array;
  /** Source type indicating where the memory came from */
  sourceType: MemorySourceType;
  /** Optional source URL/path */
  sourcePath?: string;
  /** Entry creation timestamp */
  timestamp: Date;
  /** SHA-256 hash of content for deduplication */
  contentHash: string;
  /** JSON-serialized metadata */
  metadataJson?: string;
  /** Optional session ID for session-scoped memories */
  sessionId?: string;
}

/**
 * Input for creating a new memory entry (without auto-generated fields)
 * Note: vector is optional since addMemories() generates embeddings internally
 */
export type MemoryEntryInput = Omit<MemoryEntry, 'id' | 'timestamp' | 'contentHash' | 'vector'> & { vector?: Float32Array | number[] };

/**
 * Search strategy for querying memories
 */
export type SearchStrategy = 'TIERED' | 'VECTOR_ONLY' | 'TEXT_ONLY';

/**
 * Options for searching memories
 */
export interface SearchOptions {
  /** Number of results to return (default: 5, max: 20) */
  topK?: number;
  /** Search strategy to use (default: 'TIERED') */
  strategy?: SearchStrategy;
  /** Confidence threshold for TIERED strategy fallback (default: 0.72) */
  threshold?: number;
  /** Optional filters */
  filter?: SearchFilter;
}

/**
 * Filter criteria for memory search
 */
export interface SearchFilter {
  /** Filter by source type */
  sourceType?: MemorySourceType;
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by minimum timestamp */
  since?: Date;
}

/**
 * Qdrant collection name for memory points
 */
export const MEMORY_TABLE_NAME = 'memories';

/**
 * Qdrant collection name for model metadata (single-point config store)
 */
export const QDRANT_METADATA_COLLECTION = 'model_metadata';

/**
 * Default Qdrant server URL
 * Override with QDRANT_URL environment variable
 */
export const DEFAULT_QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';

/**
 * HNSW configuration for Qdrant collection creation
 * Maps to Qdrant's HnswConfigDiff
 */
export const QDRANT_HNSW_CONFIG = {
  m: 16,
  ef_construct: 128,
  full_scan_threshold: 10000,
} as const;

/**
 * Payload field names used for indexing and filtering
 */
export const PAYLOAD_FIELDS = {
  text: 'text',
  content: 'content',
  sourceType: 'sourceType',
  sourcePath: 'sourcePath',
  timestamp: 'timestamp',
  contentHash: 'contentHash',
  metadataJson: 'metadataJson',
  sessionId: 'sessionId',
} as const;

/**
 * Default search options
 */
export const DEFAULT_SEARCH_OPTIONS: Required<SearchOptions> = {
  topK: 5,
  strategy: 'TIERED',
  threshold: 0.72,
  filter: {},
} as const;

/**
 * Content hashing result for deduplication
 */
export interface ContentHash {
  /** SHA-256 hash in hex format */
  hash: string;
  /** Original text that was hashed */
  text: string;
}

/**
 * Persistent tracking info for indexed files
 */
export interface IndexedFile {
  /** Full path to the file */
  filePath: string;
  /** SHA-256 content hash */
  contentHash: string;
  /** ISO timestamp of last indexing */
  lastIndexed: string;
  /** Number of chunks the file was split into */
  chunkCount: number;
}