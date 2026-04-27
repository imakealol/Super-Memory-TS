# Implementation Plan: Per-Project Memory Isolation

## Overview

Add per-project memory isolation to Super-Memory-TS using Qdrant's recommended payload-based multitenancy approach. A single `memories` collection with a `project_id` payload field for filtering.

**Approach**: Qdrant payload-based multitenancy (recommended over separate collections)
**Backward Compatibility**: Existing memories without `project_id` remain accessible via `is_empty` OR-match filter
**Default Behavior**: Auto-generates `project_id` from `BOOMERANG_PROJECT_ID` env var or `basename(process.cwd())`

---

## 1. Schema Changes (`src/memory/schema.ts`)

### Changes Required

1. **Add `projectId` to `MemoryEntry` interface:**
   ```typescript
   export interface MemoryEntry {
     id: string;
     text: string;
     vector: Float32Array;
     sourceType: MemorySourceType;
     sourcePath?: string;
     timestamp: Date;
     contentHash: string;
     metadataJson?: string;
     sessionId?: string;
     score?: number;
     projectId?: string;  // NEW
   }
   ```

2. **Add `projectId` to `PAYLOAD_FIELDS`:**
   ```typescript
   export const PAYLOAD_FIELDS = {
     text: 'text',
     content: 'content',
     sourceType: 'sourceType',
     sourcePath: 'sourcePath',
     timestamp: 'timestamp',
     contentHash: 'contentHash',
     metadataJson: 'metadataJson',
     sessionId: 'sessionId',
     projectId: 'projectId',  // NEW
   } as const;
   ```

3. **Add `projectId` to `SearchFilter` (optional override):**
   ```typescript
   export interface SearchFilter {
     sourceType?: MemorySourceType;
     sessionId?: string;
     since?: Date;
     projectId?: string;  // NEW - for explicit cross-project queries
   }
   ```

---

## 2. Configuration (`src/config.ts`)

### Changes Required

1. **Add `BOOMERANG_PROJECT_ID` to `ENV_VARS`:**
   ```typescript
   export const ENV_VARS = {
     // ... existing vars ...
     BOOMERANG_PROJECT_ID: 'BOOMERANG_PROJECT_ID',
   } as const;
   ```

2. **Add `projectId` to `DatabaseConfig`:**
   ```typescript
   export interface DatabaseConfig {
     dbPath?: string;
     qdrantUrl?: string;
     tableName: string;
     projectId?: string;  // NEW - undefined = no isolation
   }
   ```

3. **Add project ID generation functions:**
   ```typescript
   /**
    * Generate a sanitized project ID from environment or current directory
    */
   export function generateProjectId(): string | undefined {
     const envId = process.env.BOOMERANG_PROJECT_ID;
     if (envId === '') return undefined;  // Explicitly disabled
     if (envId) return sanitizeProjectId(envId);
     try {
       return sanitizeProjectId(basename(process.cwd()));
     } catch {
       return undefined;
     }
   }

   /**
    * Sanitize a project ID: lowercase, alphanumeric + hyphens only
    */
   function sanitizeProjectId(id: string): string {
     return id
       .toLowerCase()
       .replace(/[^a-z0-9-]/g, '-')
       .replace(/-+/g, '-')
       .replace(/^-|-$/g, '');
   }
   ```

4. **Update `parseEnvConfig()`:**
   ```typescript
   database: {
     qdrantUrl: process.env[ENV_VARS.QDRANT_URL] || process.env[ENV_VARS.BOOMERANG_DB_PATH] || DEFAULT_CONFIG.database.qdrantUrl,
     tableName: DEFAULT_CONFIG.database.tableName,
     projectId: generateProjectId(),  // NEW
   },
   ```

5. **Update `loadJsonConfig()` to read `database.projectId`:**
   ```typescript
   database: json.database ? {
     qdrantUrl: json.database.qdrantUrl || json.database.dbPath || DEFAULT_CONFIG.database.qdrantUrl,
     tableName: json.database.tableName || DEFAULT_CONFIG.database.tableName,
     projectId: json.database.projectId || DEFAULT_CONFIG.database.projectId,
   } : undefined,
   ```

---

## 3. Database Layer (`src/memory/database.ts`)

### Changes Required

