/**
 * Memory Database Layer
 * 
 * Handles LanceDB operations for memory storage with HNSW indexing.
 */

import { connect, Index, type Connection, type Table } from '@lancedb/lancedb';
import { randomUUID } from 'crypto';
import {
  MEMORY_TABLE_NAME,
  DEFAULT_SEARCH_OPTIONS,
  type MemoryEntry,
  type MemoryEntryInput,
  type SearchOptions,
  type SearchFilter,
  type MemorySourceType,
} from './schema.js';
import { ModelManager } from '../model/index.js';

/**
 * LanceDB connection instance (per-URI)
 */
const connections: Map<string, Connection> = new Map();

/**
 * Cached table reference (per-URI)
 */
const tables: Map<string, Table> = new Map();

/**
 * Track if index has been created for each URI
 */
const indexCreated: Map<string, boolean> = new Map();

/**
 * Model metadata table name
 */
const MODEL_METADATA_TABLE = 'model_metadata';

/**
 * Content hasher using Web Crypto API
 */
async function sha256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * MemoryDatabase class for CRUD operations on memories
 */
export class MemoryDatabase {
  private uri: string;
  private initialized: boolean = false;

  constructor(uri: string = './memory_data') {
    this.uri = uri;
  }

  /**
   * Get the table for this instance
   */
  private getTable(): Table {
    const table = tables.get(this.uri);
    if (!table) {
      throw new Error('Database not initialized. Call initialize() first.');
    }
    return table;
  }

  /**
   * Initialize the LanceDB connection and table
   * Note: We do NOT create the index here - it will be created lazily on first data insertion
   * This avoids the "KMeans: can not train 1 centroids with 0 vectors" error
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const db = await connect(this.uri);
    connections.set(this.uri, db);

    // Create table if it doesn't exist (empty table is fine - index will be created later)
    const tableNames = await db.tableNames();
    if (!tableNames.includes(MEMORY_TABLE_NAME)) {
      // Get the actual embedding dimension from the model (BGE-Large=1024, MiniLM=384)
      const modelManager = ModelManager.getInstance();
      const embeddingDim = modelManager.getDimensions();

      // Create empty table with schema definition
      // Use explicit schema to avoid Arrow type inference issues
      await db.createTable(MEMORY_TABLE_NAME, [
        {
          id: 'temp',
          text: '',
          vector: Array(embeddingDim).fill(0),
          sourceType: 'session',
          sourcePath: '',
          timestamp: new Date(),
          contentHash: '',
          metadataJson: '',
          sessionId: '',
        },
      ]);

      // Delete the temp row - we want an empty table
      // Note: We create with data to get proper schema, then delete
      const tempTable = await db.openTable(MEMORY_TABLE_NAME);
      await tempTable.delete("id = 'temp'");

      // Store model metadata for future validation
      await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
    } else {
      // Table exists - validate model dimensions match
      const modelManager = ModelManager.getInstance();
      const currentDimensions = modelManager.getDimensions();

      // Check stored metadata against current model
      const storedMeta = await this.getStoredModelMetadata();
      if (storedMeta && storedMeta.dimensions !== currentDimensions) {
        // Dimension mismatch - drop and recreate table
        console.warn(`Model dimension mismatch: stored=${storedMeta.dimensions}, current=${currentDimensions}`);
        console.warn('Dropping existing table and recreating with new dimensions...');

        await db.dropTable(MEMORY_TABLE_NAME);

        // Recreate table with correct dimensions
        const embeddingDim = currentDimensions;
        await db.createTable(MEMORY_TABLE_NAME, [
          {
            id: 'temp',
            text: '',
            vector: Array(embeddingDim).fill(0),
            sourceType: 'session',
            sourcePath: '',
            timestamp: new Date(),
            contentHash: '',
            metadataJson: '',
            sessionId: '',
          },
        ]);

        const tempTable = await db.openTable(MEMORY_TABLE_NAME);
        await tempTable.delete("id = 'temp'");

        // Store updated model metadata
        await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
      }
    }

    const memoryTable = await db.openTable(MEMORY_TABLE_NAME);
    tables.set(this.uri, memoryTable);
    indexCreated.set(this.uri, false);
    this.initialized = true;

    // NOTE: We do NOT call ensureIndex() here anymore
    // Index creation is deferred to first addMemory() call
    // This prevents "KMeans: can not train 1 centroids with 0 vectors" error
  }

  /**
   * Ensure HNSW index exists on vector column
   * Called lazily on first data insertion to avoid empty table index error
   */
  async ensureIndex(): Promise<void> {
    const memoryTable = this.getTable();

    // Skip if index already created or table is empty
    if (indexCreated.get(this.uri)) {
      return;
    }

    try {
      const count = await memoryTable.countRows();
      if (count === 0) {
        // Table is empty - skip index creation, will be created on first insert
        return;
      }

      const schema = await memoryTable.schema();
      const vectorField = schema.fields.find(f => f.name === 'vector');

      if (!vectorField) {
        throw new Error('Vector field not found in schema');
      }

      // Create HNSW-SQ index for fast vector search
      await memoryTable.createIndex('vector', {
        config: Index.hnswSq({
          distanceType: 'cosine',
          m: 16,
          efConstruction: 128,
        }),
        replace: true,
      });

      indexCreated.set(this.uri, true);
    } catch (err) {
      // Index creation failed - which might mean it already exists or there's an issue
      // Log warning but continue - the index might be created later
      console.warn('Index creation warning:', err);
    }
  }

