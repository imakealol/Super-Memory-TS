/**
 * Multi-collection search with RRF tests
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MemorySystem } from '../src/memory/index.js';
import type { MemoryEntry } from '../src/memory/schema.js';

function createMockDatabase(overrides: Record<string, any> = {}) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    addMemory: vi.fn().mockResolvedValue('mock-id'),
    addMemories: vi.fn().mockResolvedValue([]),
    getMemory: vi.fn().mockResolvedValue(null),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteBySourcePath: vi.fn().mockResolvedValue(0),
    queryMemories: vi.fn().mockResolvedValue([]),
    getCollectionDimension: vi.fn().mockResolvedValue(1024),
    listMemories: vi.fn().mockResolvedValue([]),
    countMemories: vi.fn().mockResolvedValue(0),
    contentExists: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true,
    ...overrides,
  };
}

function createMockSearch(overrides: Record<string, any> = {}) {
  return {
    query: vi.fn().mockResolvedValue([]),
    searchWithVector: vi.fn().mockResolvedValue([]),
    getSimilar: vi.fn().mockResolvedValue([]),
    refreshIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('Multi-collection RRF Search', () => {
  const createMockEntry = (id: string, text: string, score = 0.9): MemoryEntry => ({
    id,
    text,
    vector: new Float32Array(1024),
    sourceType: 'session',
    timestamp: new Date(),
    contentHash: `hash-${id}`,
    score,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Single collection (backward compatibility)', () => {
    test('should use existing search when only one collection configured', async () => {
      const mockResults = [createMockEntry('1', 'test memory')];
      const mockSearch = createMockSearch({ query: vi.fn().mockResolvedValue(mockResults) });
      const mockDb = createMockDatabase();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['memories']
      });

      const result = await memorySystem.queryMemories('test question', { topK: 5 });

      expect(mockSearch.query).toHaveBeenCalledWith('test question', { topK: 5 });
      expect(result).toEqual(mockResults);
    });

    test('should default to single collection path when no queryCollections provided', async () => {
      const mockResults = [createMockEntry('1', 'test memory')];
      const mockSearch = createMockSearch({ query: vi.fn().mockResolvedValue(mockResults) });
      const mockDb = createMockDatabase();

      const memorySystem = new MemorySystem(mockDb, mockSearch);

      const result = await memorySystem.queryMemories('test question', { topK: 5 });

      expect(mockSearch.query).toHaveBeenCalled();
      expect(result).toEqual(mockResults);
    });
  });

  describe('Multi-collection RRF', () => {
    test('should search all collections and merge with RRF', async () => {
      const memories1 = [
        createMockEntry('1', 'memory from collection 1', 0.85),
        createMockEntry('2', 'another from collection 1', 0.80),
      ];
      const memories2 = [
        createMockEntry('3', 'memory from collection 2', 0.90),
        createMockEntry('4', 'another from collection 2', 0.75),
      ];

      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn()
          .mockResolvedValueOnce(memories1)
          .mockResolvedValueOnce(memories2),
      });
      const mockSearch = createMockSearch();

      // Spy on getCurrentEmbeddingDimension to return 1024
      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['memories', 'memories_bge_fp16']
      });
      
      // Mock the private method
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      const result = await memorySystem.queryMemories('test question', { topK: 3 });

      expect(mockDb.queryMemories).toHaveBeenCalledTimes(2);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    test('should handle collection search failure gracefully', async () => {
      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn()
          .mockRejectedValueOnce(new Error('Collection not found'))
          .mockResolvedValueOnce([createMockEntry('1', 'working collection')]),
      });
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['broken_collection', 'working_collection']
      });
      
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      const result = await memorySystem.queryMemories('test question', { topK: 5 });

      expect(result.length).toBeGreaterThan(0);
    });

    test('should deduplicate by id across collections', async () => {
      const sameMemory = createMockEntry('1', 'same memory in both', 0.9);
      
      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn()
          .mockResolvedValueOnce([sameMemory])
          .mockResolvedValueOnce([sameMemory]),
      });
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['memories', 'memories_bge_fp16']
      });
      
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      const result = await memorySystem.queryMemories('test question', { topK: 5 });

      const ids = result.map(m => m.id);
      const uniqueIds = [...new Set(ids)];
      expect(ids.length).toBe(uniqueIds.length);
    });

    test('should use higher limit when fetching from multiple collections', async () => {
      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn().mockResolvedValue([]),
      });
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['memories', 'memories_bge_fp16']
      });
      
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      await memorySystem.queryMemories('test question', { topK: 5 });

      expect(mockDb.queryMemories).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ topK: 10 }),
        expect.any(String)
      );
    });
  });

  describe('RRF scoring logic', () => {
    test('should apply RRF formula correctly', async () => {
      // Collection 1 results - rank 0 and 1
      const col1Results = [
        createMockEntry('1', 'rank 0 in col1', 0.9),
        createMockEntry('2', 'rank 1 in col1', 0.8),
      ];
      // Collection 2 results - rank 0
      const col2Results = [
        createMockEntry('3', 'rank 0 in col2', 0.85),
      ];

      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn()
          .mockResolvedValueOnce(col1Results)
          .mockResolvedValueOnce(col2Results),
      });
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['col1', 'col2']
      });
      
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      const result = await memorySystem.queryMemories('test', { topK: 5 });

      // RRF with k=60:
      // id=1: 1/(60+0+1) = 1/61 ≈ 0.01639
      // id=2: 1/(60+1+1) = 1/62 ≈ 0.01613
      // id=3: 1/(60+0+1) = 1/61 ≈ 0.01639
      // id=1 and id=3 tie at highest RRF, id=2 is lower

      expect(result.length).toBe(3);
      // First two should be id=1 and id=3 (tied), order may vary
      const topTwoIds = result.slice(0, 2).map(m => m.id).sort();
      expect(topTwoIds).toContain('1');
      expect(topTwoIds).toContain('3');
      // id=2 should be last
      expect(result[2].id).toBe('2');
    });

    test('should return empty array when all collections fail', async () => {
      const mockDb = createMockDatabase({
        getCollectionDimension: vi.fn().mockResolvedValue(1024),
        queryMemories: vi.fn().mockRejectedValue(new Error('All collections failed')),
      });
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['col1', 'col2']
      });
      
      vi.spyOn(memorySystem as any, 'getCurrentEmbeddingDimension').mockResolvedValue(1024);

      const result = await memorySystem.queryMemories('test', { topK: 5 });

      expect(result).toEqual([]);
    });
  });

  describe('config integration', () => {
    test('should accept queryCollections from config', async () => {
      const mockDb = createMockDatabase();
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch, {
        queryCollections: ['col1', 'col2', 'col3']
      });

      expect((memorySystem as any).queryCollections).toEqual(['col1', 'col2', 'col3']);
    });

    test('should default to MEMORY_TABLE_NAME when no queryCollections provided', async () => {
      const mockDb = createMockDatabase();
      const mockSearch = createMockSearch();

      const memorySystem = new MemorySystem(mockDb, mockSearch);

      // Default should be single collection (backward compatible)
      expect((memorySystem as any).queryCollections).toEqual(['memories']);
    });
  });
});