1. **Add `projectId` to constructor:**
   ```typescript
   export class MemoryDatabase {
     private initialized: boolean = false;
     private client: QdrantClient;
     private qdrantUrl: string;
     private projectId?: string;  // NEW

     constructor(url: string = DEFAULT_QDRANT_URL, projectId?: string) {
       this.qdrantUrl = url;
       this.client = getClient(url);
       this.projectId = projectId;
     }
   ```

2. **Add `getProjectFilter()` helper:**
   ```typescript
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
   ```

3. **Refactor `buildPayloadFilter()` into `buildFilter()` method:**
   ```typescript
   /**
    * Build Qdrant filter from SearchFilter, including project isolation
    */
   private buildFilter(filter?: SearchFilter): Record<string, unknown> | undefined {
     const conditions: Record<string, unknown>[] = [];

     // Project isolation filter (with backward compat for legacy data)
     const projectFilter = this.getProjectFilter();
     if (projectFilter) {
       conditions.push(projectFilter);
     }

     // User-provided filters
     if (filter?.sourceType) {
       conditions.push({
         key: PAYLOAD_FIELDS.sourceType,
         match: { value: filter.sourceType },
       });
     }

     if (filter?.sessionId) {
       conditions.push({
         key: PAYLOAD_FIELDS.sessionId,
         match: { value: filter.sessionId },
       });
     }

     if (filter?.since) {
       conditions.push({
         key: PAYLOAD_FIELDS.timestamp,
         range: { gte: filter.since.getTime() },
       });
     }

     if (conditions.length === 0) return undefined;
     if (conditions.length === 1) return conditions[0];
     return { must: conditions };
   }
   ```

4. **Update `toPoint()` to include `projectId`:**
   ```typescript
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
   ```

5. **Update `pointToMemoryEntry()` to read `projectId`:**
   ```typescript
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
   ```

6. **Update `initialize()` to create project index for existing collections:**
   ```typescript
   async initialize(): Promise<void> {
     if (this.initialized) return;

     // Health check...

     const collections = await withRetry(() => this.client.getCollections());
     const exists = collections.collections.some(c => c.name === MEMORY_TABLE_NAME);

     if (!exists) {
       // Create collection...
       await withRetry(() => this.client.createCollection(MEMORY_TABLE_NAME, {
         vectors: { size: embeddingDim, distance: 'Cosine' },
         hnsw_config: QDRANT_HNSW_CONFIG,
       }));

       await this.createPayloadIndexes();
       await this.storeModelMetadata(modelManager.getMetadata().modelId, embeddingDim);
     } else {
       await this.validateModelDimensions(embeddingDim);
       // Ensure project_id index exists for existing collections
       await this.ensureProjectIdIndex();
     }

     this.initialized = true;
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
       logger.warn('Project ID payload index warning:', err);
     }
   }
   ```

7. **Update `createPayloadIndexes()` to include `projectId`:**
   ```typescript
   private async createPayloadIndexes(): Promise<void> {
     const indexFields = [
       { field: PAYLOAD_FIELDS.sourceType, type: 'keyword' as const },
       { field: PAYLOAD_FIELDS.sourcePath, type: 'keyword' as const },
       { field: PAYLOAD_FIELDS.sessionId, type: 'keyword' as const },
       { field: PAYLOAD_FIELDS.contentHash, type: 'keyword' as const },
       { field: PAYLOAD_FIELDS.timestamp, type: 'integer' as const },
       { field: PAYLOAD_FIELDS.projectId, type: 'keyword' as const },  // NEW
     ];
     // ... rest unchanged
   }
   ```

8. **Update `addMemories()` to pass `projectId` to `toPoint()`:**
   ```typescript
   async addMemories(entries: MemoryEntryInput[]): Promise<MemoryEntry[]> {
     const timestamp = Date.now();
     const texts = entries.map(e => e.text);
     const embeddingResults = await generateEmbeddings(texts);

     const points = entries.map((entry, idx) => {
       const contentHash = computeHash(entry.text);
       const id = randomUUID();
       return toPoint(id, embeddingResults[idx].embedding, entry, timestamp, contentHash, this.projectId);
     });

     await withRetry(() => this.client.upsert(MEMORY_TABLE_NAME, { points }));
     return points.map(p => pointToMemoryEntry({ ...p, payload: p.payload as Record<string, unknown> } as Schemas['ScoredPoint']));
   }
   ```

