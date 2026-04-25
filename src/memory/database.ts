/**
 * Memory Database Layer
 *
 * Handles Qdrant operations for memory storage with HNSW indexing.
 * Replaces LanceDB with native Qdrant client for better concurrency handling.
 */

import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import { randomUUID, createHash } from 'crypto';
import {
  MEMORY_TABLE_NAME,
  QDRANT_METADATA_COLLECTION,
  DEFAULT_QDRANT_URL,
  QDRANT_HNSW_CONFIG,
  PAYLOAD_FIELDS,
  DEFAULT_SEARCH_OPTIONS,
  type MemoryEntry,
  type MemoryEntryInput,
  type SearchOptions,
  type SearchFilter,
  type MemorySourceType,
} from './schema.js';
import { ModelManager } from '../model/index.js';
import { generateEmbeddings } from '../model/embeddings.js';

// Re-export for external consumers
export type { MemoryEntryInput } from './schema.js';

/**
 * Helper to compute SHA-256 hash
 */
function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Build Qdrant filter from SearchFilter
 */
function buildPayloadFilter(filter?: SearchFilter): Record<string, unknown> | undefined {
  if (!filter) return undefined;

  const conditions: Record<string, unknown>[] = [];

  if (filter.sourceType) {
    conditions.push({
      key: PAYLOAD_FIELDS.sourceType,
      match: { value: filter.sourceType },
    });
  }

  if (filter.sessionId) {
    conditions.push({
      key: PAYLOAD_FIELDS.sessionId,
      match: { value: filter.sessionId },
    });
  }

  if (filter.since) {
    conditions.push({
      key: PAYLOAD_FIELDS.timestamp,
      range: { gte: filter.since.getTime() },
    });
  }

  if (conditions.length === 0) return undefined;
  return { must: conditions };
}

// --- Client Cache ---

const clients: Map<string, QdrantClient> = new Map();

function getClient(url: string): QdrantClient {
  if (!clients.has(url)) {
    clients.set(url, new QdrantClient({ url, timeout: 10000 }));
  }
  return clients.get(url)!;
}

/**
 * Retry wrapper for transient network errors
 */
async function withRetry<T>(operation: () => Promise<T>, retries = 3): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Unreachable');
}

/**
 * Convert MemoryEntryInput + generated fields → Qdrant PointStruct
 */
function toPoint(
  id: string,
  vector: number[],
  entry: MemoryEntryInput,
  timestamp: number,
  contentHash: string
): Schemas['PointStruct'] {
  return {
    id,
    vector,
    payload: {
      [PAYLOAD_FIELDS.text]: entry.text,
      [PAYLOAD_FIELDS.content]: entry.text,
      [PAYLOAD_FIELDS.sourceType]: entry.sourceType,
      [PAYLOAD_FIELDS.sourcePath]: entry.sourcePath ?? '',
      [PAYLOAD_FIELDS.timestamp]: timestamp,
      [PAYLOAD_FIELDS.contentHash]: contentHash,
      [PAYLOAD_FIELDS.metadataJson]: entry.metadataJson ?? '',
      [PAYLOAD_FIELDS.sessionId]: entry.sessionId ?? '',
    },
  };
}

/**
 * Convert Qdrant ScoredPoint/Record → MemoryEntry
 */
function pointToMemoryEntry(point: Schemas['ScoredPoint'] | Schemas['Record']): MemoryEntry {
  const payload = point.payload ?? {};

  // Vector may be number[] (default vector) or Record<string, number[]> (named vectors)
  let vector: Float32Array;
  if (Array.isArray(point.vector)) {
    vector = new Float32Array(point.vector as number[]);
  } else if (point.vector && typeof point.vector === 'object') {
    // Named vectors — extract default
    const vec = (point.vector as Record<string, number[]>).default;
    vector = new Float32Array(vec ?? []);
  } else {
    vector = new Float32Array();
  }

  const ts = payload[PAYLOAD_FIELDS.timestamp];

  return {
    id: String(point.id),
    text: (payload[PAYLOAD_FIELDS.text] as string) ?? '',
    vector,
    sourceType: (payload[PAYLOAD_FIELDS.sourceType] as MemorySourceType) ?? 'session',
    sourcePath: (payload[PAYLOAD_FIELDS.sourcePath] as string) || undefined,
    timestamp: ts ? new Date(ts as number) : new Date(),
    contentHash: (payload[PAYLOAD_FIELDS.contentHash] as string) ?? '',
    metadataJson: (payload[PAYLOAD_FIELDS.metadataJson] as string) || undefined,
    sessionId: (payload[PAYLOAD_FIELDS.sessionId] as string) || undefined,
  };
}

// --- Database Class ---

export class MemoryDatabase {
  private initialized: boolean = false;
  private client: QdrantClient;

