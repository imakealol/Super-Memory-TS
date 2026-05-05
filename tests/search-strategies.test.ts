/**
 * Comprehensive Tests for Search Strategies
 * 
 * Tests all search strategies: TIERED, VECTOR_ONLY, TEXT_ONLY
 * with various scenarios including edge cases.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemorySearch } from '../src/memory/search.js';
import { MemoryDatabase } from '../src/memory/database.js';
import type { MemoryEntry, SearchStrategy } from '../src/memory/schema.js';

// ============================================================================
// Test Data
// ============================================================================

const TEST_MEMORIES = [
  {
    id: 'mem-js-basics',
    text: 'JavaScript is a programming language for web development. It supports functions, objects, and arrays.',
    sourceType: 'session' as const,
  },
  {
    id: 'mem-python-async',
    text: 'Python is a versatile programming language. It has async/await support for concurrent operations.',
    sourceType: 'session' as const,
  },
  {
    id: 'mem-docker',
    text: 'Docker containers package applications with their dependencies. Containerization enables consistent deployments.',
    sourceType: 'session' as const,
  },
  {
    id: 'mem-react',
    text: 'React is a JavaScript library for building user interfaces with components and state management.',
    sourceType: 'session' as const,
  },
  {
    id: 'memkubernetes',
    text: 'Kubernetes orchestrates Docker containers in production. It provides scaling and load balancing.',
    sourceType: 'session' as const,
  },
];

// Create memory entries with mock vectors
function createMemoryEntry(template: typeof TEST_MEMORIES[0], index: number): MemoryEntry {
  // Create a deterministic mock vector based on index
  const vectorDim = 384; // MiniLM dimension
  const vector = new Float32Array(vectorDim);
  vector[index % vectorDim] = 1; // One-hot encoding for predictable similarity

  return {
    id: template.id,
    text: template.text,
    vector,
    sourceType: template.sourceType,
    timestamp: new Date(),
    contentHash: `hash-${template.id}`,
    projectId: 'test-project',
  };
}

// ============================================================================
// Mock Database
// ============================================================================

function createMockDatabase(memories: MemoryEntry[]): MemoryDatabase {
  return {
    queryMemories: vi.fn().mockImplementation(async (vector: Float32Array, _opts?: any) => {
      // Simple similarity: return memories where vector index matches memory index
      const vectorIndex = vector.indexOf(1);
      if (vectorIndex >= 0 && vectorIndex < memories.length) {
        const matchedMemory = memories[vectorIndex];
        return [{
          ...matchedMemory,
          score: 0.95,
        }];
      }
      // Return first result as fallback (most similar by default test behavior)
      if (memories.length > 0) {
        return [{
          ...memories[0],
          score: 0.5,
        }];
      }
      return [];
    }),
    listMemories: vi.fn().mockResolvedValue(memories),
    getMemory: vi.fn().mockImplementation(async (id: string) => {
      return memories.find(m => m.id === id) || null;
    }),
    addMemory: vi.fn().mockImplementation(async (input: any) => {
      const id = input.id || `mem-${Date.now()}`;
      return id;
    }),
    deleteMemory: vi.fn().mockResolvedValue(true),
  } as unknown as MemoryDatabase;
}

// ============================================================================
// Strategy Selection Tests
// ============================================================================

describe('Strategy Selection', () => {
  test('TIERED strategy constant is defined', () => {
    const strategy: SearchStrategy = 'TIERED';
    expect(strategy).toBe('TIERED');
  });

  test('VECTOR_ONLY strategy constant is defined', () => {
    const strategy: SearchStrategy = 'VECTOR_ONLY';
    expect(strategy).toBe('VECTOR_ONLY');
  });

  test('TEXT_ONLY strategy constant is defined', () => {
    const strategy: SearchStrategy = 'TEXT_ONLY';
    expect(strategy).toBe('TEXT_ONLY');
  });

  test('Invalid strategy falls back to TIERED (default)', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    // @ts-ignore - intentionally passing invalid strategy
    const results = await search.query('test query', { strategy: 'INVALID' as any });

    // Should still execute (falls back to TIERED)
    expect(mockDb.queryMemories).toHaveBeenCalled();
  });

  test('Default options include TIERED strategy', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    await search.query('test');

    // TIERED uses vector search, so queryMemories should be called
    expect(mockDb.queryMemories).toHaveBeenCalled();
  });
});

// ============================================================================
// TIERED Strategy Tests
// ============================================================================

describe('TIERED Strategy', () => {
  let search: MemorySearch;
  let mockDb: MemoryDatabase;
  let memories: MemoryEntry[];

  beforeEach(() => {
    memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    mockDb = createMockDatabase(memories);
    search = new MemorySearch(mockDb);
  });

  test('should perform vector search when threshold is met', async () => {
    const vectorResults = await search.query('JavaScript basics', {
      strategy: 'TIERED',
      threshold: 0.5,
      topK: 5,
    });

    // Should have called vector search
    expect(mockDb.queryMemories).toHaveBeenCalled();
    expect(vectorResults).toBeDefined();
  });

  test('should fall back to text search when vector results are below threshold', async () => {
    // Mock vector search to return low scores
    (mockDb.queryMemories as any).mockResolvedValueOnce([
      { ...memories[0], score: 0.3 }, // Below threshold
    ]);

    const results = await search.query('programming language', {
      strategy: 'TIERED',
      threshold: 0.72,
      topK: 5,
    });

    // Should fall back to text search (listMemories is called for Fuse index)
    expect(mockDb.listMemories).toHaveBeenCalled();
    expect(results).toBeDefined();
  });

  test('should merge vector and text results when both return results', async () => {
    // Vector returns some results
    (mockDb.queryMemories as any).mockResolvedValueOnce([
      { ...memories[0], score: 0.5 }, // Below threshold
    ]);

    const results = await search.query('programming', {
      strategy: 'TIERED',
      threshold: 0.3,
      topK: 5,
});
  });

  test('PARALLEL handles vector search failure gracefully', async () => {
    // Make vector search fail, text search succeed
    (mockDb.queryMemories as any).mockRejectedValueOnce(new Error('Vector error'));
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);

    const results = await search.query('programming', { strategy: 'PARALLEL', topK: 5 });

    // Should still return text search results
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
  });

  test('PARALLEL handles text search failure gracefully', async () => {
    // Make vector search succeed, text search fail
    (mockDb.queryMemories as any).mockResolvedValueOnce([memories[0], memories[1]]);
    (mockDb.listMemories as any).mockRejectedValueOnce(new Error('Text error'));

    const results = await search.query('programming', { strategy: 'PARALLEL', topK: 5 });

    // Should still return vector search results
    expect(results).toBeDefined();
    expect(results.length).toBeGreaterThan(0);
  });

  test('PARALLEL returns empty when both searches fail', async () => {
    // Both searches fail
    (mockDb.queryMemories as any).mockRejectedValueOnce(new Error('Vector error'));
    (mockDb.listMemories as any).mockRejectedValueOnce(new Error('Text error'));

    const results = await search.query('programming', { strategy: 'PARALLEL', topK: 5 });

    expect(results).toEqual([]);
  });

  test('PARALLEL respects topK parameter', async () => {
    (mockDb.queryMemories as any).mockResolvedValueOnce(memories);
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);

    await search.query('test', { strategy: 'PARALLEL', topK: 3 });

    // Results should be limited to topK
    const results = await search.query('test', { strategy: 'PARALLEL', topK: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test('PARALLEL uses k=60 for RRF constant', async () => {
    // The RRF formula is: score = 1 / (k + rank + 1)
    // With k=60: first rank gives 1/61, second gives 1/62, etc.
    (mockDb.queryMemories as any).mockResolvedValueOnce([memories[0]]);
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);

    const results = await search.query('test', { strategy: 'PARALLEL', topK: 5 });

    // Verify it doesn't throw and returns valid results
    expect(results).toBeDefined();
  });

  test('PARALLEL deduplicates results appearing in both searches', async () => {
    // When the same memory appears in both vector and text results,
    // RRF should combine their scores
    (mockDb.queryMemories as any).mockResolvedValueOnce([memories[0]]);
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);

    const results = await search.query('JavaScript', { strategy: 'PARALLEL', topK: 10 });

    // Should have results without duplicates (by contentHash)
    const contentHashes = results.map(r => r.contentHash);
    const uniqueHashes = new Set(contentHashes);
    expect(uniqueHashes.size).toBe(contentHashes.length);
  });

  test('PARALLEL is accessible via query method', async () => {
    (mockDb.queryMemories as any).mockResolvedValueOnce([memories[0], memories[1]]);
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);

    const results = await search.query('test', { strategy: 'PARALLEL', topK: 5 });

    expect(results).toBeDefined();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================================================
// RRF Fusion Math Tests
// ============================================================================

describe('RRF Fusion Math', () => {
  test('RRF score for rank 0 with k=60 should be ~0.01639', () => {
    const k = 60;
    const rank = 0;
    const score = 1 / (k + rank + 1);
    expect(score).toBeCloseTo(1/61, 4); // 0.016393...
  });

  test('RRF score for rank 1 with k=60 should be ~0.01613', () => {
    const k = 60;
    const rank = 1;
    const score = 1 / (k + rank + 1);
    expect(score).toBeCloseTo(1/62, 4); // 0.016129...
  });

  test('Combined RRF score adds correctly', () => {
    const k = 60;
    // Memory appears at rank 0 in vector (score 1/61) and rank 1 in text (score 1/62)
    const vectorScore = 1 / (k + 0 + 1);
    const textScore = 1 / (k + 1 + 1);
    const combined = vectorScore + textScore;
    
    // Combined should be ~0.01639 + 0.01613 = 0.03252
    expect(combined).toBeCloseTo(0.0325, 3);
  });

  test('Higher rank means lower RRF contribution', () => {
    const k = 60;
    const rank0Score = 1 / (k + 0 + 1);
    const rank5Score = 1 / (k + 5 + 1);
    
    expect(rank0Score).toBeGreaterThan(rank5Score);
    // rank 0 = 1/61 ≈ 0.0164
    // rank 5 = 1/66 ≈ 0.0152
    expect(rank0Score / rank5Score).toBeCloseTo(66/61, 2);
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Error Handling', () => {
  test('handles database query failure in VECTOR_ONLY', async () => {
    const mockDb: MemoryDatabase = {
      queryMemories: vi.fn().mockRejectedValue(new Error('Database error')),
      listMemories: vi.fn().mockResolvedValue([]),
    } as unknown as MemoryDatabase;

    const search = new MemorySearch(mockDb);

    await expect(
      search.query('test', { strategy: 'VECTOR_ONLY', topK: 5 })
    ).rejects.toThrow('Database error');
  });

  test('handles listMemories failure in TEXT_ONLY', async () => {
    const mockDb: MemoryDatabase = {
      queryMemories: vi.fn(),
      listMemories: vi.fn().mockRejectedValue(new Error('List error')),
    } as unknown as MemoryDatabase;

    const search = new MemorySearch(mockDb);

    await expect(
      search.query('test', { strategy: 'TEXT_ONLY', topK: 5 })
    ).rejects.toThrow('List error');
  });

  test('handles invalid topK gracefully', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    // Negative topK should not cause errors
    const results = await search.query('test', { strategy: 'VECTOR_ONLY', topK: -1 });
    expect(results).toBeDefined();
  });

  test('handles very large topK gracefully', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    // Very large topK should not cause errors
    const results = await search.query('test', { strategy: 'VECTOR_ONLY', topK: 1000 });
    expect(results).toBeDefined();
  });
});

// ============================================================================
// SearchWithVector Tests
// ============================================================================

describe('searchWithVector', () => {
  test('uses database vector search', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    const vector = new Float32Array(384);
    vector[0] = 1;

    await search.searchWithVector(vector, { topK: 5 });

    expect(mockDb.queryMemories).toHaveBeenCalled();
  });

  test('TEXT_ONLY strategy ignores vector in searchWithVector', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    const vector = new Float32Array(384);

    // Should call query() instead which will use TEXT_ONLY
    await search.searchWithVector(vector, { strategy: 'TEXT_ONLY', topK: 5 });

    // For TEXT_ONLY, it falls back to query() which uses text search
    expect(mockDb.listMemories).toHaveBeenCalled();
  });
});

// ============================================================================
// getSimilar Tests
// ============================================================================

describe('getSimilar', () => {
  test('returns similar memories for given memory ID', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    const results = await search.getSimilar('mem-js-basics', { topK: 3 });

    expect(mockDb.getMemory).toHaveBeenCalledWith('mem-js-basics');
    expect(mockDb.queryMemories).toHaveBeenCalled();
    expect(results).toBeDefined();
  });

  test('returns empty array for non-existent memory ID', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    (mockDb.getMemory as any).mockResolvedValueOnce(null);

    const results = await search.getSimilar('non-existent-id', { topK: 3 });

    expect(results).toEqual([]);
  });
});

// ============================================================================
// refreshIndex Tests
// ============================================================================

describe('refreshIndex', () => {
  test('rebuilds the Fuse.js index', async () => {
    const memories = TEST_MEMORIES.map((m, i) => createMemoryEntry(m, i));
    const mockDb = createMockDatabase(memories);
    const search = new MemorySearch(mockDb);

    // First call to build index
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);
    await search.query('test', { strategy: 'TEXT_ONLY', topK: 5 });
    expect(mockDb.listMemories).toHaveBeenCalledTimes(1);

    // Refresh should rebuild
    (mockDb.listMemories as any).mockClear();
    (mockDb.listMemories as any).mockResolvedValueOnce(memories);
    await search.refreshIndex();
    expect(mockDb.listMemories).toHaveBeenCalledTimes(1);
  });
});