9. **Update `addMemory()` to pass `projectId` to `toPoint()`:**
   ```typescript
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
   ```

10. **Update `queryMemories()` to use `buildFilter()`:**
    ```typescript
    async queryMemories(
      vector: Float32Array | number[],
      options: SearchOptions = {}
    ): Promise<MemoryEntry[]> {
      const opts = { ...DEFAULT_SEARCH_OPTIONS, ...options };
      const topK = Math.min(opts.topK ?? 5, 20);
      const queryVector = Array.isArray(vector) ? vector : Array.from(vector);
      const filter = this.buildFilter(opts.filter);  // CHANGED: was buildPayloadFilter(opts.filter)

      const results = await withRetry(() => this.client.search(MEMORY_TABLE_NAME, {
        vector: queryVector,
        limit: topK * 2,
        filter,
        with_payload: true,
        with_vector: false,
      }));

      // Deduplication logic unchanged...
    }
    ```

11. **Update `listMemories()` to use `buildFilter()`:**
    ```typescript
    async listMemories(filter?: SearchFilter): Promise<MemoryEntry[]> {
      const qdrantFilter = this.buildFilter(filter);  // CHANGED

      const results = await withRetry(() => this.client.scroll(MEMORY_TABLE_NAME, {
        filter: qdrantFilter,
        limit: 100,
        with_payload: true,
        with_vector: false,
      }));

      return results.points.map(p => pointToMemoryEntry(p));
    }
    ```

12. **Update `countMemories()` to filter by project:**
    ```typescript
    async countMemories(): Promise<number> {
      const filter = this.buildFilter(undefined);
      const result = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, {
        filter,
        exact: true,
      }));
      return result.count;
    }
    ```

13. **Update `contentExists()` to filter by project:**
    ```typescript
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
    ```

14. **Update `deleteBySourcePath()` to filter by project:**
    ```typescript
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

      const countResult = await withRetry(() => this.client.count(MEMORY_TABLE_NAME, {
        filter,
        exact: true,
      }));

      await withRetry(() => this.client.delete(MEMORY_TABLE_NAME, { filter }));

      return countResult.count;
    }
    ```

15. **Update `getDatabase()` to accept `projectId`:**
    ```typescript
    export function getDatabase(url?: string, projectId?: string): MemoryDatabase {
      const key = url || DEFAULT_QDRANT_URL;
      if (!databaseInstances.has(key)) {
        const effectiveProjectId = projectId ?? getConfig().database.projectId;
        databaseInstances.set(key, new MemoryDatabase(key, effectiveProjectId));
      }
      return databaseInstances.get(key)!;
    }
    ```

---

## 4. Search Layer (`src/memory/search.ts`)

### Changes Required

**Minimal changes** - the database layer handles all project filtering. The `MemorySearch` class delegates to `MemoryDatabase`, which now applies project filters automatically.

1. **Constructor remains unchanged** - it receives a `MemoryDatabase` instance that already has `projectId` configured:
   ```typescript
   constructor(db?: MemoryDatabase) {
     this.db = db ?? getDatabase();
   }
   ```

2. **`ensureFuseIndex()`** builds the Fuse index from `this.db.listMemories()`. Since `listMemories()` is now filtered by project, the Fuse index naturally contains only the current project's memories (plus legacy data).

3. **All search methods** (`query`, `searchWithVector`, `getSimilar`) call database methods that already apply project filters. No changes needed.

---

## 5. MemorySystem (`src/memory/index.ts`)

### Changes Required

1. **Update constructor to use `getDatabase()` and accept `projectId`:**
   ```typescript
   export class MemorySystem {
     private db: MemoryDatabase;
     private search: MemorySearch;
     private initialized: boolean = false;
     private initializing: boolean = false;
     private initPromise: Promise<void> | null = null;

     constructor(db?: MemoryDatabase, search?: MemorySearch, config?: { dbUri?: string; projectId?: string }) {
       this.db = db ?? getDatabase(config?.dbUri, config?.projectId);  // CHANGED
       this.search = search ?? new MemorySearch(this.db);
     }
     // ... rest unchanged
   }
   ```

2. **Update `getMemorySystem()` config parameter:**
   ```typescript
   export function getMemorySystem(config?: { dbUri?: string; projectId?: string }): MemorySystem {
     if (!defaultMemorySystem) {
       defaultMemorySystem = new MemorySystem(undefined, undefined, config);
     }
     return defaultMemorySystem;
   }
   ```

