import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { MemoryDatabase, clearClientCache } from '../src/memory/database.js';
import { MEMORY_TABLE_NAME, BGE_LARGE_DIMENSIONS, MINI_LM_DIMENSIONS } from '../src/memory/schema.js';
import { ModelManager } from '../src/model/index.js';

// Skip integration tests in CI - they require a running Qdrant instance
const describeIf = process.env.CI ? describe.skip : describe;

// Test collection name - unique to avoid conflicts with production 'memories' collection
const TEST_COLLECTION = 'test-memories-integration';

describeIf('Qdrant Integration', () => {
  let db: MemoryDatabase;
  let client: QdrantClient;
  const testUrl = process.env.TEST_QDRANT_URL || 'http://localhost:6333';

  beforeAll(async () => {
    client = new QdrantClient({ url: testUrl });

    // Delete any existing test collection to start fresh
    try {
      await client.deleteCollection(TEST_COLLECTION);
    } catch {
      // Ignore if doesn't exist
    }

    // Get actual embedding dimensions from model manager to ensure collection matches
    const modelManager = ModelManager.getInstance();
    const embeddingDim = modelManager.getDimensions();

    // Create test collection with correct dimensions
    await client.createCollection(TEST_COLLECTION, {
      vectors: {
        size: embeddingDim,
        distance: 'Cosine',
      },
    });

    // Override collection name via environment before db init
    const originalCollection = process.env.QDRANT_COLLECTION;
    process.env.QDRANT_COLLECTION = TEST_COLLECTION;

    db = new MemoryDatabase(testUrl);
    await db.initialize();

    // Restore original collection name if set
    if (originalCollection) {
      process.env.QDRANT_COLLECTION = originalCollection;
    } else {
      delete process.env.QDRANT_COLLECTION;
    }
  });

  afterAll(async () => {
    // Clean up test collection
    try {
      await client.deleteCollection(TEST_COLLECTION);
    } catch {
      // Ignore cleanup errors
    }
    if (db) {
      await db.close();
    }
    clearClientCache();
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
    // Use known vectors matching the model's embedding dimensions
    // ModelManager returns MINI_LM_DIMENSIONS (384) when GPU is unavailable
    const dims = ModelManager.getInstance().getDimensions();
    const vector1 = new Float32Array(dims);
    vector1[0] = 1;
    const vector2 = new Float32Array(dims);
    vector2[1] = 1;

    await db.addMemory({ text: 'Memory A', sourceType: 'session', vector: vector1 });
    await db.addMemory({ text: 'Memory B', sourceType: 'session', vector: vector2 });

    const results = await db.queryMemories(vector1, { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe('Memory A');
  });
});