  /**
   * Add a new memory entry
   *
   * @returns The ID of the newly created memory
   */
  async addMemory(input: MemoryEntryInput): Promise<string> {
    const memoryTable = this.getTable();

    const id = randomUUID();
    const timestamp = new Date();
    const contentHash = await sha256(input.text);

    // Ensure vector is a regular array for LanceDB compatibility
    const vectorArray = Array.isArray(input.vector)
      ? input.vector
      : Array.from(input.vector);

    const entry = {
      id,
      text: input.text,
      vector: vectorArray,
      sourceType: input.sourceType,
      sourcePath: input.sourcePath ?? '',
      timestamp,
      contentHash,
      metadataJson: input.metadataJson ?? '',
      sessionId: input.sessionId ?? '',
    };

    await memoryTable.add([entry]);

    // Try to create index after first data insertion
    // This is safe because table now has data
    await this.ensureIndex();

    return id;
  }

  /**
   * Get a memory entry by ID
   */
  async getMemory(id: string): Promise<MemoryEntry | null> {
    const memoryTable = this.getTable();

    const results = await memoryTable
      .query()
      .where(`id = '${id}'`)
      .limit(1)
      .toArray();

    if (results.length === 0) {
      return null;
    }

    return this.rowToMemoryEntry(results[0]);
  }

  /**
   * Delete a memory entry by ID
   */
  async deleteMemory(id: string): Promise<void> {
    const memoryTable = this.getTable();

    await memoryTable.delete(`id = '${id}'`);
  }

  /**
   * Query memories by vector similarity
   */
  async queryMemories(
    vector: Float32Array | number[],
    options: SearchOptions = {}
  ): Promise<MemoryEntry[]> {
    const memoryTable = this.getTable();

    const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
    const topK = Math.min(opts.topK ?? 5, 20);

    // Convert vector to array if needed
    const queryVector = Array.isArray(vector) ? vector : Array.from(vector);

    // Build query with vector search
    let query = memoryTable
      .query()
      .nearestTo(queryVector)
      .limit(topK * 2);

    // Apply filters if provided
    if (opts.filter) {
      const conditions: string[] = [];

      if (opts.filter.sourceType) {
        conditions.push(`"sourceType" = '${opts.filter.sourceType}'`);
      }
      if (opts.filter.sessionId) {
        conditions.push(`"sessionId" = '${opts.filter.sessionId}'`);
      }
      if (opts.filter.since) {
        conditions.push(`timestamp >= ${opts.filter.since.getTime()}`);
      }

      if (conditions.length > 0) {
        query = query.where(conditions.join(' AND '));
      }
    }

    const results = await query.toArray();

    // Convert vectors and sort by similarity (nearestTo returns sorted by distance)
    const entries = results.map((r) => this.rowToMemoryEntry(r));

    // Deduplicate by contentHash and return topK
    const seen = new Set<string>();
    const deduped: MemoryEntry[] = [];

    for (const entry of entries) {
      if (!seen.has(entry.contentHash)) {
        seen.add(entry.contentHash);
        deduped.push(entry);
        if (deduped.length >= topK) {
          break;
        }
      }
    }

    return deduped;
  }

  /**
   * List all memories with optional filter
   */
  async listMemories(filter?: SearchFilter): Promise<MemoryEntry[]> {
    const memoryTable = this.getTable();

    let query = memoryTable.query();

    if (filter?.sourceType) {
      query = query.where(`"sourceType" = '${filter.sourceType}'`);
    }
    if (filter?.sessionId) {
      query = query.where(`"sessionId" = '${filter.sessionId}'`);
    }
    if (filter?.since) {
      query = query.where(`timestamp >= ${filter.since.getTime()}`);
    }

    const results = await query.limit(100).toArray();
    return results.map((r) => this.rowToMemoryEntry(r));
  }

  /**
   * Get count of memories
   */
  async countMemories(): Promise<number> {
    const memoryTable = this.getTable();
    return memoryTable.countRows();
  }

