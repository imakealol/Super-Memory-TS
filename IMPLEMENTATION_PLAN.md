# Super-Memory-TS Implementation Plan

## Executive Summary

This document provides a comprehensive, phased implementation plan to fix critical bugs in Super-Memory-TS. The project was ported from Python/LanceDB to TypeScript/Qdrant, but the port introduced severe bugs—most critically, **semantic/vector search does not work at all**. The plan prioritizes fixes by severity, breaks work into delegable tasks, specifies exact files and line ranges, and includes testing and documentation updates.

---

## Severity Classification

| Severity | Issue | Impact |
|----------|-------|--------|
| **CRITICAL** | TIERED strategy never uses vector search | Core feature completely broken |
| **CRITICAL** | VECTOR_ONLY falls back to TEXT_ONLY in server | Users explicitly requesting vector search get text instead |
| **CRITICAL** | Database init failures silently swallowed | Indexer starts without DB, causing cascading failures |
| **HIGH** | Outdated MCP SDK patterns | Missing validation, annotations, proper error handling |
| **HIGH** | Heavy use of `any` type | Runtime errors not caught at compile time |
| **MEDIUM** | README still references LanceDB | Misleading documentation for users |
| **MEDIUM** | `dbPath` config name is misleading | Users think it's a filesystem path |
| **MEDIUM** | Qdrant client cache never cleaned | Memory leak on reconnections |
| **LOW** | `with_vector: true` in searches | Unnecessary data transfer |
| **LOW** | Tests reference wrong schema exports | Test suite has false positives |

---

## Phase 1: Critical Fixes (Search Strategies, Vector Search)

### Goal
Restore core functionality: vector search must actually perform vector search.

---

### Task 1.1: Fix `TIERED` Search Strategy

**File:** `src/memory/search.ts`
**Lines:** 110–140
**Current (broken):**
```typescript
private async tieredSearch(
  question: string,
  options: Required<SearchOptions>
): Promise<MemoryEntry[]> {
  const { threshold, topK } = options;

  // BUG: Only does text search, never vector search
  const textResults = await this.textSearchInternal(question, topK * 2);

  if (textResults.length === 0) {
    return [];
  }

  // BUG: Uses text score as proxy for vector similarity
  const topScore = 1 - (textResults[0]?.score ?? 0);

  if (topScore >= threshold) {
    return textResults.slice(0, topK).map(r => r.entry);
  }

  return this.mergeAndDedupe(textResults, topK);
}
```

**Required Change:**
1. Import `generateEmbedding` from `../model/embeddings.js` at top of file
2. Generate embedding for `question`
3. Perform vector search via `this.db.queryMemories()`
4. Check vector similarity score against threshold
5. If below threshold, ALSO perform text search
6. Merge vector + text results, deduplicate by `contentHash`
7. Return topK merged results

**Implementation:**
```typescript
import { generateEmbedding } from '../model/embeddings.js';

private async tieredSearch(
  question: string,
  options: Required<SearchOptions>
): Promise<MemoryEntry[]> {
  const { threshold, topK } = options;

  // Step 1: Generate embedding for the question
  let queryVector: Float32Array;
  try {
    const embedResult = await generateEmbedding(question);
    queryVector = new Float32Array(embedResult.embedding);
  } catch (embedError) {
    logger.warn('Embedding generation failed in TIERED search, falling back to text-only:', embedError);
    const textResults = await this.textSearchInternal(question, topK);
    return textResults.map(r => r.entry);
  }

  // Step 2: Perform vector search
  const vectorResults = await this.db.queryMemories(queryVector, {
    topK: topK * 2,
    strategy: 'VECTOR_ONLY',
  });

  // Step 3: Check if top vector score meets threshold
  // Qdrant returns cosine similarity; higher is better (range ~0 to 1)
  const topVectorScore = vectorResults.length > 0
    ? this.computeCosineSimilarity(queryVector, vectorResults[0].vector)
    : 0;

  if (topVectorScore >= threshold && vectorResults.length >= topK) {
    // High confidence vector results only
    return vectorResults.slice(0, topK);
  }

  // Step 4: Fallback - merge vector + text results
  const textResults = await this.textSearchInternal(question, topK * 2);
  const merged = this.mergeVectorAndTextResults(vectorResults, textResults, topK);
  return merged;
}
```

**Note:** Add a helper method `mergeVectorAndTextResults()` that interleaves vector and text results while deduplicating by `contentHash`. Vector results should generally rank higher than text results.

**Testing Strategy:**
- Add test that adds memories with known embeddings, queries with TIERED, and verifies vector similarity affects ranking
- Mock `generateEmbedding` to return predictable vectors
- Verify that when vector score is high, vector results dominate
- Verify that when vector score is low, text results supplement

---

### Task 1.2: Fix `VECTOR_ONLY` Search Strategy

**File:** `src/memory/search.ts`
**Lines:** 145–157
**Current (broken):**
```typescript
private async vectorOnlySearch(
  question: string,
  options: Required<SearchOptions>
): Promise<MemoryEntry[]> {
  // Placeholder: Return text search results until embedding is integrated
  const textResults = await this.textSearchInternal(question, options.topK);
  return textResults.map(r => r.entry);
}
```