  constructor(url: string = DEFAULT_QDRANT_URL) {
    this.client = getClient(url);
  }

  /**
   * Initialize the Qdrant collection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const modelManager = ModelManager.getInstance();
    const embeddingDim = modelManager.getDimensions();

    // Check if collection exists
    const collections = await withRetry(() => this.client.getCollections());
    const exists = collections.collections.some(c => c.name === MEMORY_TABLE_NAME);

    if (!exists) {
      // Create collection with vector config
      await withRetry(() => this.client.createCollection(MEMORY_TABLE_NAME, {
        vectors: {
          size: embeddingDim,
          distance: 'Cosine',
        },
        hnsw_config: QDRANT_HNSW_CONFIG,
      }));

      // Create payload indexes for fields used in filtering
      await this.createPayloadIndexes();

      // Store model metadata
      await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
    } else {
      // Validate dimensions match
      await this.validateModelDimensions(embeddingDim);
    }

    this.initialized = true;
  }

  /**
   * Create payload indexes for filter fields
   */
  private async createPayloadIndexes(): Promise<void> {
    const indexFields = [
      { field: PAYLOAD_FIELDS.sourceType, type: 'keyword' as const },
      { field: PAYLOAD_FIELDS.sourcePath, type: 'keyword' as const },
      { field: PAYLOAD_FIELDS.sessionId, type: 'keyword' as const },
      { field: PAYLOAD_FIELDS.contentHash, type: 'keyword' as const },
      { field: PAYLOAD_FIELDS.timestamp, type: 'integer' as const },
    ];

    for (const { field, type } of indexFields) {
      try {
        await this.client.createPayloadIndex(MEMORY_TABLE_NAME, {
          field_name: field,
          field_schema: type,
        });
      } catch (err) {
        // Index may already exist — non-fatal
        console.warn(`Payload index warning for ${field}:`, err);
      }
    }
  }

  /**
   * Add multiple memories in a single batch
   */
  async addMemories(entries: MemoryEntryInput[]): Promise<MemoryEntry[]> {
    const timestamp = Date.now();

    // Generate embeddings for all entries
    const texts = entries.map(e => e.text);
    const embeddingResults = await generateEmbeddings(texts);

    const points = entries.map((entry, idx) => {
      const contentHash = computeHash(entry.text);
      const id = randomUUID();
      return toPoint(id, embeddingResults[idx].embedding, entry, timestamp, contentHash);
    });

    await withRetry(() => this.client.upsert(MEMORY_TABLE_NAME, { points }));

    return points.map(p => pointToMemoryEntry({
      ...p,
      payload: p.payload as Record<string, unknown>,
    } as Schemas['ScoredPoint']));
  }

  /**
   * Add a single memory entry
   */
  async addMemory(input: MemoryEntryInput): Promise<string> {
    const id = randomUUID();
    const timestamp = Date.now();
    const contentHash = computeHash(input.text);

    const vector = input.vector?.length
      ? Array.isArray(input.vector) ? input.vector : Array.from(input.vector)
      : (await generateEmbeddings([input.text]))[0].embedding;

    const point = toPoint(id, vector, input, timestamp, contentHash);
    await withRetry(() => this.client.upsert(MEMORY_TABLE_NAME, { points: [point] }));

    return id;
  }

  /**
   * Get a memory entry by ID
   */
  async getMemory(id: string): Promise<MemoryEntry | null> {
    const results = await withRetry(() => this.client.retrieve(MEMORY_TABLE_NAME, {
      ids: [id],
      with_payload: true,
      with_vector: true,
    }));

    if (results.length === 0) return null;
    return pointToMemoryEntry(results[0]);
  }

  /**
   * Delete a memory entry by ID
   */
  async deleteMemory(id: string): Promise<void> {
    await withRetry(() => this.client.delete(MEMORY_TABLE_NAME, {
      points: [id],
    }));
  }