3. **Add `getDatabase()` accessor for server/indexer sharing:**
   ```typescript
   /**
    * Get the underlying database instance (for sharing with indexer)
    */
   getDatabase(): MemoryDatabase {
     return this.db;
   }
   ```

---

## 6. Server (`src/server.ts`)

### Changes Required

1. **Store database instance as class property and create with `projectId`:**
   ```typescript
   export class SuperMemoryServer {
     private server: McpServer;
     private context: {
       memory: MemorySystem;
       indexer: ProjectIndexer | null;
     };
     private config: Config;
     private db: MemoryDatabase;  // NEW
     private initialized: boolean = false;
     private initError: Error | null = null;

     constructor(config?: Config) {
       this.config = config || loadConfigSync();
       this.validateConfig();

       // Create database with projectId and share with memory system and indexer
       this.db = getDatabase(
         this.config.database.qdrantUrl || this.config.database.dbPath,
         this.config.database.projectId
       );

       this.context = {
         memory: new MemorySystem(this.db),  // CHANGED
         indexer: null,
       };

       // Create MCP server...
     }
   ```

2. **Pass database to indexer in `start()`: **
   ```typescript
   async start(): Promise<void> {
     // ... memory system initialization ...

     // Initialize project indexer (non-critical)
     try {
       if (this.config.indexer && this.config.indexer.chunkSize) {
         this.context.indexer = new ProjectIndexer({
           rootPath: process.env.BOOMERANG_ROOT_PATH || process.cwd(),
           includePatterns: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.py', '**/*.md'],
           excludePatterns: this.config.indexer.excludePatterns || ['node_modules', '.git', 'dist'],
           chunkSize: this.config.indexer.chunkSize || 512,
           chunkOverlap: this.config.indexer.chunkOverlap || 50,
           maxFileSize: this.config.indexer.maxFileSize || 10 * 1024 * 1024,
         }, this.db);  // CHANGED: pass shared db instance

         logger.info('Project indexer initialized');
       }
     } catch (indexerError) {
       // ...
     }
   ```

3. **No changes to MCP tool definitions** - project isolation is transparent to users.

---

## 7. Project Indexer (`src/project-index/indexer.ts`)

### Changes Required

**No changes required** if the indexer receives a properly configured `MemoryDatabase` instance. The database's `toPoint()` function automatically adds `projectId` to all payloads, including file chunks.

**Verification**: In `processFile()`, chunks are queued as `MemoryEntryInput` objects:
```typescript
this.pendingChunks.push({
  text: chunk.content,
  sourceType: 'project',
  sourcePath: filePath,
  metadataJson: JSON.stringify(chunkMetadata),
});
```

When `flushPendingChunks()` calls `this.db.addMemories(chunks)`, the database adds `projectId` to each point's payload. This satisfies the requirement.

---

## 8. Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                               CONFIG                                    │
│  generateProjectId() ──► BOOMERANG_PROJECT_ID || basename(process.cwd())│
│                              │                                          │
│                              ▼                                          │
│                    Config.database.projectId                            │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │
               ┌───────────────┼───────────────┐
               ▼               ▼               ▼
        ┌──────────┐   ┌──────────┐   ┌──────────┐
        │  Server  │   │  Server  │   │  Server  │
        │getDatabase│   │MemorySystem│  │ProjectIndexer│
        │(projectId)│   │(db)      │   │(db)      │
        └────┬─────┘   └────┬─────┘   └────┬─────┘
             │              │              │
             └──────────────┴──────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │ MemoryDatabase │
                    │  (projectId)   │
                    └───────┬───────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
      ┌──────────┐   ┌──────────┐   ┌──────────┐
      │ addMemory │   │queryMemories│  │listMemories│
      │ (write)   │   │ (read)     │  │ (read)     │
      └─────┬─────┘   └─────┬─────┘   └─────┬─────┘
            │               │               │
            ▼               ▼               ▼
      ┌─────────────────────────────────────────┐
      │           Qdrant Filter Logic            │
      │  must: [                                  │
      │    { should: [                            │
      │      { match: { projectId: "current" } }, │
      │      { is_empty: { key: "projectId" } }   │
      │    ] },                                   │
      │    { match: { sourceType: "..." } }       │
      │  ]                                        │
      └─────────────────────────────────────────┘