**Required Change:**
1. Generate embedding for `question`
2. Call `this.db.queryMemories()` with the vector
3. Return results directly

**Implementation:**
```typescript
private async vectorOnlySearch(
  question: string,
  options: Required<SearchOptions>
): Promise<MemoryEntry[]> {
  // Generate embedding for the question
  let queryVector: Float32Array;
  try {
    const embedResult = await generateEmbedding(question);
    queryVector = new Float32Array(embedResult.embedding);
  } catch (embedError) {
    logger.warn('Embedding generation failed in VECTOR_ONLY search, falling back to text:', embedError);
    const textResults = await this.textSearchInternal(question, options.topK);
    return textResults.map(r => r.entry);
  }

  // Perform actual vector search
  return this.db.queryMemories(queryVector, {
    topK: options.topK,
    strategy: 'VECTOR_ONLY',
  });
}
```

**Testing Strategy:**
- Mock `generateEmbedding` to return a known vector
- Add memories with known vectors
- Query with VECTOR_ONLY and verify only vector similarity affects results (not text match)
- Verify that a query with no text overlap but high vector similarity still returns results

---

### Task 1.3: Remove `VECTOR_ONLY` Fallback in Server

**File:** `src/server.ts`
**Lines:** 323–342
**Current (broken):**
```typescript
if (internalStrategy === 'VECTOR_ONLY') {
  logger.warn('VECTOR_ONLY strategy may not work without embedding model - falling back to TEXT_ONLY');
  const textResults = await this.context.memory.queryMemories(query, {
    topK: limit,
    strategy: 'TEXT_ONLY',
  });
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        count: textResults.length,
        memories: textResults.map((r) => this.formatMemoryEntry(r)),
        strategy_used: 'TEXT_ONLY (VECTOR_ONLY fallback)',
      }),
    }],
  };
}
```

**Required Change:**
Remove this entire `if` block. The embedding model IS integrated (see `embeddings.ts` and `database.ts` which both call `generateEmbeddings`). This fallback was likely added during porting when embeddings weren't ready, but it's now actively breaking the feature.

**After removal, the code at lines 344–361 should execute for all strategies:**
```typescript
const searchOpts: SearchOptions = {
  topK: limit,
  strategy: internalStrategy,
};

const results = await this.context.memory.queryMemories(query, searchOpts);

return {
  content: [{
    type: 'text' as const,
    text: JSON.stringify({
      count: results.length,
      memories: results.map((r) => this.formatMemoryEntry(r)),
      strategy_used: internalStrategy,
    }),
  }],
};
```

**Testing Strategy:**
- Call `query_memories` with `strategy: 'vector_only'` and verify it does NOT return `strategy_used: 'TEXT_ONLY (VECTOR_ONLY fallback)'`
- Verify that vector-only queries return different (better semantic) results than text-only queries

---

### Task 1.4: Fix Database Initialization Error Handling in Indexer

**File:** `src/project-index/indexer.ts`
**Lines:** 147–152
**Current (broken):**
```typescript
await this.db.initialize().catch(err => {
  logger.error('Failed to initialize database', { error: err.message });
});
```

**Problem:** If DB initialization fails, the indexer continues running but has no working database. This causes all subsequent operations to fail mysteriously.

**Required Change:**
```typescript
try {
  await this.db.initialize();
} catch (err) {
  logger.error('Failed to initialize database', { error: err instanceof Error ? err.message : String(err) });
  this.isRunning = false;
  throw new IndexError(
    `Database initialization failed: ${err instanceof Error ? err.message : String(err)}`,
    undefined,
    'index'
  );
}
```

**Testing Strategy:**
- Mock `db.initialize()` to throw an error
- Verify that `indexer.start()` throws and sets `isRunning = false`
- Verify error is emitted via EventEmitter

---

### Task 1.5: Add Qdrant Connection Health Check

**File:** `src/memory/database.ts`
**Lines:** 71–78 (client creation), 167–198 (initialize)

**Problem:** No verification that Qdrant is actually reachable before declaring initialization successful.

**Required Change:**
Add a health check in `initialize()` after getting the client:

```typescript
async initialize(): Promise<void> {
  if (this.initialized) return;

  // Health check - verify Qdrant is reachable
  try {
    await this.client.getCollections();
  } catch (err) {
    throw new DatabaseError(
      `Cannot connect to Qdrant at ${this.client.url || 'unknown URL'}. ` +
      `Ensure Qdrant is running: docker run -p 6333:6333 qdrant/qdrant`,
      'initialize',
      MEMORY_TABLE_NAME
    );
  }

  // ... rest of initialize logic
}
```

**Also add a `clearClientCache()` utility for cleanup:**
```typescript
export function clearClientCache(): void {
  clients.clear();
}
```

**Testing Strategy:**
- Mock Qdrant client to throw on `getCollections()`
- Verify `initialize()` throws `DatabaseError` with helpful message
- Verify `clearClientCache()` empties the cache Map

