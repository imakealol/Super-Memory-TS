import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { QdrantClient } from '@qdrant/js-client-rest';
import { MemoryDatabase } from '../src/memory/database.js';

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
    // Use known vectors
    const vector1 = new Float32Array(Array(1024).fill(0).map((_, i) => i === 0 ? 1 : 0));
    const vector2 = new Float32Array(Array(1024).fill(0).map((_, i) => i === 1 ? 1 : 0));

    await db.addMemory({ text: 'Memory A', sourceType: 'session', vector: vector1 });
    await db.addMemory({ text: 'Memory B', sourceType: 'session', vector: vector2 });

    const results = await db.queryMemories(vector1, { topK: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toBe('Memory A');
  });
});