```

---

## 9. Index Creation Strategy

### When
- **New collections**: During `initialize()`, after `createCollection()`
- **Existing collections**: During `initialize()`, via `ensureProjectIdIndex()`

### How
```typescript
await this.client.createPayloadIndex(MEMORY_TABLE_NAME, {
  field_name: PAYLOAD_FIELDS.projectId,
  field_schema: 'keyword',
});
```

### Why Keyword
- `project_id` is a discrete identifier, not a range or text field
- Keyword index enables exact-match filtering with `O(1)` lookups
- Qdrant recommends keyword indexes for categorical payload fields

### Error Handling
- Index creation failure is non-fatal (logged as warning)
- Queries still work without the index (Qdrant falls back to full-scan)
- Performance impact is acceptable for small-to-medium collections

---

## 10. Backward Compatibility

### Read Behavior
All read operations use this filter pattern:
```json
{
  "should": [
    { "key": "projectId", "match": { "value": "current-project" } },
    { "is_empty": { "key": "projectId" } }
  ]
}
```

This ensures:
- **Memories with matching `projectId`** are returned
- **Memories without `projectId` (legacy data)** are also returned
- **Memories with a different `projectId`** are excluded

### Write Behavior
- New memories always include `projectId` when configured
- If no `projectId` is configured globally, payloads omit the field (preserves exact current behavior)

### No Migration Required
- Existing data remains untouched
- No batch update or re-indexing needed
- Legacy memories are accessible alongside new project-scoped memories

---

## 11. Error Handling

| Scenario | Handling |
|----------|----------|
| Qdrant unreachable | Same as existing - throws with helpful message |
| Index creation fails | Log warning, continue without index |
| `basename(process.cwd())` fails | Fall back to `undefined` (no isolation) |
| `BOOMERANG_PROJECT_ID` is empty string | Disable isolation (`undefined`) |
| Sanitized projectId becomes empty | Fall back to `undefined` (no isolation) |
| `is_empty` not supported by Qdrant version | Graceful degradation - may not see legacy data |

---

## 12. Testing Approach

### Unit Tests

1. **Config generation tests**:
   ```typescript
   test('generateProjectId from env var', () => {
     process.env.BOOMERANG_PROJECT_ID = 'My_Project!';
     expect(generateProjectId()).toBe('my-project');
   });

   test('generateProjectId empty string disables isolation', () => {
     process.env.BOOMERANG_PROJECT_ID = '';
     expect(generateProjectId()).toBeUndefined();
   });

   test('sanitizeProjectId removes special chars', () => {
     expect(sanitizeProjectId('Hello World!!!')).toBe('hello-world');
   });
   ```

2. **Filter building tests**:
   ```typescript
   test('buildFilter with projectId includes backward compat', () => {
     const db = new MemoryDatabase('http://localhost:6333', 'my-project');
     const filter = db['buildFilter']({ sourceType: 'session' });
     expect(filter).toEqual({
       must: [
         {
           should: [
             { key: 'projectId', match: { value: 'my-project' } },
             { is_empty: { key: 'projectId' } },
           ],
         },
         { key: 'sourceType', match: { value: 'session' } },
       ],
     });
   });

   test('buildFilter without projectId returns only user filters', () => {
     const db = new MemoryDatabase('http://localhost:6333');
     const filter = db['buildFilter']({ sourceType: 'session' });
     expect(filter).toEqual({
       key: 'sourceType', match: { value: 'session' },
     });
   });
   ```

### Integration Tests

1. **Project isolation**:
   - Add memory with projectId="project-a"
   - Add memory with projectId="project-b"
   - Query with projectId="project-a" configured → only see project-a memory

2. **Backward compatibility**:
   - Add memory without projectId (simulating legacy data)
   - Query with projectId configured → legacy memory is still returned

3. **Indexer integration**:
   - Index files with projectId configured
   - Verify indexed chunks have projectId in payload
   - Search returns only current project chunks

### E2E Test
- Start server with `BOOMERANG_PROJECT_ID=test-project`
- Add memories via MCP `add_memory` tool
- Query via `query_memories` tool
- Verify only test-project memories returned

---

## 13. Task Breakdown for Sub-Agents

### Task 1: Foundation - Schema & Config
**Files**: `src/memory/schema.ts`, `src/config.ts`
**Dependencies**: None
**Effort**: Small

- Add `projectId` to `MemoryEntry` interface
- Add `projectId` to `PAYLOAD_FIELDS`
- Add `projectId` to `SearchFilter`
- Add `BOOMERANG_PROJECT_ID` to `ENV_VARS`
- Add `projectId` to `DatabaseConfig`
- Implement `generateProjectId()` and `sanitizeProjectId()`
- Update `parseEnvConfig()` and `loadJsonConfig()`
- Write unit tests for config functions

### Task 2: Database Layer - Project Isolation
**Files**: `src/memory/database.ts`
**Dependencies**: Task 1
**Effort**: Medium

- Add `projectId` to `MemoryDatabase` constructor
- Implement `getProjectFilter()` helper
- Refactor `buildPayloadFilter()` → `buildFilter()` method
- Update `toPoint()` to optionally include `projectId`
- Update `pointToMemoryEntry()` to read `projectId`
- Update `createPayloadIndexes()` to include `projectId`
- Add `ensureProjectIdIndex()` for existing collections
- Update `initialize()` to call `ensureProjectIdIndex()`
- Update `addMemories()`, `addMemory()` to pass `projectId`
- Update `queryMemories()`, `listMemories()` to use `buildFilter()`
- Update `countMemories()`, `contentExists()`, `deleteBySourcePath()` to filter by project
- Update `getDatabase()` to accept `projectId`
- Write unit tests for filter building

### Task 3: MemorySystem & Search Integration
**Files**: `src/memory/index.ts`, `src/memory/search.ts`
**Dependencies**: Task 2
**Effort**: Small

- Update `MemorySystem` constructor to use `getDatabase()` with `projectId`
- Update `getMemorySystem()` config parameter
- Add `getDatabase()` accessor method
- Verify `MemorySearch` works correctly (minimal changes expected)

### Task 4: Server & Indexer Wiring
**Files**: `src/server.ts`, `src/project-index/indexer.ts`
**Dependencies**: Task 3
**Effort**: Small

- Add `db` property to `SuperMemoryServer`
- Create database with `projectId` in constructor
- Pass shared `db` instance to `MemorySystem` and `ProjectIndexer`
- Verify indexer chunks inherit `projectId` from database

### Task 5: Testing & Quality Gates
**Files**: `tests/*`
**Dependencies**: Tasks 1-4
**Effort**: Medium

- Unit tests for `generateProjectId()` and `sanitizeProjectId()`
- Unit tests for `buildFilter()` with and without project isolation
- Integration tests for project isolation (cross-project filtering)
- Integration tests for backward compatibility (legacy data access)
- Integration tests for indexer project tagging
- Run `npm run typecheck`
- Run `npm run lint`
- Run `npm run test`

---

## 14. Implementation Order

```
Task 1 (Schema + Config)
    │
    ▼
Task 2 (Database Layer)
    │
    ▼
Task 3 (MemorySystem + Search)
    │
    ▼
Task 4 (Server + Indexer)
    │
    ▼
Task 5 (Testing + Quality)
```

All tasks must be sequential due to tight coupling. Each task builds on the previous.

---

## 15. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Qdrant `is_empty` not supported | Low | High | Test with target Qdrant version; fallback to omitting legacy data from results |
| Performance regression from project filter | Low | Medium | Keyword index ensures O(1) filtering; benchmark if concerned |
| Existing tests break | Medium | Medium | Update test setup to configure `projectId`; add `resetConfig()` calls |
| Indexer uses wrong database instance | Medium | High | Explicitly pass `db` instance from server to indexer |
| Project ID collision | Low | Low | Sanitization ensures predictable IDs; collisions are user-resolvable via env var |

---

## 16. Acceptance Criteria

- [ ] `BOOMERANG_PROJECT_ID` env var correctly sets project isolation
- [ ] Without env var, `basename(process.cwd())` is used and sanitized
- [ ] Empty `BOOMERANG_PROJECT_ID` disables isolation
- [ ] All query operations filter by current `projectId`
- [ ] Existing memories without `projectId` are still accessible
- [ ] New memories automatically include `projectId` in payload
- [ ] Keyword index on `projectId` exists in Qdrant
- [ ] File indexer tags chunks with `projectId`
- [ ] `npm run typecheck` passes
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
- [ ] No breaking changes to MCP tool APIs