  /**
   * Check if content already exists (by hash)
   */
  async contentExists(hash: string): Promise<boolean> {
    const memoryTable = this.getTable();

    const results = await memoryTable
      .query()
      .where(`contentHash = '${hash}'`)
      .limit(1)
      .toArray();

    return results.length > 0;
  }

  /**
   * Convert a database row to a MemoryEntry
   */
  private rowToMemoryEntry(row: Record<string, unknown>): MemoryEntry {
    const vectorData = row.vector;
    let vector: Float32Array;

    if (Array.isArray(vectorData)) {
      vector = new Float32Array(vectorData as number[]);
    } else if (vectorData instanceof Float32Array) {
      vector = vectorData;
    } else if (typeof vectorData === 'object' && vectorData !== null && 'length' in vectorData) {
      // Handle TypedArray-like objects (Buffer, ArrayBufferView, etc.)
      const arr = Array.from(vectorData as unknown as ArrayLike<number>);
      vector = new Float32Array(arr);
    } else {
      throw new Error(`Invalid vector format in database: ${typeof vectorData}`);
    }

    return {
      id: row.id as string,
      text: row.text as string,
      vector,
      sourceType: row.sourceType as MemorySourceType,
      sourcePath: row.sourcePath as string | undefined,
      timestamp: new Date(row.timestamp as string),
      contentHash: row.contentHash as string,
      metadataJson: row.metadataJson as string | undefined,
      sessionId: row.sessionId as string | undefined,
    };
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    const db = connections.get(this.uri);
    if (db) {
      await db.close();
      connections.delete(this.uri);
      tables.delete(this.uri);
      indexCreated.delete(this.uri);
    }
    this.initialized = false;
  }

  /**
   * Store model metadata in the database
   */
  async storeModelMetadata(modelId: string, dimensions: number): Promise<void> {
    const db = connections.get(this.uri);
    if (!db) return;

    // Create metadata table if it doesn't exist
    const tableNames = await db.tableNames();
    if (!tableNames.includes(MODEL_METADATA_TABLE)) {
      await db.createTable(MODEL_METADATA_TABLE, [
        {
          key: 'current',
          modelId,
          dimensions,
          createdAt: new Date(),
        },
      ]);
    } else {
      // Update existing metadata using SQL WHERE clause
      const metaTable = await db.openTable(MODEL_METADATA_TABLE);
      await metaTable.update({
        values: {
          modelId,
          dimensions,
          createdAt: new Date(),
        },
        where: `key = 'current'`,
      });
    }
  }

  /**
   * Retrieve stored model metadata from the database
   * Returns null if no metadata exists (new database)
   */
  async getStoredModelMetadata(): Promise<{ modelId: string; dimensions: number } | null> {
    const db = connections.get(this.uri);
    if (!db) return null;

    try {
      const tableNames = await db.tableNames();
      if (!tableNames.includes(MODEL_METADATA_TABLE)) {
        return null;
      }

      const metaTable = await db.openTable(MODEL_METADATA_TABLE);
      const results = await metaTable.query().where(`key = 'current'`).limit(1).toArray();

      if (results.length === 0) {
        return null;
      }

      return {
        modelId: results[0].modelId as string,
        dimensions: results[0].dimensions as number,
      };
    } catch {
      return null;
    }
  }

  /**
   * Validate that current model dimensions match stored metadata
   * Throws error if there's a mismatch
   */
  async validateModelDimensions(currentDimensions: number): Promise<void> {
    const stored = await this.getStoredModelMetadata();
    if (stored && stored.dimensions !== currentDimensions) {
      const errorMsg = [
        `Model dimension mismatch detected!`,
        `  Stored dimensions: ${stored.dimensions}`,
        `  Current model dimensions: ${currentDimensions}`,
        `  This means the database was created with a different embedding model.`,
        ``,
        `To fix this, delete the database directory and restart:`,
        `  rm -rf ./memory_data`,
        ``,
        `Or specify a different database path via MEMORY_DB_PATH environment variable.`,
      ].join('\n');
      throw new Error(errorMsg);
    }
  }
}

/**
 * Database instances cache (per-URI)
 */
const databaseInstances: Map<string, MemoryDatabase> = new Map();

/**
 * Get a database instance for the given URI
 * Creates a new instance if one doesn't exist for this URI
 */
export function getDatabase(uri?: string): MemoryDatabase {
  const dbPath = uri || './memory_data';

  if (!databaseInstances.has(dbPath)) {
    databaseInstances.set(dbPath, new MemoryDatabase(dbPath));
  }
  return databaseInstances.get(dbPath)!;
}

/**
 * Initialize the default database
 */
export async function initializeDatabase(uri?: string): Promise<void> {
  const db = getDatabase(uri);
  await db.initialize();
}