---

## Phase 2: MCP SDK Modernization

### Goal
Migrate from legacy `Server` class to modern `McpServer` with Zod validation and proper annotations.

---

### Task 2.1: Install Zod Dependency

**File:** `package.json`
**Required Change:**
```bash
npm install zod
```

---

### Task 2.2: Migrate to `McpServer` Class

**File:** `src/server.ts`
**Lines:** 1–24 (imports), 185–224 (constructor), 243–303 (handlers), 588–656 (start)

**Current:** Uses `Server` with manual `setRequestHandler()` and raw JSON schema objects.

**Required Change:**
Replace imports and class structure:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

export class SuperMemoryServer {
  private server: McpServer;
  // ... rest of properties

  constructor(config?: Config) {
    this.config = config || loadConfigSync();
    // ... config validation

    this.server = new McpServer({
      name: 'super-memory',
      version: '1.0.0',
    });

    this.registerTools();
  }
}
```

**Register tools with Zod schemas:**

```typescript
private registerTools(): void {
  // query_memories
  this.server.tool(
    'query_memories',
    {
      query: z.string().min(1).describe('The search query to find relevant memories'),
      limit: z.number().int().min(1).max(100).default(10).describe('Maximum number of results'),
      strategy: z.enum(['tiered', 'vector_only', 'text_only']).default('tiered').describe('Search strategy'),
    },
    async ({ query, limit, strategy }) => {
      // ... handler logic
    },
    { readOnlyHint: true }
  );

  // add_memory
  this.server.tool(
    'add_memory',
    {
      content: z.string().min(1).describe('The content to store in memory'),
      sourceType: z.enum(['manual', 'file', 'conversation', 'web']).default('manual'),
      sourcePath: z.string().optional().describe('Optional source path or URL'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata'),
    },
    async ({ content, sourceType, sourcePath, metadata }) => {
      // ... handler logic
    },
    { destructiveHint: true }
  );

  // search_project
  this.server.tool(
    'search_project',
    {
      query: z.string().min(1).describe('The search query'),
      topK: z.number().int().min(1).max(100).default(20),
      fileTypes: z.array(z.string()).optional().describe('File type filters'),
      paths: z.array(z.string()).optional().describe('Path filters'),
    },
    async ({ query, topK, fileTypes, paths }) => {
      // ... handler logic
    },
    { readOnlyHint: true }
  );

  // index_project
  this.server.tool(
    'index_project',
    {
      path: z.string().optional().describe('Directory to index'),
      force: z.boolean().default(false).describe('Force re-indexing'),
    },
    async ({ path, force }) => {
      // ... handler logic
    },
    { destructiveHint: true }
  );
}
```

**Update `start()` method:**
```typescript
async start(): Promise<void> {
  // ... initialization logic ...

  const transport = new StdioServerTransport();
  await this.server.connect(transport);
  this.transportConnected = true;
  this.initialized = true;
  logger.info('Super-Memory MCP Server started successfully');
}
```

**Testing Strategy:**
- Verify `McpServer` is instantiated correctly
- Verify Zod validation rejects invalid inputs (empty query, negative limit, invalid strategy)
- Verify tool annotations are present in the tool definitions
- Mock the transport and verify tool calls work end-to-end

---

### Task 2.3: Replace `console.log` with Logger

**File:** `src/model/index.ts`
**Line:** 95
**Current:**
```typescript
console.warn(`Model load attempt ${i + 1} failed, retrying...`, lastError.message);
```

**File:** `src/memory/database.ts`
**Line:** 220
**Current:**
```typescript
console.warn(`Payload index warning for ${field}:`, err);
```

**Required Change:**
Replace all `console.log`, `console.warn`, `console.error` with `logger.debug()`, `logger.warn()`, `logger.error()` from `../utils/logger.js`.

**Rationale:** `StdioServerTransport` uses stdout for MCP protocol messages. Console output corrupts the protocol stream.

---

### Task 2.4: Use `McpError` for Protocol Errors

**File:** `src/server.ts`
**Lines:** 562–582 (formatError)

**Current:** Returns a custom error object with `isError: true`. This is actually correct for the low-level `Server` class, but with `McpServer`, errors should be thrown and the SDK handles formatting.

**Required Change:**
With `McpServer`, simply throw errors from tool handlers. The SDK automatically formats them. Remove the `formatError` method entirely.

```typescript
// In tool handlers, throw directly:
if (!query || query.trim().length === 0) {
  throw new Error('Query cannot be empty'); // McpServer wraps this
}
```

For more specific error codes, define a custom error that extends Error:

```typescript
class ToolError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}
```

**Testing Strategy:**
- Verify thrown errors are properly caught and formatted by McpServer
- Verify error responses include the message text

---

## Phase 3: Type Safety & Architecture

### Goal
Eliminate `any` types, fix race conditions, improve architecture.

---

### Task 3.1: Fix Vector Type Handling in `database.ts`

**File:** `src/memory/database.ts`
**Lines:** 124–137
**Current:**
```typescript
function pointToMemoryEntry(point: Schemas['ScoredPoint'] | Schemas['Record']): MemoryEntry {
  const payload = point.payload ?? {};

  let vector: Float32Array;
  if (Array.isArray(point.vector)) {
    vector = new Float32Array(point.vector as number[]);
  } else if (point.vector && typeof point.vector === 'object') {
    const vec = (point.vector as Record<string, number[]>).default;
    vector = new Float32Array(vec ?? []);
  } else {
    vector = new Float32Array();
  }
  // ...
}
```

**Required Change:**
Define a proper type guard and use the Qdrant SDK's actual vector type:

```typescript
function isNamedVector(vector: unknown): vector is Record<string, number[]> {
  return typeof vector === 'object' && vector !== null && !Array.isArray(vector);
}

