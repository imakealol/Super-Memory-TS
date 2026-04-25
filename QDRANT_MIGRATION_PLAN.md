# Super-Memory-TS v2.0.0: LanceDB → Qdrant Migration Plan

**Status**: Design Complete — Ready for Implementation  
**Target Version**: `2.0.0` (breaking change: backend storage engine swap)  
**Date**: 2026-04-24

---

## 1. Executive Summary

Replace `@lancedb/lancedb` with `@qdrant/js-client-rest` as the vector storage backend. The migration preserves **100% of the public API** (`MemoryDatabase`, `MemorySearch`, `MemorySystem`) while eliminating LanceDB-specific pain points: global write locks, commit conflicts, manual HNSW index management, and SQL-based filtering.

**Concept Mapping**:

| LanceDB | Qdrant |
|---------|--------|
| `Table` | `Collection` (named `"memories"`) |
| `Column` | `Payload` field |
| `vector` column | Default vector config (cosine distance) |
| `table.add()` | `client.upsert()` |
| `table.query().where()` | `client.search()` / `client.scroll()` with `filter` |
| `table.delete()` | `client.delete()` by IDs or filter |
| `table.countRows()` | `client.count()` |
| Manual HNSW index creation | Built into collection creation config |
| SQL WHERE clauses | Qdrant `Filter` (`must` / `should` / `must_not`) |
| Connection + Table caching | `QdrantClient` instance caching (HTTP client) |

---

## 2. Dependency Changes

### `package.json`

```diff
   "dependencies": {
-    "@lancedb/lancedb": "^0.11.0",
+    "@qdrant/js-client-rest": "^1.17.0",
     "@modelcontextprotocol/sdk": "^1.0.0",
```

**Rationale**: `@qdrant/js-client-rest` is the official TypeScript client. Version `^1.17.0` aligns with Qdrant server v1.17.x. The client is lightweight (REST over HTTP) and ESM-compatible.

**Post-install requirement**: Users must have a Qdrant instance running. For local dev:

```bash
docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

---

## 3. Files That Change

| File | Change Type | Notes |
|------|-------------|-------|
| `src/memory/database.ts` | **Full rewrite** | Replace LanceDB with Qdrant client calls |
| `src/memory/schema.ts` | **Moderate** | Remove `HNSW_CONFIG`, add `QDRANT_COLLECTION_NAME`, `DEFAULT_QDRANT_URL` |
| `src/memory/search.ts` | **Minimal** | Update comments (no code changes — same `db.queryMemories()` contract) |
| `src/memory/index.ts` | **Minimal** | Update comments referencing LanceDB |
| `src/project-index/indexer.ts` | **Minimal** | Remove `"lancedb"` from `SKIP_DIRS` |
| `src/project-index/snapshot.ts` | **Minimal** | Remove `"lancedb"` from ignore patterns |
| `package.json` | **Minimal** | Swap dependency |
| `AGENTS.md` | **Minimal** | Update backend reference |
| `tests/` | **TBD** | May need Qdrant mock or Docker-in-test setup |

---

## 4. `schema.ts` Changes

### Remove

```typescript
// REMOVE these LanceDB-specific constants
export const HNSW_CONFIG = {
  type: 'hnsw',
  m: 16,
  efConstruction: 128,
  efSearch: 64,
  distanceType: 'cosine',
} as const;
```

### Add

```typescript
/**
 * Qdrant collection name for memory points
 */
export const QDRANT_COLLECTION_NAME = 'memories';

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
  efConstruct: 128,
  fullScanThreshold: 10000,
} as const;

/**
 * Payload field names used for indexing and filtering
 */
export const PAYLOAD_FIELDS = {
  text: 'text',
  sourceType: 'sourceType',
  sourcePath: 'sourcePath',
  timestamp: 'timestamp',
  contentHash: 'contentHash',
  metadataJson: 'metadataJson',
  sessionId: 'sessionId',
} as const;
```

**Keep**: `MEMORY_TABLE_NAME` (still used as collection name), all interfaces (`MemoryEntry`, `MemoryEntryInput`, `SearchOptions`, `SearchFilter`, etc.).

---

## 5. `database.ts` Refactoring

### 5.1 Imports

```typescript
import { QdrantClient, type Schemas } from '@qdrant/js-client-rest';
import { randomUUID, createHash } from 'crypto';
import {
  MEMORY_TABLE_NAME,
  QDRANT_METADATA_COLLECTION,
  DEFAULT_QDRANT_URL,
  QDRANT_HNSW_CONFIG,
  PAYLOAD_FIELDS,
  type MemoryEntry,
  type MemoryEntryInput,
  type SearchOptions,
  type SearchFilter,
  type MemorySourceType,
} from './schema.js';
import { ModelManager } from '../model/index.js';
import { generateEmbeddings } from '../model/embeddings.js';
```

**Remove**: All `@lancedb/lancedb` imports, `resolve` from `path`, connection/table caches, global write queues, `indexCreated` map, `connectionRefCount` map.

### 5.2 Client Caching

QdrantClient is a lightweight HTTP client — no connection pooling issues. Cache by URL for reuse:

```typescript
const clients: Map<string, QdrantClient> = new Map();

