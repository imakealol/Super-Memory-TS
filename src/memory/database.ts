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
import { logger } from '../utils/logger.js';
import { getConfig } from '../config.js';

// Re-export for external consumers
export type { MemoryEntryInput } from './schema.js';

/**
 * Helper to compute SHA-256 hash
 */
function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
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
 * Clear the client cache (for testing purposes)
 */
export function clearClientCache(): void {
  clients.clear();
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
  contentHash: string,
  projectId?: string
): Schemas['PointStruct'] {
  const payload: Record<string, unknown> = {
    [PAYLOAD_FIELDS.text]: entry.text,
    [PAYLOAD_FIELDS.content]: entry.text,
    [PAYLOAD_FIELDS.sourceType]: entry.sourceType,
    [PAYLOAD_FIELDS.sourcePath]: entry.sourcePath ?? '',
    [PAYLOAD_FIELDS.timestamp]: timestamp,
    [PAYLOAD_FIELDS.contentHash]: contentHash,
    [PAYLOAD_FIELDS.metadataJson]: entry.metadataJson ?? '',
    [PAYLOAD_FIELDS.sessionId]: entry.sessionId ?? '',
  };

  if (projectId) {
    payload[PAYLOAD_FIELDS.projectId] = projectId;
  }

  return { id, vector, payload };
}

/**
 * Type guard for named vectors (Record<string, number[]>)
 */
function isNamedVector(vector: unknown): vector is Record<string, number[]> {
  return typeof vector === 'object' && vector !== null && !Array.isArray(vector);
}

/**
 * Extract Float32Array from vector regardless of format
 */
function extractVector(point: Schemas['ScoredPoint'] | Schemas['Record']): Float32Array {
  const rawVector = point.vector;

  // Handle flat number array
  if (Array.isArray(rawVector) && rawVector.length > 0 && typeof rawVector[0] === 'number') {
    return new Float32Array(rawVector as number[]);
  }

  // Handle named vectors
  if (isNamedVector(rawVector)) {
    const defaultVec = rawVector.default;
    if (Array.isArray(defaultVec) && defaultVec.length > 0 && typeof defaultVec[0] === 'number') {
      return new Float32Array(defaultVec as number[]);
    }
  }

  return new Float32Array();
}

/**
 * Convert Qdrant ScoredPoint/Record → MemoryEntry
 */
function pointToMemoryEntry(point: Schemas['ScoredPoint'] | Schemas['Record']): MemoryEntry {
  const payload = point.payload ?? {};
  const vector = extractVector(point);

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
    projectId: (payload[PAYLOAD_FIELDS.projectId] as string) || undefined,
  };
}

// --- Database Class ---

export class MemoryDatabase {
  private initialized: boolean = false;
  private client: QdrantClient;
  private qdrantUrl: string;
  private projectId?: string;

  constructor(url: string = DEFAULT_QDRANT_URL, projectId?: string) {
    this.qdrantUrl = url;
    this.client = getClient(url);
    this.projectId = projectId;
  }

  /**
   * Build the project isolation filter with backward compatibility.
   * Matches entries with the current projectId OR entries with no projectId (legacy data).
   */
  private getProjectFilter(): Record<string, unknown> | undefined {
    if (!this.projectId) return undefined;
    return {
      should: [
        { key: PAYLOAD_FIELDS.projectId, match: { value: this.projectId } },
        { is_empty: { key: PAYLOAD_FIELDS.projectId } },
      ],
    };
  }