function extractVector(point: Schemas['ScoredPoint'] | Schemas['Record']): Float32Array {
  const rawVector = point.vector;

  if (Array.isArray(rawVector)) {
    return new Float32Array(rawVector);
  }

  if (isNamedVector(rawVector)) {
    // For named vectors, extract the default vector
    const defaultVec = rawVector.default;
    if (Array.isArray(defaultVec)) {
      return new Float32Array(defaultVec);
    }
  }

  // Fallback: return empty vector (shouldn't happen with proper DB config)
  return new Float32Array();
}
```

**Testing Strategy:**
- Test with array vector format
- Test with named vector format (`{ default: [...] }`)
- Test with undefined vector (should return empty Float32Array)

---

### Task 3.2: Fix Race Condition in `search.ts`

**File:** `src/memory/search.ts`
**Lines:** 173–181
**Current:**
```typescript
private async textSearchInternal(
  query: string,
  limit: number
): Promise<TextSearchResult[]> {
  await this.ensureFuseIndex();

  if (!this.fuse) {
    throw new Error('Fuse.js index not initialized');
  }

  const results = this.fuse.search(query, { limit });
  // ...
}
```

**Problem:** `ensureFuseIndex()` sets `this.fuseReady = true` BEFORE setting `this.fuse`. If another async call interleaves, `this.fuse` could be null even after `ensureFuseIndex()` returns.

**Actually, looking more carefully:**
```typescript
private async ensureFuseIndex(): Promise<void> {
  if (this.fuseReady) {
    return;
  }

  const memories = await this.db.listMemories();

  this.fuse = new Fuse(memories, {
    ...FUSE_CONFIG,
    keys: ['text'],
  });

  this.fuseReady = true; // Set AFTER this.fuse is assigned
}
```

This is actually safe because `this.fuseReady` is set AFTER `this.fuse`. The null check on line 179 is defensive but the race condition described in the bug report may not actually exist. However, we should make the code more robust:

**Required Change:**
```typescript
private async textSearchInternal(
  query: string,
  limit: number
): Promise<TextSearchResult[]> {
  await this.ensureFuseIndex();

  // Defensive: if fuse is still null after ensure, return empty
  if (!this.fuse) {
    return [];
  }

  const results = this.fuse.search(query, { limit });
  // ...
}
```

Change from throwing to returning empty array. This prevents tool crashes if the index is temporarily unavailable.

---

### Task 3.3: Fix `any` Cast in Model Loading

**File:** `src/model/index.ts`
**Line:** 171
**Current:**
```typescript
this.extractor = await pipeline('feature-extraction', modelId, {
  dtype,
  device,
} as any) as any;
```

**Required Change:**
The `@xenova/transformers` package may have incomplete types. Instead of `as any`, define a typed options interface:

```typescript
interface PipelineOptions {
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  device?: string;
}

// In loadModel:
const options: PipelineOptions = { dtype, device };
this.extractor = await pipeline('feature-extraction', modelId, options);
```

If the SDK still complains, use `@ts-expect-error` with a comment explaining why:

```typescript
// @ts-expect-error @xenova/transformers types don't fully reflect runtime API for pipeline options
this.extractor = await pipeline('feature-extraction', modelId, { dtype, device });
```

This is better than `as any` because it documents the issue and will flag if the types are fixed in a future update.

---

### Task 3.4: Fix `_similarity` Access in Indexer

**File:** `src/project-index/indexer.ts`
**Line:** 591
**Current:**
```typescript
score: (entry as any)._similarity || 0,
```

**Problem:** `_similarity` does not exist on `MemoryEntry` type. Qdrant returns scores in `ScoredPoint.score`, not in the payload.

**Required Change:**
The `database.ts` `queryMemories` method already uses `pointToMemoryEntry(result)` which discards the score. We need to preserve the score.

Option A: Add `score` field to `MemoryEntry` (optional):
```typescript
// In schema.ts
export interface MemoryEntry {
  // ... existing fields ...
  score?: number; // Qdrant similarity score (populated during search)
}
```

Option B: Create a `ScoredMemoryEntry` type:
```typescript
export interface ScoredMemoryEntry extends MemoryEntry {
  score: number;
}
```

Then update `queryMemories` in `database.ts` to return scored entries:
```typescript
async queryMemories(
  vector: Float32Array | number[],
  options: SearchOptions = {}
): Promise<MemoryEntry[]> {
  // ... search logic ...

  for (const result of results) {
    const entry = pointToMemoryEntry(result);
    entry.score = result.score; // Preserve Qdrant score
    // ...
  }
}
```

Then in `indexer.ts`:
```typescript
score: entry.score ?? 0,
```

**Testing Strategy:**
- Verify that `entry.score` is populated after vector search
- Verify indexer search returns correct scores

---

### Task 3.5: Fix MemorySystem Config Respect

**File:** `src/memory/index.ts`
**Lines:** 46–56
**Current:**
```typescript
export class MemorySystem {
  private db: MemoryDatabase;
  private search: MemorySearch;
  // ...