function getClient(url: string): QdrantClient {
  if (!clients.has(url)) {
    clients.set(url, new QdrantClient({ url }));
  }
  return clients.get(url)!;
}
```

**Remove**: `connections`, `tables`, `indexCreated`, `connectionRefCount`, `globalWriteQueues`, `getGlobalQueue`, `setGlobalQueue`, `enqueueWrite`.

### 5.3 Class Signature

```typescript
export class MemoryDatabase {
  private url: string;
  private initialized: boolean = false;
  private client: QdrantClient;

  constructor(url: string = DEFAULT_QDRANT_URL) {
    this.url = url;
    this.client = getClient(url);
  }

  // ... methods
}
```

The `uri` parameter semantics change: it's now a Qdrant HTTP URL (`http://localhost:6333`) instead of a local filesystem path (`./memory_data`). Callers passing paths will need updating, but the `getDatabase()` default remains workable if we treat the default as the Qdrant URL.

### 5.4 Collection Initialization (`initialize()`)

```typescript
async initialize(): Promise<void> {
  if (this.initialized) return;

  const modelManager = ModelManager.getInstance();
  const embeddingDim = modelManager.getDimensions();

  // Check if collection exists
  const exists = await this.client.collectionExists(MEMORY_TABLE_NAME);

  if (!exists.exists) {
    // Create collection with vector config
    await this.client.createCollection(MEMORY_TABLE_NAME, {
      vectors: {
        size: embeddingDim,
        distance: 'Cosine',
        hnsw_config: QDRANT_HNSW_CONFIG,
      },
    });

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
```

**Key differences from LanceDB**:
- No temp-row hack needed. Qdrant creates collections empty by design.
- HNSW is configured at collection creation time — no deferred index creation.
- Payload indexes are created explicitly for filter performance.

### 5.5 Model Metadata (simplified)

Use a dedicated `model_metadata` collection with a single point:

```typescript
async storeModelMetadata(modelId: string, dimensions: number): Promise<void> {
  const exists = await this.client.collectionExists(QDRANT_METADATA_COLLECTION);
  if (!exists.exists) {
    await this.client.createCollection(QDRANT_METADATA_COLLECTION, {
      vectors: { size: 1, distance: 'Cosine' }, // Dummy vector config
    });
  }

  await this.client.upsert(QDRANT_METADATA_COLLECTION, {
    points: [{
      id: 'current',
      vector: [0],
      payload: { modelId, dimensions, updatedAt: Date.now() },
    }],
  });
}

async getStoredModelMetadata(): Promise<{ modelId: string; dimensions: number } | null> {
  try {
    const exists = await this.client.collectionExists(QDRANT_METADATA_COLLECTION);
    if (!exists.exists) return null;

    const result = await this.client.retrieve(QDRANT_METADATA_COLLECTION, {
      ids: ['current'],
      with_payload: true,
    });

    if (result.length === 0 || !result[0].payload) return null;

    return {
      modelId: result[0].payload.modelId as string,
      dimensions: result[0].payload.dimensions as number,
    };
  } catch {
    return null;
  }
}

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
```

### 5.6 Payload Filter Builder

Central helper for converting `SearchFilter` → Qdrant `Filter`:

```typescript
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
```

### 5.7 Point ↔ MemoryEntry Mapping

```typescript
/**
 * Convert MemoryEntryInput + generated fields → Qdrant PointStruct
 */
private toPoint(
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
private pointToMemoryEntry(point: Schemas['ScoredPoint'] | Schemas['Record']): MemoryEntry {
  const payload = point.payload ?? {};

  // Vector may be number[] (default vector) or Record<string, number[]> (named vectors)
  let vector: Float32Array;
  if (Array.isArray(point.vector)) {
    vector = new Float32Array(point.vector);
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
```