  /**
   * Delete all memories from a specific source path
   */
  async deleteBySourcePath(sourcePath: string, sourceType?: string): Promise<number> {
    const filter: Record<string, unknown> = {
      must: [
        { key: PAYLOAD_FIELDS.sourcePath, match: { value: sourcePath } },
      ],
    };

    if (sourceType) {
      (filter.must as Array<unknown>).push({
        key: PAYLOAD_FIELDS.sourceType,
        match: { value: sourceType },
      });
    }

    // Count before delete
    const countResult = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, {
      filter,
      exact: true,
    }));

    await withRetry(() => this.client.delete(MEMORY_TABLE_NAME, { filter }));

    return countResult.count;
  }

  /**
   * Query memories by vector similarity
   */
  async queryMemories(
    vector: Float32Array | number[],
    options: SearchOptions = {}
  ): Promise<MemoryEntry[]> {
    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
    const topK = Math.min(opts.topK ?? 5, 20);
    const queryVector = Array.isArray(vector) ? vector : Array.from(vector);
    const filter = buildPayloadFilter(opts.filter);

    const results = await withRetry(() => this.client.search(MEMORY_TABLE_NAME, {
      vector: queryVector,
      limit: topK * 2,
      filter,
      with_payload: true,
      with_vector: true,
    }));

    // Deduplicate by contentHash and return topK
    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];

    for (const result of results) {
      const entry = pointToMemoryEntry(result);
      if (!seen.has(entry.contentHash)) {
        seen.add(entry.contentHash);
        deduped.push(entry);
        if (deduped.length >= topK) break;
      }
    }

    return deduped;
  }

  /**
   * List all memories with optional filter
   */
  async listMemories(filter?: SearchFilter): Promise<MemoryEntry[]> {
    const qdrantFilter = buildPayloadFilter(filter);

    const results = await withRetry(() => this.client.scroll(MEMORY_TABLE_NAME, {
      filter: qdrantFilter,
      limit: 100,
      with_payload: true,
      with_vector: true,
    }));

    return results.points.map(p => pointToMemoryEntry(p));
  }

  /**
   * Get count of memories
   */
  async countMemories(): Promise<number> {
    const result = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, { exact: true }));
    return result.count;
  }

  /**
   * Check if content already exists (by hash)
   */
  async contentExists(hash: string): Promise<boolean> {
    const result = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, {
      filter: {
        must: [{ key: PAYLOAD_FIELDS.contentHash, match: { value: hash } }],
      },
      exact: true,
    }));
    return result.count > 0;
  }

  /**
   * Store model metadata in dedicated collection
   */
  async storeModelMetadata(modelId: string, dimensions: number): Promise<void> {
    // Ensure metadata collection exists
    const collections = await withRetry(() => this.client.getCollections());
    const metaExists = collections.collections.some(c => c.name === QDRANT_METADATA_COLLECTION);

    if (!metaExists) {
      await withRetry(() => this.client.createCollection(QDRANT_METADATA_COLLECTION, {
        vectors: { size: 1, distance: 'Cosine' }, // Dummy vector for single-point collection
      }));
    }

    await withRetry(() => this.client.upsert(QDRANT_METADATA_COLLECTION, {
      points: [{
        id: '00000000-0000-0000-0000-000000000000',
        vector: [0],
        payload: { modelId, dimensions, updatedAt: Date.now() },
      }],
    }));
  }

  /**
   * Retrieve stored model metadata
   */
  async getStoredModelMetadata(): Promise<{ modelId: string; dimensions: number } | null> {
    try {
      const collections = await withRetry(() => this.client.getCollections());
      const metaExists = collections.collections.some(c => c.name === QDRANT_METADATA_COLLECTION);
      if (!metaExists) return null;

      const result = await withRetry(() => this.client.retrieve(QDRANT_METADATA_COLLECTION, {
        ids: ['00000000-0000-0000-0000-000000000000'],
        with_payload: true,
      }));

      if (result.length === 0 || !result[0].payload) return null;

      return {
        modelId: result[0].payload.modelId as string,
        dimensions: result[0].payload.dimensions as number,
      };
    } catch {
      return null;
    }
  }

  /**
   * Validate that current model dimensions match stored metadata
   */
  async validateModelDimensions(currentDimensions: number): Promise<void> {
    const stored = await this.getStoredModelMetadata();
    if (stored && stored.dimensions !== currentDimensions) {
      const errorMsg = [
        `Model dimension mismatch detected!`,
        `  Stored dimensions: ${stored.dimensions}`,
        `  Current model dimensions: ${currentDimensions}`,
        ``,
        `To fix this, delete the Qdrant collection and restart:`,
        `  curl -X DELETE http://localhost:6333/collections/${MEMORY_TABLE_NAME}`,
        ``,
        `Or specify a different collection via environment variable.`,
      ].join('\n');
      throw new Error(errorMsg);
    }
  }

  /**
   * Close the database connection
   * QdrantClient is stateless HTTP, so no explicit close needed
   */
  async close(): Promise<void> {
    this.initialized = false;
  }
}

// --- Singletons ---

const databaseInstances: Map<string, MemoryDatabase> = new Map();

/**
 * Get a database instance for the given URL
 */
export function getDatabase(url?: string): MemoryDatabase {
  const key = url || DEFAULT_QDRANT_URL;
  if (!databaseInstances.has(key)) {
    databaseInstances.set(key, new MemoryDatabase(key));
  }
  return databaseInstances.get(key)!;
}

/**
 * Initialize the default database
 */
export async function initializeDatabase(url?: string): Promise<void> {
  const db = getDatabase(url);
  await db.initialize();
}