  constructor(db?: MemoryDatabase, search?: MemorySearch) {
    this.db = db ?? new MemoryDatabase();
    this.search = search ?? new MemorySearch(this.db);
  }
```

**Problem:** When no `db` is passed, it creates `new MemoryDatabase()` with the default URL, ignoring any config passed to the server.

**Required Change:**
Add an optional `config` parameter to the constructor:

```typescript
export class MemorySystem {
  constructor(
    db?: MemoryDatabase,
    search?: MemorySearch,
    private config?: { dbUri?: string }
  ) {
    this.db = db ?? new MemoryDatabase(config?.dbUri);
    this.search = search ?? new MemorySearch(this.db);
  }
```

And update `getMemorySystem()`:
```typescript
export function getMemorySystem(config?: { dbUri?: string }): MemorySystem {
  if (!defaultMemorySystem) {
    defaultMemorySystem = new MemorySystem(undefined, undefined, config);
  }
  return defaultMemorySystem;
}
```

Then in `server.ts`:
```typescript
this.context = {
  memory: getMemorySystem({ dbUri: this.config.database.dbPath }),
  indexer: null,
};
```

**Testing Strategy:**
- Create MemorySystem with custom dbUri
- Verify it uses the provided URL, not default

---

### Task 3.6: Optimize Qdrant Search Payload Settings

**File:** `src/memory/database.ts`
**Lines:** 330–336, 360–365
**Current:**
```typescript
const results = await withRetry(() => this.client.search(MEMORY_TABLE_NAME, {
  vector: queryVector,
  limit: topK * 2,
  filter,
  with_payload: true,
  with_vector: true,  // Unnecessary - vectors not needed for display
}));
```

And in `listMemories`:
```typescript
const results = await withRetry(() => this.client.scroll(MEMORY_TABLE_NAME, {
  filter: qdrantFilter,
  limit: 100,
  with_payload: true,
  with_vector: true,  // Unnecessary for listing
}));
```

**Required Change:**
Change `with_vector: true` to `with_vector: false` in both `queryMemories` and `listMemories`. Only `getMemory` needs `with_vector: true` (for similarity search on a specific memory).

**Rationale:** Returning vectors over HTTP wastes bandwidth. A 1024-dim Float32Array is ~4KB per result. For 100 results, that's 400KB of unnecessary data.

**Exception:** If `searchWithVector` or `getSimilar` need the vector for subsequent operations, keep it. But in typical query flows, vectors are only needed at search time, not in the returned results.

**Testing Strategy:**
- Verify search results don't include vectors (or vectors are empty)
- Verify `getMemory` still returns vectors

---

## Phase 4: Testing & Documentation

### Goal
Fix broken tests, add integration tests, update documentation.

---

### Task 4.1: Fix Broken Schema Exports in Tests

**File:** `tests/server.test.ts`
**Lines:** 386–394
**Current:**
```typescript
test('should export correct schema types', async () => {
  const schema = await import('../src/memory/schema.js');

  expect(schema.MEMORY_TABLE_NAME).toBe('memories');
  expect(schema.HNSW_CONFIG).toBeDefined();  // BUG: export is QDRANT_HNSW_CONFIG
  expect(schema.HNSW_CONFIG.type).toBe('hnsw');
  expect(schema.HNSW_CONFIG.distanceType).toBe('cosine');
  // ...
});
```

**Required Change:**
```typescript
test('should export correct schema types', async () => {
  const schema = await import('../src/memory/schema.js');

  expect(schema.MEMORY_TABLE_NAME).toBe('memories');
  expect(schema.QDRANT_HNSW_CONFIG).toBeDefined();
  expect(schema.QDRANT_HNSW_CONFIG.m).toBe(16);
  expect(schema.QDRANT_HNSW_CONFIG.ef_construct).toBe(128);
  expect(schema.DEFAULT_SEARCH_OPTIONS).toBeDefined();
  expect(schema.DEFAULT_SEARCH_OPTIONS.topK).toBe(5);
  expect(schema.DEFAULT_SEARCH_OPTIONS.strategy).toBe('TIERED');
  expect(schema.DEFAULT_SEARCH_OPTIONS.threshold).toBe(0.72);
});
```

**Also remove the outdated BUG REPORT comment at lines 753–776.** It references LanceDB issues that are no longer relevant.

---

### Task 4.2: Add Integration Tests with Qdrant

**File:** `tests/integration.test.ts` (new file)

**Required Change:**
Create a new integration test file that tests against a real (or testcontainer) Qdrant instance:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { MemoryDatabase } from '../src/memory/database.js';
import { MemorySearch } from '../src/memory/search.js';

describe('Qdrant Integration', () => {
  let db: MemoryDatabase;
  let client: QdrantClient;
  const testUrl = process.env.TEST_QDRANT_URL || 'http://localhost:6333';

  beforeAll(async () => {
    client = new QdrantClient({ url: testUrl });
    db = new MemoryDatabase(testUrl);
    await db.initialize();
  });

  afterAll(async () => {
    // Clean up test collection
    try {
      await client.deleteCollection('memories');
    } catch {
      // Ignore cleanup errors
    }
  });

  test('should add and retrieve memory', async () => {
    const id = await db.addMemory({
      text: 'Test memory content',
      sourceType: 'session',
    });

    const memory = await db.getMemory(id);
    expect(memory).toBeDefined();
    expect(memory?.text).toBe('Test memory content');
  });

  test('should search by vector similarity', async () => {
    // Add test memories with known vectors
    const vector1 = new Float32Array(Array(1024).fill(0).map((_, i) => i === 0 ? 1 : 0));
    const vector2 = new Float32Array(Array(1024).fill(0).map((_, i) => i === 1 ? 1 : 0));

    await db.addMemory({
      text: 'Memory about cats',
      sourceType: 'session',
      vector: vector1,
    });

    await db.addMemory({
      text: 'Memory about dogs',
      sourceType: 'session',
      vector: vector2,
    });

    // Search with vector similar to vector1
    const results = await db.queryMemories(vector1, { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe('Memory about cats');
  });

  test('should use payload indexes for filtering', async () => {
    await db.addMemory({
      text: 'Project memory',
      sourceType: 'project',
    });

    await db.addMemory({
      text: 'Session memory',
      sourceType: 'session',
    });

    const allResults = await db.listMemories();
    expect(allResults.length).toBeGreaterThanOrEqual(2);

    const filtered = await db.listMemories({ sourceType: 'project' });
    expect(filtered.every(r => r.sourceType === 'project')).toBe(true);
  });
});
```

**For CI/CD:** Add a GitHub Actions service container for Qdrant:

```yaml
# In .github/workflows/test.yml
services:
  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - 6333:6333
```

---

### Task 4.3: Update README to Reflect Qdrant

**File:** `README.md`

**Critical updates needed:**

1. **Architecture diagram (lines 136–166, 177–206):**
   - Replace "LanceDB" with "Qdrant"
   - Replace "LanceDB + HNSW" with "Qdrant (HNSW)"

2. **Data flow diagrams (lines 212–265):**
   - Replace "LanceDB" with "Qdrant"
   - Replace "LanceDB + HNSW Index" with "Qdrant Vector Store"

3. **Database section (lines 292–306):**
   - Change "LanceDB with HNSW indexing" to "Qdrant with HNSW indexing"
   - Update schema example to reflect actual Qdrant payload structure

4. **Architecture Decisions / LanceDB over Alternatives (lines 766–774):**
   - This section is completely wrong. Replace with "Why Qdrant?"
   - Update comparison table:

```markdown
### Qdrant over Alternatives

| Database | Pros | Cons |
|----------|------|------|
| **Qdrant** | REST API, payload filtering, HNSW, open source | Requires separate process |
| LanceDB | Embedded, Arrow format | TypeScript support was immature |
| Chroma | Simple, local | Less mature |
| Pinecone | Managed, scalable | Requires API key |
```

5. **Quick Start / Environment Variables (lines 362–381):**
   - Fix `BOOMERANG_DB_PATH`:
```bash
# Database
QDRANT_URL=http://localhost:6333  # Qdrant server URL
```
   - Remove the comment saying "Database storage path" for `BOOMERANG_DB_PATH`

6. **Configuration File (lines 429–457):**
   - Change `dbPath` example from `"./.super-memory/db"` to `"http://localhost:6333"`
   - Add comment explaining this is a Qdrant URL, not a filesystem path

7. **Environment Variables Reference (lines 469–479):**
   - Change `BOOMERANG_DB_PATH` default from `./.super-memory/db` to `http://localhost:6333`
   - Change description from "Database storage path" to "Qdrant server URL"
   - Add `QDRANT_URL` variable

8. **Default precision claim (lines 89, 101, 471):**
   - README says default is `fp16`
   - `config.ts` says default is `fp16`
   - BUT `model/index.ts` `createConfig()` says `precision: envPrecision ?? 'fp32'`
   - **Fix:** Change `model/index.ts` default to `'fp16'` to match README and `config.ts`

9. **Related Documentation (lines 889–892):**
   - Replace LanceDB link with Qdrant link: `https://qdrant.tech/documentation/`

---

### Task 4.4: Fix Config Property Naming

**File:** `src/config.ts`
**Lines:** 34–37, 94–97, 277–278

**Current:**
```typescript
export interface DatabaseConfig {
  dbPath: string;  // Actually holds Qdrant URL
  tableName: string;
}
```

**Required Change:**
Rename `dbPath` to `qdrantUrl` throughout the codebase:

```typescript
export interface DatabaseConfig {
  qdrantUrl: string;
  collectionName: string;  // Also rename tableName → collectionName for Qdrant terminology
}
```

**Files to update:**
- `src/config.ts` - interface, defaults, env parsing, JSON loading
- `src/memory/schema.ts` - `DEFAULT_QDRANT_URL` usage
- `src/server.ts` - `this.config.database.dbPath` references
- `src/memory/index.ts` - `dbUri` parameter naming
- `src/memory/database.ts` - constructor parameter naming
- `tests/server.test.ts` - mock config references
- `README.md` - all documentation references

**Migration note:** Keep backward compatibility by accepting both `dbPath` and `qdrantUrl`:

```typescript
export interface DatabaseConfig {
  /** @deprecated Use qdrantUrl instead */
  dbPath?: string;
  qdrantUrl?: string;
  collectionName: string;
}

// In loadConfig:
database: {
  qdrantUrl: json.database?.qdrantUrl || json.database?.dbPath || DEFAULT_QDRANT_URL,
  collectionName: json.database?.collectionName || json.database?.tableName || 'memories',
}
```

---

### Task 4.5: Add Unit Tests for Search Strategies

**File:** `tests/search.test.ts` (new file)

**Required Change:**
Create dedicated tests for the search strategies:

```typescript
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MemorySearch } from '../src/memory/search.js';
import { MemoryDatabase } from '../src/memory/database.js';

describe('MemorySearch', () => {
  let search: MemorySearch;
  let mockDb: MemoryDatabase;

  beforeEach(() => {
    mockDb = {
      queryMemories: vi.fn(),
      listMemories: vi.fn().mockResolvedValue([]),
      getMemory: vi.fn(),
    } as unknown as MemoryDatabase;

    search = new MemorySearch(mockDb);
  });

  test('VECTOR_ONLY should call db.queryMemories with vector', async () => {
    // Mock generateEmbedding
    vi.mock('../src/model/embeddings.js', () => ({
      generateEmbedding: vi.fn().mockResolvedValue({
        embedding: Array(1024).fill(0.1),
      }),
    }));

    await search.query('test query', { strategy: 'VECTOR_ONLY', topK: 5 });

    expect(mockDb.queryMemories).toHaveBeenCalled();
    const callArgs = mockDb.queryMemories.mock.calls[0];
    expect(callArgs[0]).toBeInstanceOf(Float32Array);
    expect(callArgs[1]).toMatchObject({ topK: 5, strategy: 'VECTOR_ONLY' });
  });

  test('TIERED should use vector search first', async () => {
    vi.mocked(mockDb.queryMemories).mockResolvedValue([
      { id: '1', text: 'Vector result', score: 0.95 },
    ]);

    const results = await search.query('test', { strategy: 'TIERED', topK: 5 });

    expect(mockDb.queryMemories).toHaveBeenCalled();
    expect(results.length).toBeGreaterThan(0);
  });

  test('TEXT_ONLY should not call db.queryMemories', async () => {
    await search.query('test', { strategy: 'TEXT_ONLY', topK: 5 });
    expect(mockDb.queryMemories).not.toHaveBeenCalled();
  });
});
```

---

## Task Dependency Graph

```
Phase 1 (Critical)
├── Task 1.1 Fix TIERED search ──┐
├── Task 1.2 Fix VECTOR_ONLY search ├─→ Can be done in parallel
├── Task 1.3 Remove server fallback ─┘
├── Task 1.4 Fix indexer DB init
└── Task 1.5 Add Qdrant health check
         │
         ▼
Phase 2 (MCP SDK)
├── Task 2.1 Install Zod
├── Task 2.2 Migrate to McpServer
├── Task 2.3 Replace console.log
└── Task 2.4 Use McpError
         │
         ▼
Phase 3 (Type Safety)
├── Task 3.1 Fix vector types
├── Task 3.2 Fix race condition
├── Task 3.3 Fix any casts
├── Task 3.4 Fix _similarity
├── Task 3.5 Fix config respect
└── Task 3.6 Optimize payload settings
         │
         ▼
Phase 4 (Testing & Docs)
├── Task 4.1 Fix test exports
├── Task 4.2 Add integration tests
├── Task 4.3 Update README
├── Task 4.4 Rename config props
└── Task 4.5 Add search tests
```

---

## Delegation Guide for Sub-Agents

### Agent: Critical-Fixes
**Tasks:** 1.1, 1.2, 1.3, 1.4, 1.5
**Skills needed:** TypeScript, Qdrant API, embedding generation
**Priority:** CRITICAL - Do first
**Validation:** Run `npm run typecheck` after changes. Vector search tests must pass.

### Agent: SDK-Modernizer
**Tasks:** 2.1, 2.2, 2.3, 2.4
**Skills needed:** MCP SDK 1.0+, Zod, TypeScript
**Priority:** HIGH - Can start after Phase 1 complete
**Depends on:** Phase 1
**Validation:** Server starts without errors. Tool calls work via MCP inspector.

### Agent: Type-Safety
**Tasks:** 3.1, 3.2, 3.3, 3.4, 3.5, 3.6
**Skills needed:** TypeScript strict mode, Qdrant types
**Priority:** MEDIUM - Can be done in parallel with Phase 2
**Validation:** `npm run typecheck` passes with zero `any` usage (except documented `@ts-expect-error`).

### Agent: Test-Docs
**Tasks:** 4.1, 4.2, 4.3, 4.4, 4.5
**Skills needed:** Vitest, technical writing, GitHub Actions
**Priority:** MEDIUM - Can start after Phase 1
**Depends on:** Phase 1 (for correct behavior to test), Phase 3 (for type changes)
**Validation:** All tests pass. README accurately describes architecture.

---

## Testing Strategy Summary

| Test Level | Coverage | Tools |
|------------|----------|-------|
| **Unit** | Search strategies, config validation, error formatting | Vitest with mocks |
| **Integration** | Qdrant connection, vector search, payload filtering | Vitest + Qdrant container |
| **E2E** | Full MCP server lifecycle, tool calls | MCP Inspector or custom client |
| **Regression** | Ensure text search still works after vector fixes | Vitest |

### CI Pipeline
```yaml
1. Lint: npm run lint
2. Type Check: npm run typecheck
3. Unit Tests: npm test -- tests/server.test.ts tests/search.test.ts
4. Integration Tests: npm test -- tests/integration.test.ts (requires Qdrant service)
5. Build: npm run build
```

---

## Migration Path from Old to New MCP SDK

The migration from `Server` to `McpServer` is largely internal. The external protocol remains the same.

**For users:** No changes needed. The server still exposes the same 4 tools with the same parameters.

**For developers:**
1. Replace `new Server(...)` with `new McpServer({ name, version })`
2. Replace `server.setRequestHandler(ListToolsRequestSchema, ...)` with `server.tool(name, schema, handler, annotations)`
3. Replace `server.setRequestHandler(CallToolRequestSchema, ...)` with individual tool registrations
4. Replace manual argument casting with Zod schemas
5. Remove `formatError()` - throw errors directly

**Backward compatibility:** The MCP protocol is versioned. As long as we use SDK 1.0+, clients using SDK 1.0+ will work. The `McpServer` class is a wrapper around `Server` - the wire protocol is identical.

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Embedding generation too slow for search | Medium | High | Add timeout + fallback to text search |
| Qdrant connection failures in production | Medium | High | Add health checks + clear error messages |
| Dimension mismatch (384 vs 1024) | Low | Critical | Validate dimensions on init, throw clear error |
| MCP SDK migration breaks clients | Low | High | Test with actual MCP client before release |
| Tests require Qdrant running | Medium | Medium | Use testcontainers or mock for unit tests |

---

## Success Criteria

The implementation is complete when:

1. ✅ `query_memories` with `strategy: 'vector_only'` performs actual vector search (not text fallback)
2. ✅ `query_memories` with `strategy: 'tiered'` uses vector search first, then falls back to text
3. ✅ `npm run typecheck` passes with no errors
4. ✅ All unit tests pass
5. ✅ Integration tests pass against Qdrant (local or containerized)
6. ✅ README accurately describes Qdrant architecture (no LanceDB references)
7. ✅ MCP server starts and responds to tool calls without `console.log` output
8. ✅ No `any` types remain (except documented `@ts-expect-error`)
9. ✅ Config property `dbPath` is renamed to `qdrantUrl` with backward compatibility
10. ✅ Database initialization failures are propagated, not silently swallowed

---

## Appendix: Quick Reference - Files to Modify

| File | Lines | Change Type |
|------|-------|-------------|
| `src/memory/search.ts` | 1–274 | Major refactor - fix search strategies |
| `src/server.ts` | 1–682 | Major refactor - MCP SDK migration |
| `src/memory/database.ts` | 1–489 | Medium - type safety, health checks, payload optimization |
| `src/project-index/indexer.ts` | 147–152 | Minor - error propagation |
| `src/memory/index.ts` | 46–56 | Minor - config respect |
| `src/model/index.ts` | 171 | Minor - remove `any` cast |
| `src/config.ts` | 34–37, 94–97 | Minor - rename dbPath |
| `src/memory/schema.ts` | 15–34 | Minor - add optional score field |
| `tests/server.test.ts` | 386–394, 753–776 | Minor - fix exports, remove stale comments |
| `tests/search.test.ts` | New | New - search strategy tests |
| `tests/integration.test.ts` | New | New - Qdrant integration tests |
| `README.md` | 136–892 | Major - update architecture, config, diagrams |
| `package.json` | 36–45 | Minor - add zod dependency |

---

*Plan generated: 2025-04-25*
*Version: 1.0*
