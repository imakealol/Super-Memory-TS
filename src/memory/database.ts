/**
 * Memory Database Layer
 *
 * Handles Qdrant operations for memory storage with HNSW indexing.
 * Uses Qdrant native client for vector storage with HNSW indexing and payload filtering.
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

/**
 * Validate that a client connection is healthy by checking collections.
 * Returns true if connection is working, false otherwise.
 */
async function validateConnection(client: QdrantClient): Promise<boolean> {
  try {
    await client.getCollections();
    return true;
  } catch {
    return false;
  }
}

function getClient(url: string): QdrantClient {
  if (!clients.has(url)) {
    clients.set(url, new QdrantClient({ url, timeout: 60000, checkCompatibility: false }));
  }
  return clients.get(url)!;
}

/**
 * Remove a client from the cache with cleanup.
 * Aborts any pending requests before removal.
 */
function removeClient(url: string): void {
  const client = clients.get(url);
  if (client) {
    // QdrantClient uses AbortController internally - trigger aborts
    // Client is stateless HTTP, so no persistent connections to close
    clients.delete(url);
  }
}

/**
 * Clear all clients from the cache (for shutdown/testing)
 */
export function clearClientCache(): void {
  clients.clear();
}

/**
 * Retry wrapper for transient network errors with optional connection validation.
 * Before each attempt, validates the connection is healthy and recreates if needed.
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  url: string,
  retries = 3
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      // Get current client and validate health before operation
      const client = clients.get(url);
      if (client) {
        const healthy = await validateConnection(client);
        if (!healthy) {
          // Connection dead - recreate with cleanup
          removeClient(url);
          const newClient = new QdrantClient({ url, timeout: 60000, checkCompatibility: false });
          clients.set(url, newClient);
        }
      }

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
  private connected: boolean = false;
  private client: QdrantClient;
  private qdrantUrl: string;
  private projectId?: string;
  /** The active collection name (dimension-suffixed) */
  private activeCollectionName: string;

  constructor(url: string = DEFAULT_QDRANT_URL, projectId?: string) {
    this.qdrantUrl = url;
    this.client = getClient(url);
    this.projectId = projectId;
    this.activeCollectionName = MEMORY_TABLE_NAME; // Will be updated after model dimensions are known
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
   * Check if the database is connected (last health check succeeded)
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Initialize the Qdrant collection
   * Uses dimension-suffixed collection name based on active model
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Health check with retry - verify Qdrant is reachable
    try {
      await withRetry(() => this.client.getCollections(), this.qdrantUrl);
      this.connected = true;
    } catch (_err) {
      this.connected = false;
      throw new Error(
        `Cannot connect to Qdrant at ${this.qdrantUrl}. Ensure Qdrant is running: docker run -p 6333:6333 qdrant/qdrant`
      );
    }

    const modelManager = ModelManager.getInstance();
    const embeddingDim = modelManager.getDimensions();

    // Set the dimension-suffixed collection name
    // Allow COLLECTION_NAME env var to override the base name at runtime
    const baseName = process.env.COLLECTION_NAME || MEMORY_TABLE_NAME;
    this.activeCollectionName = `${baseName}_${embeddingDim}`;

    // Check if collection exists
    const collections = await withRetry(() => this.client.getCollections(), this.qdrantUrl);
    const exists = collections.collections.some(c => c.name === this.activeCollectionName);

    if (!exists) {
      // Create collection with vector config
      await withRetry(() => this.client.createCollection(this.activeCollectionName, {
        vectors: {
          size: embeddingDim,
          distance: 'Cosine',
        },
        hnsw_config: QDRANT_HNSW_CONFIG,
      }), this.qdrantUrl);

      // Create payload indexes for fields used in filtering
      await this.createPayloadIndexes();

      // Store model metadata
      await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
    } else {
      // Validate dimensions match
      await this.validateModelDimensions(embeddingDim);
      // Ensure project_id index exists for existing collections
      await this.ensureProjectIdIndex();
      // Refresh model metadata for existing collections
      await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
    }

    this.initialized = true;
  }

  /**
   * Get the active collection name (dimension-suffixed)
   */
  getActiveCollectionName(): string {
    return this.activeCollectionName;
  }

  /**
   * Get the fallback collection name (opposite dimension)
   */
  getFallbackCollectionName(): string | null {
    const dim = this.activeCollectionName.split('_').pop();
    const baseName = process.env.COLLECTION_NAME || MEMORY_TABLE_NAME;
    if (dim === '1024') {
      return `${baseName}_384`;
    }
    if (dim === '384') {
      return `${baseName}_1024`;
    }
    return null;
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
        await this.client.createPayloadIndex(this.activeCollectionName, {
          field_name: field,
          field_schema: type,
        });
    } catch (_err) {
        // Index may already exist — non-fatal
        logger.warn(`Payload index warning for ${field}:`, _err);
      }
    }
  }

  /**
   * Ensure project_id payload index exists (for existing collections)
   */
  private async ensureProjectIdIndex(): Promise<void> {
    try {
      await this.client.createPayloadIndex(this.activeCollectionName, {
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

    await withRetry(() => this.client.upsert(this.activeCollectionName, { points }), this.qdrantUrl);

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

    let vector: number[];
    if (input.vector?.length) {
      vector = Array.isArray(input.vector) ? input.vector : Array.from(input.vector);
    } else {
      vector = (await generateEmbeddings([input.text]))[0].embedding;
    }

    const point = toPoint(id, vector, input, timestamp, contentHash, this.projectId);
    await withRetry(() => this.client.upsert(this.activeCollectionName, { points: [point] }), this.qdrantUrl);

    return id;
  }

  /**
   * Get a memory entry by ID
   */
  async getMemory(id: string): Promise<MemoryEntry | null> {
    const results = await withRetry(() => this.client.retrieve(this.activeCollectionName, {
      ids: [id],
      with_payload: true,
      with_vector: true,
    }), this.qdrantUrl);

    if (results.length === 0) return null;
    return pointToMemoryEntry(results[0]);
  }

  /**
   * Delete a memory entry by ID
   */
  async deleteMemory(id: string): Promise<void> {
    await withRetry(() => this.client.delete(this.activeCollectionName, {
      points: [id],
    }), this.qdrantUrl);
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

    const filter = { must };

    // Count before delete
    const countResult = await withRetry(() => this.client.count(this.activeCollectionName, {
      filter,
      exact: true,
    }), this.qdrantUrl);

    await withRetry(() => this.client.delete(this.activeCollectionName, { filter }), this.qdrantUrl);

    return countResult.count;
  }

  /**
   * Query memories by vector similarity
   * @param collectionName Optional collection name (defaults to activeCollectionName)
   */
  async queryMemories(
    vector: Float32Array | number[],
    options: SearchOptions = {},
    collectionName: string = this.activeCollectionName
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

    const filter = conditions.length === 0 ? undefined : { must: conditions };

    let results: Schemas['ScoredPoint'][] = [];
    try {
      results = await withRetry(() => this.client.search(collectionName, {
        vector: queryVector,
        limit: topK * 2,
        filter,
        with_payload: true,
        with_vector: false,
      }), this.qdrantUrl);
    } catch (_err) {
      // Collection doesn't exist or other error - return empty
      return [];
    }

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
   * Get the vector dimension of a collection
   */
  async getCollectionDimension(collectionName: string): Promise<number | null> {
    try {
      const info = await withRetry(() => this.client.getCollection(collectionName), this.qdrantUrl);
      // Handle both simple vectors (size: number) and named vectors (vectors: Record<string, {...}>)
      const vectors = info.config?.params?.vectors;
      if (typeof vectors === 'object' && vectors !== null) {
        if (typeof vectors === 'number') {
          return vectors;
        }
        // Named vectors - get size from 'default' or first entry
        if ('default' in vectors) {
          return (vectors.default as { size?: number })?.size ?? null;
        }
        // For other named vectors, cast to access by key
        const namedVectors = vectors as Record<string, { size?: number }>;
        const firstKey = Object.keys(namedVectors)[0];
        if (firstKey) {
          return namedVectors[firstKey]?.size ?? null;
        }
      }
      return null;
    } catch {
      return null;
    }
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

    const qdrantFilter = conditions.length === 0 ? undefined : { must: conditions };

    const results = await withRetry(() => this.client.scroll(this.activeCollectionName, {
      filter: qdrantFilter,
      limit: 100,
      with_payload: true,
      with_vector: false,
    }), this.qdrantUrl);

    return results.points.map(p => pointToMemoryEntry(p));
  }

  /**
   * Get count of memories
   */
  async countMemories(): Promise<number> {
    const projectFilter = this.getProjectFilter();
    const filter = projectFilter || undefined;
    const result = await withRetry(() => this.client.count(this.activeCollectionName, { filter, exact: true }), this.qdrantUrl);
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

    const filter = { must };

    const result = await withRetry(() => this.client.count(this.activeCollectionName, {
      filter,
      exact: true,
    }), this.qdrantUrl);
    return result.count > 0;
  }

  /**
   * Store model metadata in dedicated collection
   */
  async storeModelMetadata(modelId: string, dimensions: number): Promise<void> {
    // Ensure metadata collection exists
    const collections = await withRetry(() => this.client.getCollections(), this.qdrantUrl);
    const metaExists = collections.collections.some(c => c.name === QDRANT_METADATA_COLLECTION);

    if (!metaExists) {
      await withRetry(() => this.client.createCollection(QDRANT_METADATA_COLLECTION, {
        vectors: { size: 1, distance: 'Cosine' }, // Dummy vector for single-point collection
      }), this.qdrantUrl);
    }

    await withRetry(() => this.client.upsert(QDRANT_METADATA_COLLECTION, {
      points: [{
        id: '00000000-0000-0000-0000-000000000000',
        vector: [0],
        payload: { modelId, dimensions, updatedAt: Date.now() },
      }],
    }), this.qdrantUrl);
  }

  /**
   * Retrieve stored model metadata
   */
  async getStoredModelMetadata(): Promise<{ modelId: string; dimensions: number } | null> {
    try {
      const collections = await withRetry(() => this.client.getCollections(), this.qdrantUrl);
      const metaExists = collections.collections.some(c => c.name === QDRANT_METADATA_COLLECTION);
      if (!metaExists) return null;

      const result = await withRetry(() => this.client.retrieve(QDRANT_METADATA_COLLECTION, {
        ids: ['00000000-0000-0000-0000-000000000000'],
        with_payload: true,
      }), this.qdrantUrl);

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
   * Validate that current model dimensions match stored metadata.
   * Logs warning if mismatch but allows startup - query-time text fallback handles mismatched dimensions.
   */
  async validateModelDimensions(currentDimensions: number): Promise<void> {
    const stored = await this.getStoredModelMetadata();
    if (stored && stored.dimensions !== currentDimensions) {
      const warningMsg = [
        `Model dimension mismatch detected (warning only, allowing startup):`,
        `  Stored dimensions: ${stored.dimensions}`,
        `  Current model dimensions: ${currentDimensions}`,
        `  Collection: ${this.activeCollectionName}`,
        ``,
        `Read operations will use text fallback (Qdrant scroll + Fuse.js) for mismatched collections.`,
        `Write operations will use current model dimensions.`,
        ``,
        `To resolve fully, delete and recreate the collection:`,
        `  curl -X DELETE http://localhost:6333/collections/${this.activeCollectionName}`,
      ].join('\n');
      console.warn(warningMsg);
    }
  }

  /**
   * Get all entries from a specific source path with optional sourceType filter.
   * Uses scroll API with pagination for large result sets.
   */
  async getEntriesBySourcePath(sourcePath: string, sourceType?: string): Promise<MemoryEntry[]> {
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

    const filter = { must };

    const entries: MemoryEntry[] = [];
    let scrollId: string | undefined;

    // Paginate through all results
    do {
      const result = await withRetry(() => this.client.scroll(this.activeCollectionName, {
        filter,
        limit: 100,
        offset: scrollId,
        with_payload: true,
        with_vector: false,
      }), this.qdrantUrl);

      entries.push(...result.points.map(p => pointToMemoryEntry(p)));
      scrollId = typeof result.next_page_offset === 'string' ? result.next_page_offset : undefined;
    } while (scrollId);

    return entries;
  }

  /**
   * Get all memories from a specific collection using scroll API with pagination.
   * Includes project isolation filter.
   */
  async scrollCollection(
    collectionName: string = MEMORY_TABLE_NAME,
    limit: number = 100
  ): Promise<MemoryEntry[]> {
    const projectFilter = this.getProjectFilter();
    const filter = projectFilter || undefined;

    const entries: MemoryEntry[] = [];
    let scrollId: string | undefined;

    do {
      const result = await withRetry(() => this.client.scroll(collectionName, {
        filter,
        limit,
        offset: scrollId,
        with_payload: true,
        with_vector: false,
      }), this.qdrantUrl);

      entries.push(...result.points.map(p => pointToMemoryEntry(p)));
      scrollId = typeof result.next_page_offset === 'string' ? result.next_page_offset : undefined;
    } while (scrollId);

    return entries;
  }

  /**
   * Close the database connection and clean up client cache
   */
  async close(): Promise<void> {
    removeClient(this.qdrantUrl);
    this.initialized = false;
    this.connected = false;
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