### 5.8 Method-by-Method Mapping

#### `addMemories(entries)`

```typescript
async addMemories(entries: MemoryEntryInput[]): Promise<MemoryEntry[]> {
  const timestamp = Date.now();
  const timestampISO = new Date(timestamp).toISOString();

  const texts = entries.map(e => e.text);
  const embeddingResults = await generateEmbeddings(texts);

  const points = entries.map((entry, idx) => {
    const contentHash = computeHash(entry.text);
    const id = randomUUID();
    return this.toPoint(id, embeddingResults[idx].embedding, entry, timestamp, contentHash);
  });

  await this.client.upsert(MEMORY_TABLE_NAME, { points });

  return points.map(p => this.pointToMemoryEntry({
    ...p,
    payload: p.payload as Record<string, unknown>,
  } as Schemas['ScoredPoint']));
}
```

**Removed**: `enqueueWrite()` wrapper — Qdrant handles concurrent writes safely.

#### `addMemory(input)`

```typescript
async addMemory(input: MemoryEntryInput): Promise<string> {
  const id = randomUUID();
  const timestamp = Date.now();
  const contentHash = computeHash(input.text);

  const vector = input.vector
    ? Array.isArray(input.vector) ? input.vector : Array.from(input.vector)
    : (await generateEmbeddings([input.text]))[0].embedding;

  const point = this.toPoint(id, vector, input, timestamp, contentHash);
  await this.client.upsert(MEMORY_TABLE_NAME, { points: [point] });

  return id;
}
```

#### `getMemory(id)`

```typescript
async getMemory(id: string): Promise<MemoryEntry | null> {
  const results = await this.client.retrieve(MEMORY_TABLE_NAME, {
    ids: [id],
    with_payload: true,
    with_vector: true,
  });

  if (results.length === 0) return null;
  return this.pointToMemoryEntry(results[0]);
}
```

#### `deleteMemory(id)`

```typescript
async deleteMemory(id: string): Promise<void> {
  await this.client.delete(MEMORY_TABLE_NAME, {
    points: [id],
  });
}
```

#### `deleteBySourcePath(sourcePath, sourceType?)`

**Massive improvement**: Single Qdrant filter delete instead of query-then-loop-delete.

```typescript
async deleteBySourcePath(sourcePath: string, sourceType?: string): Promise<number> {
  const filter: Record<string, unknown> = {
    must: [
      { key: PAYLOAD_FIELDS.sourcePath, match: { value: sourcePath } },
    ],
  };

  if (sourceType) {
    filter.must.push({
      key: PAYLOAD_FIELDS.sourceType,
      match: { value: sourceType },
    });
  }

  // Count before delete (for return value)
  const countResult = await this.client.count(MEMORY_TABLE_NAME, {
    filter,
    exact: true,
  });

  await this.client.delete(MEMORY_TABLE_NAME, { filter });

  return countResult.count;
}
```

#### `queryMemories(vector, options)`

```typescript
async queryMemories(
  vector: Float32Array | number[],
  options: SearchOptions = {}
): Promise<MemoryEntry[]> {
  const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
  const topK = Math.min(opts.topK ?? 5, 20);
  const queryVector = Array.isArray(vector) ? vector : Array.from(vector);
  const filter = buildPayloadFilter(opts.filter);

  const results = await this.client.search(MEMORY_TABLE_NAME, {
    vector: queryVector,
    limit: topK * 2,
    filter,
    with_payload: true,
    with_vector: true,
  });

  // Deduplicate by contentHash and return topK
  const seen = new Set<string>();
  const deduped: MemoryEntry[] = [];

  for (const result of results) {
    const entry = this.pointToMemoryEntry(result);
    if (!seen.has(entry.contentHash)) {
      seen.add(entry.contentHash);
      deduped.push(entry);
      if (deduped.length >= topK) break;
    }
  }

  return deduped;
}
```

**Note**: Qdrant returns results sorted by **cosine similarity** (score descending, 1.0 = identical). LanceDB returned cosine **distance** (ascending, 0.0 = identical). The deduped results are still "best first" so no consumer-visible change. If any code compares raw scores, it needs updating (none currently does in this codebase).

#### `listMemories(filter?)`