  /**
   * Initialize the Qdrant collection
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Health check - verify Qdrant is reachable
    try {
      await this.client.getCollections();
    } catch (err) {
      throw new Error(
        `Cannot connect to Qdrant at ${this.qdrantUrl}. Ensure Qdrant is running: docker run -p 6333:6333 qdrant/qdrant`
      );
    }

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
      // Ensure project_id index exists for existing collections
      await this.ensureProjectIdIndex();
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
      { field: PAYLOAD_FIELDS.projectId, type: 'keyword' as const },
    ];

    for (const { field, type } of indexFields) {
      try {
        await this.client.createPayloadIndex(MEMORY_TABLE_NAME, {
          field_name: field,
          field_schema: type,
        });
      } catch (err) {
        // Index may already exist — non-fatal
        logger.warn(`Payload index warning for ${field}:`, err);
      }
    }
  }

  /**
   * Ensure project_id payload index exists (for existing collections)
   */
  private async ensureProjectIdIndex(): Promise<void> {
    try {
      await this.client.createPayloadIndex(MEMORY_TABLE_NAME, {
        field_name: PAYLOAD_FIELDS.projectId,
        field_schema: 'keyword',
      });
    } catch (err) {
      // Index may already exist — non-fatal
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes('already exists')) {
        logger.warn('Project ID payload index warning:', err);
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
      return toPoint(id, embeddingResults[idx].embedding, entry, timestamp, contentHash, this.projectId);
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

    const point = toPoint(id, vector, input, timestamp, contentHash, this.projectId);
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
    const must: Record<string, unknown>[] = [
      { key: PAYLOAD_FIELDS.sourcePath, match: { value: sourcePath } },
    ];

    if (sourceType) {
      must.push({
        key: PAYLOAD_FIELDS.sourceType,
        match: { value: sourceType },
      });
    }

    const projectFilter = this.getProjectFilter();
    if (projectFilter) {
      must.push(projectFilter);
    }

    const filter = must.length === 1 ? must[0] : { must };

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

    // Build filter: project isolation + user filters
    const conditions: Record<string, unknown>[] = [];
    const projectFilter = this.getProjectFilter();
    if (projectFilter) conditions.push(projectFilter);

    if (opts.filter) {
      if (opts.filter.sourceType) {
        conditions.push({ key: PAYLOAD_FIELDS.sourceType, match: { value: opts.filter.sourceType } });
      }
      if (opts.filter.sessionId) {
        conditions.push({ key: PAYLOAD_FIELDS.sessionId, match: { value: opts.filter.sessionId } });
      }
      if (opts.filter.since) {
        conditions.push({ key: PAYLOAD_FIELDS.timestamp, range: { gte: opts.filter.since.getTime() } });
      }
      if (opts.filter.projectId) {
        conditions.push({ key: PAYLOAD_FIELDS.projectId, match: { value: opts.filter.projectId } });
      }
    }

    const filter = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { must: conditions };

    const results = await withRetry(() => this.client.search(MEMORY_TABLE_NAME, {
      vector: queryVector,
      limit: topK * 2,
      filter,
      with_payload: true,
      with_vector: false,
    }));

    // Deduplicate by contentHash and return topK
    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];

    for (const result of results) {
      const entry = pointToMemoryEntry(result);
      if (typeof result.score === 'number') {
        entry.score = result.score;
      }
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
    // Build filter: project isolation + user filters
    const conditions: Record<string, unknown>[] = [];
    const projectFilter = this.getProjectFilter();
    if (projectFilter) conditions.push(projectFilter);

    if (filter) {
      if (filter.sourceType) {
        conditions.push({ key: PAYLOAD_FIELDS.sourceType, match: { value: filter.sourceType } });
      }
      if (filter.sessionId) {
        conditions.push({ key: PAYLOAD_FIELDS.sessionId, match: { value: filter.sessionId } });
      }
      if (filter.since) {
        conditions.push({ key: PAYLOAD_FIELDS.timestamp, range: { gte: filter.since.getTime() } });
      }
      if (filter.projectId) {
        conditions.push({ key: PAYLOAD_FIELDS.projectId, match: { value: filter.projectId } });
      }
    }

    const qdrantFilter = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : { must: conditions };

    const results = await withRetry(() => this.client.scroll(MEMORY_TABLE_NAME, {
      filter: qdrantFilter,
      limit: 100,
      with_payload: true,
      with_vector: false,
    }));

    return results.points.map(p => pointToMemoryEntry(p));
  }

  /**
   * Get count of memories
   */
  async countMemories(): Promise<number> {
    const projectFilter = this.getProjectFilter();
    const filter = projectFilter || undefined;
    const result = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, { filter, exact: true }));
    return result.count;
  }

  /**
   * Check if content already exists (by hash)
   */
  async contentExists(hash: string): Promise<boolean> {
    const must: Record<string, unknown>[] = [
      { key: PAYLOAD_FIELDS.contentHash, match: { value: hash } },
    ];

    const projectFilter = this.getProjectFilter();
    if (projectFilter) {
      must.push(projectFilter);
    }

    const filter = must.length === 1 ? must[0] : { must };

    const result = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, {
      filter,
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
 * Get a database instance for the given URL and projectId
 */
export function getDatabase(url?: string, projectId?: string): MemoryDatabase {
  const key = url || DEFAULT_QDRANT_URL;
  if (!databaseInstances.has(key)) {
    const effectiveProjectId = projectId ?? getConfig().database.projectId;
    databaseInstances.set(key, new MemoryDatabase(key, effectiveProjectId));
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