```typescript
async listMemories(filter?: SearchFilter): Promise<MemoryEntry[]> {
  const qdrantFilter = buildPayloadFilter(filter);

  const results = await this.client.scroll(MEMORY_TABLE_NAME, {
    filter: qdrantFilter,
    limit: 100,
    with_payload: true,
    with_vector: true,
  });

  return results.points.map(p => this.pointToMemoryEntry(p));
}
```

#### `countMemories()`

```typescript
async countMemories(): Promise<number> {
  const result = await this.client.count(MEMORY_TABLE_NAME, { exact: true });
  return result.count;
}
```

#### `contentExists(hash)`

```typescript
async contentExists(hash: string): Promise<boolean> {
  const result = await this.client.count(MEMORY_TABLE_NAME, {
    filter: {
      must: [{ key: PAYLOAD_FIELDS.contentHash, match: { value: hash } }],
    },
    exact: true,
  });
  return result.count > 0;
}
```

#### `close()`

```typescript
async close(): Promise<void> {
  // QdrantClient is stateless HTTP — no explicit close needed.
  // Just clear initialization state so re-init is possible.
  this.initialized = false;
}
```

**Remove**: Reference counting logic entirely. Qdrant client is cheap to recreate.

---

## 6. `indexer.ts` & `snapshot.ts` Changes

Remove `"lancedb"` from skip lists (no longer relevant as a directory to ignore):

```diff
// indexer.ts
- const SKIP_DIRS = new Set(['lancedb', 'node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);
+ const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '__pycache__']);

// snapshot.ts (line 71)
- ignore: ['node_modules/**', '.git/**', 'dist/**', '*.log', '.DS_Store', '**/*.db', '**/*.har', '**/*.tmp', '**/lancedb/**']
+ ignore: ['node_modules/**', '.git/**', 'dist/**', '*.log', '.DS_Store', '**/*.db', '**/*.har', '**/*.tmp']
```

---

## 7. Public API Contract Preservation

The following exports from `src/memory/index.ts` remain **unchanged** in signature and behavior:

| Export | Type | Status |
|--------|------|--------|
| `MemoryDatabase` | Class | ✅ Preserved |
| `getDatabase(uri?)` | Function | ✅ Preserved (uri now interpreted as URL) |
| `initializeDatabase(uri?)` | Function | ✅ Preserved |
| `MemorySearch` | Class | ✅ Preserved |
| `getSearch(db?)` | Function | ✅ Preserved |
| `initializeSearch(dbUri?)` | Function | ✅ Preserved |
| `MemorySystem` | Class | ✅ Preserved |
| `createMemorySystem()` | Function | ✅ Preserved |
| `getMemorySystem()` | Function | ✅ Preserved |
| `resetMemorySystem()` | Function | ✅ Preserved |
| All schema types/interfaces | Type | ✅ Preserved |

**Behavioral changes** (document in CHANGELOG):
1. `uri` parameter is now a Qdrant HTTP URL, not a filesystem path.
2. No more LanceDB `memory_data` directory. Qdrant storage is server-managed.
3. `close()` no longer performs reference-counted connection teardown.
4. Slightly different distance semantics internally (similarity vs distance), but results are still best-first.

---

## 8. Configuration & Environment

Add to `src/config.ts` (or create if not exists):

```typescript
/**
 * Qdrant connection URL
 * @default 'http://localhost:6333'
 */
export const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
```

**Consumers** (e.g., `bin/super-memory-ts.cjs`, `src/server.ts`) should pass `QDRANT_URL` when constructing `MemoryDatabase`.

---

## 9. Testing Strategy

### Unit Tests

Mock `QdrantClient` using Vitest mocks:

```typescript
vi.mock('@qdrant/js-client-rest', () => ({
  QdrantClient: vi.fn().mockImplementation(() => ({
    collectionExists: vi.fn().mockResolvedValue({ exists: false }),
    createCollection: vi.fn().mockResolvedValue(true),
    createPayloadIndex: vi.fn().mockResolvedValue(true),
    upsert: vi.fn().mockResolvedValue({ status: 'completed' }),
    search: vi.fn().mockResolvedValue([]),
    scroll: vi.fn().mockResolvedValue({ points: [], next_page_offset: null }),
    retrieve: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue({ status: 'completed' }),
    count: vi.fn().mockResolvedValue({ count: 0 }),
  })),
}));
```

### Integration Tests

Use `testcontainers` or require a local Qdrant Docker instance:

```bash
# In CI or local dev
docker run -d --name qdrant-test -p 6333:6333 qdrant/qdrant
QDRANT_URL=http://localhost:6333 npm test
```

---

## 10. Rollback Plan

If critical issues arise post-migration:

1. **Revert commit**: The migration is a single atomic change set.
2. **Data migration**: LanceDB data in `./memory_data` is untouched by Qdrant (different paths). Users can downgrade to v1.x and retain existing memories.
3. **Dual-write period** (if needed for zero-downtime): Not applicable for a library package; consumers pin versions.

---

## 11. Implementation Checklist

- [ ] Update `package.json` dependencies
- [ ] Run `npm install`
- [ ] Update `src/memory/schema.ts`
- [ ] Rewrite `src/memory/database.ts`
- [ ] Update `src/memory/search.ts` comments
- [ ] Update `src/memory/index.ts` comments
- [ ] Update `src/project-index/indexer.ts` skip dirs
- [ ] Update `src/project-index/snapshot.ts` ignore patterns
- [ ] Add `QDRANT_URL` config / env var handling
- [ ] Update `AGENTS.md`
- [ ] Update `CHANGELOG.md` with breaking changes
- [ ] Bump version to `2.0.0` in `package.json`
- [ ] Add/update unit tests with mocked Qdrant client
- [ ] Run `npm run typecheck`
- [ ] Run `npm run build`
- [ ] Run `npm run test`
- [ ] Test with local Qdrant Docker instance
- [ ] Tag and release `v2.0.0`

---

## 12. Appendix: Full `database.ts` Skeleton for Coder

```typescript
/**
 * Memory Database Layer
 *
 * Handles Qdrant operations for memory storage with HNSW indexing.
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

// --- Helpers ---

function computeHash(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

function buildPayloadFilter(filter?: SearchFilter): Record<string, unknown> | undefined {
  // ... (see section 5.6)
}

// --- Client Cache ---

const clients: Map<string, QdrantClient> = new Map();

function getClient(url: string): QdrantClient {
  if (!clients.has(url)) {
    clients.set(url, new QdrantClient({ url }));
  }
  return clients.get(url)!;
}

// --- Database Class ---

export class MemoryDatabase {
  private url: string;
  private initialized: boolean = false;
  private client: QdrantClient;

  constructor(url: string = DEFAULT_QDRANT_URL) {
    this.url = url;
    this.client = getClient(url);
  }

  async initialize(): Promise<void> { /* ... */ }
  async addMemories(entries: MemoryEntryInput[]): Promise<MemoryEntry[]> { /* ... */ }
  async addMemory(input: MemoryEntryInput): Promise<string> { /* ... */ }
  async getMemory(id: string): Promise<MemoryEntry | null> { /* ... */ }
  async deleteMemory(id: string): Promise<void> { /* ... */ }
  async deleteBySourcePath(sourcePath: string, sourceType?: string): Promise<number> { /* ... */ }
  async queryMemories(vector: Float32Array | number[], options?: SearchOptions): Promise<MemoryEntry[]> { /* ... */ }
  async listMemories(filter?: SearchFilter): Promise<MemoryEntry[]> { /* ... */ }
  async countMemories(): Promise<number> { /* ... */ }
  async contentExists(hash: string): Promise<boolean> { /* ... */ }
  async close(): Promise<void> { /* ... */ }
  async validateModelDimensions(currentDimensions: number): Promise<void> { /* ... */ }

  // Private helpers
  private async createPayloadIndexes(): Promise<void> { /* ... */ }
  private async storeModelMetadata(modelId: string, dimensions: number): Promise<void> { /* ... */ }
  private async getStoredModelMetadata(): Promise<{ modelId: string; dimensions: number } | null> { /* ... */ }
  private toPoint(id: string, vector: number[], entry: MemoryEntryInput, timestamp: number, contentHash: string): Schemas['PointStruct'] { /* ... */ }
  private pointToMemoryEntry(point: Schemas['ScoredPoint'] | Schemas['Record']): MemoryEntry { /* ... */ }
}

// --- Singletons ---

const databaseInstances: Map<string, MemoryDatabase> = new Map();

export function getDatabase(url?: string): MemoryDatabase {
  const key = url || DEFAULT_QDRANT_URL;
  if (!databaseInstances.has(key)) {
    databaseInstances.set(key, new MemoryDatabase(key));
  }
  return databaseInstances.get(key)!;
}

export async function initializeDatabase(url?: string): Promise<void> {
  const db = getDatabase(url);
  await db.initialize();
}
```

---

*End of Migration Plan*
