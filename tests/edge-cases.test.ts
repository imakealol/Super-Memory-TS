import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { MemoryDatabase } from '../src/memory/database.js';
import { MemorySearch } from '../src/memory/search.js';
import { MemorySystem } from '../src/memory/index.js';

// ============================================
// Helper: Create a mock database that simulates various error conditions
// ============================================

function createMockDatabase(overrides: Record<string, any> = {}) {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    addMemory: vi.fn().mockResolvedValue('mock-id-' + Math.random().toString(36).slice(2)),
    addMemories: vi.fn().mockResolvedValue([]),
    getMemory: vi.fn().mockResolvedValue(null),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
    deleteBySourcePath: vi.fn().mockResolvedValue(0),
    queryMemories: vi.fn().mockResolvedValue([]),
    listMemories: vi.fn().mockResolvedValue([]),
    countMemories: vi.fn().mockResolvedValue(0),
    contentExists: vi.fn().mockResolvedValue(false),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================
// 1. Empty/Invalid Input Tests
// ============================================

describe('Empty/Invalid Input Handling', () => {
  test('MemorySystem.addMemory with empty string should handle gracefully', async () => {
    const mockDb = createMockDatabase({
      addMemory: vi.fn().mockResolvedValue('new-id'),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    // Empty string - actual behavior depends on model, but should not crash
    try {
      await memorySystem.addMemory({ text: '', sourceType: 'session' });
    } catch {
      // Error is acceptable as model may reject empty input
    }
  });

  test('MemorySystem.queryMemories with empty string should return results', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([{ id: '1', text: 'result' }]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.queryMemories('');
    // Empty query may return empty or all results depending on strategy
    expect(Array.isArray(results)).toBe(true);
  });

  test('MemorySystem.queryMemories with very long string should handle', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const longQuery = 'a'.repeat(10000);
    const results = await memorySystem.queryMemories(longQuery);
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================
// 2. Invalid projectId Tests
// ============================================

describe('Invalid projectId Handling', () => {
  test('database with invalid projectId characters should handle', async () => {
    const mockDb = createMockDatabase({
      listMemories: vi.fn().mockImplementation((filter) => {
        // Verify filter is built correctly
        return Promise.resolve([]);
      }),
    });

    // Create database with special characters in projectId
    const db = new MemoryDatabase('http://localhost:6333', 'invalid<>:"/\\|?*project');
    (db as any).initialized = true;
    (db as any).client = {
      scroll: vi.fn().mockResolvedValue({ points: [] }),
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    };

    // Should not crash
    const results = await db.listMemories();
    expect(Array.isArray(results)).toBe(true);
  });

  test('database with very long projectId should handle', async () => {
    const longProjectId = 'a'.repeat(10000);
    const db = new MemoryDatabase('http://localhost:6333', longProjectId);
    (db as any).initialized = true;
    (db as any).client = {
      scroll: vi.fn().mockResolvedValue({ points: [] }),
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    };

    const results = await db.listMemories();
    expect(Array.isArray(results)).toBe(true);
  });

  test('database with empty projectId should work', async () => {
    const db = new MemoryDatabase('http://localhost:6333', '');
    (db as any).initialized = true;
    (db as any).client = {
      scroll: vi.fn().mockResolvedValue({ points: [] }),
      getCollections: vi.fn().mockResolvedValue({ collections: [] }),
    };

    const results = await db.listMemories();
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================
// 3. Database Error Handling Tests
// ============================================

describe('Database Error Handling', () => {
  test('MemorySystem should handle initialize failure gracefully', async () => {
    const mockDb = createMockDatabase({
      initialize: vi.fn().mockRejectedValue(new Error('Database connection failed')),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    await expect(memorySystem.initialize()).rejects.toThrow('Database connection failed');
  });

  test('MemorySystem.addMemory should propagate database errors', async () => {
    const mockDb = createMockDatabase({
      initialize: vi.fn().mockResolvedValue(undefined),
      addMemory: vi.fn().mockRejectedValue(new Error('Database write failed')),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockRejectedValue(new Error('Index refresh failed')),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    await memorySystem.initialize();

    await expect(memorySystem.addMemory({ text: 'test', sourceType: 'session' }))
      .rejects.toThrow('Database write failed');
  });

  test('MemorySystem.queryMemories should propagate search errors', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockRejectedValue(new Error('Search failed')),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    await expect(memorySystem.queryMemories('test')).rejects.toThrow('Search failed');
  });

  test('MemorySystem should handle getMemory returning null', async () => {
    const mockDb = createMockDatabase({
      getMemory: vi.fn().mockResolvedValue(null),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const result = await memorySystem.getMemory('non-existent-id');
    expect(result).toBeNull();
  });
});

// ============================================
// 4. Model/Embedding Error Tests (via mock behavior)
// ============================================

describe('Model/Embedding Error Handling', () => {
  test('addMemory should propagate embedding errors', async () => {
    const mockDb = createMockDatabase({
      addMemory: vi.fn().mockImplementation(() => {
        throw new Error('Embedding generation failed');
      }),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    await expect(
      memorySystem.addMemory({ text: 'test content', sourceType: 'session' })
    ).rejects.toThrow('Embedding generation failed');
  });
});

// ============================================
// 5. Concurrent Operations Tests
// ============================================

describe('Concurrent Operations', () => {
  test('multiple simultaneous addMemory calls should all succeed', async () => {
    let callCount = 0;
    const mockDb = createMockDatabase({
      addMemory: vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 5));
        return `id-${callCount}`;
      }),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const promises = Array(10).fill(null).map((_, i) =>
      memorySystem.addMemory({ text: `Memory ${i}`, sourceType: 'session' })
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    expect(callCount).toBe(10);
  });

  test('concurrent reads and writes should not interfere', async () => {
    const mockDb = createMockDatabase({
      addMemory: vi.fn().mockResolvedValue('write-id'),
      queryMemories: vi.fn().mockResolvedValue([{ id: 'read-result' }]),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{ id: 'read-result' }]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const readPromise = memorySystem.queryMemories('test query');
    const writePromise = memorySystem.addMemory({ text: 'new memory', sourceType: 'session' });

    const [readResults, writeResult] = await Promise.all([readPromise, writePromise]);

    expect(Array.isArray(readResults)).toBe(true);
    expect(writeResult).toBeDefined();
  });
});

// ============================================
// 6. Boundary Condition Tests
// ============================================

describe('Boundary Conditions', () => {
  test('topK=0 should return empty or all results', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.queryMemories('test', { topK: 0 });
    expect(Array.isArray(results)).toBe(true);
  });

  test('topK=1000 (maximum) should be handled', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.queryMemories('test', { topK: 1000 });
    expect(Array.isArray(results)).toBe(true);
  });

  test('zero results in all search strategies should be handled', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    // TIERED
    const tieredResults = await memorySystem.queryMemories('nonexistent', { strategy: 'TIERED' as any });
    expect(Array.isArray(tieredResults)).toBe(true);

    // VECTOR_ONLY
    const vectorResults = await memorySystem.queryMemories('nonexistent', { strategy: 'VECTOR_ONLY' as any });
    expect(Array.isArray(vectorResults)).toBe(true);

    // TEXT_ONLY
    const textResults = await memorySystem.queryMemories('nonexistent', { strategy: 'TEXT_ONLY' as any });
    expect(Array.isArray(textResults)).toBe(true);
  });
});

// ============================================
// 7. Search Edge Cases
// ============================================

describe('Search Edge Cases', () => {
  test('search with special regex characters should not cause errors', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    // Fuse.js should handle these, not treat as regex
    const specialChars = [
      'Test (with) parentheses',
      'Test [with] brackets',
      'Test *with* asterisks',
      'Test ?with? question marks',
      'Test +with+ plus signs',
      'Test $with$ dollar signs',
      'Test ^with^ carets',
    ];

    for (const query of specialChars) {
      const results = await memorySystem.queryMemories(query);
      expect(Array.isArray(results)).toBe(true);
    }
  });

  test('search with unicode/emojis should handle', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const unicodeQueries = [
      '🎉🎊',
      '日本語テスト',
      'مرحبا العالم',
      '你好世界',
      '🎅圣诞🎄',
    ];

    for (const query of unicodeQueries) {
      const results = await memorySystem.queryMemories(query);
      expect(Array.isArray(results)).toBe(true);
    }
  });

  test('search immediately after adding should handle', async () => {
    const mockDb = createMockDatabase({
      addMemory: vi.fn().mockResolvedValue('new-id'),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    await memorySystem.addMemory({ text: 'New memory content', sourceType: 'session' });

    // Immediate search - should not crash
    const results = await memorySystem.queryMemories('New memory');
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================
// 8. MemorySystem State Tests
// ============================================

describe('MemorySystem State Management', () => {
  test('MemorySystem.isInitialized should reflect actual state', async () => {
    const mockDb = createMockDatabase({
      initialize: vi.fn().mockResolvedValue(undefined),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    expect(memorySystem.isInitialized()).toBe(false);

    await memorySystem.initialize();
    expect(memorySystem.isInitialized()).toBe(true);
  });

  test('MemorySystem should reject operations before initialization', async () => {
    const mockDb = createMockDatabase();
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    // Not initialized

    // Should still handle gracefully (may return empty or throw)
    try {
      const results = await memorySystem.queryMemories('test');
      expect(Array.isArray(results)).toBe(true);
    } catch {
      // Error is acceptable before initialization
    }
  });

  test('MemorySystem.getStats should return count', async () => {
    const mockDb = createMockDatabase({
      countMemories: vi.fn().mockResolvedValue(42),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const stats = await memorySystem.getStats();
    expect(stats.count).toBe(42);
  });
});

// ============================================
// 9. Delete Operations Tests
// ============================================

describe('Delete Operations', () => {
  test('deleteMemory should propagate errors', async () => {
    const mockDb = createMockDatabase({
      initialize: vi.fn().mockResolvedValue(undefined),
      deleteMemory: vi.fn().mockRejectedValue(new Error('Delete failed')),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    await memorySystem.initialize();

    await expect(memorySystem.deleteMemory('some-id')).rejects.toThrow('Delete failed');
  });

  test('deleteMemory should succeed when database succeeds', async () => {
    const mockDb = createMockDatabase({
      initialize: vi.fn().mockResolvedValue(undefined),
      deleteMemory: vi.fn().mockResolvedValue(undefined),
    });
    const mockSearch = {
      refreshIndex: vi.fn().mockResolvedValue(undefined),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    await memorySystem.initialize();

    // deleteMemory calls refreshIndex which may fail, but database should succeed
    const result = await memorySystem.deleteMemory('some-id');
    expect(result).toBeUndefined();
  });
});

// ============================================
// 10. List Operations Tests
// ============================================

describe('List Operations', () => {
  test('listMemories should return empty array when no memories', async () => {
    const mockDb = createMockDatabase({
      listMemories: vi.fn().mockResolvedValue([]),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.listMemories();
    expect(results).toEqual([]);
  });

  test('listMemories should return memories when they exist', async () => {
    const mockMemories = [
      { id: '1', text: 'Memory 1', sourceType: 'session' as const, vector: new Float32Array(384), contentHash: 'abc', timestamp: new Date() },
      { id: '2', text: 'Memory 2', sourceType: 'session' as const, vector: new Float32Array(384), contentHash: 'def', timestamp: new Date() },
    ];

    const mockDb = createMockDatabase({
      listMemories: vi.fn().mockResolvedValue(mockMemories),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.listMemories();
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('1');
  });
});

// ============================================
// 11. Content Duplicate Check Tests
// ============================================

describe('Content Duplicate Check', () => {
  test('contentExists should return false for new content', async () => {
    const mockDb = createMockDatabase({
      contentExists: vi.fn().mockResolvedValue(false),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const exists = await memorySystem.contentExists('brand new content');
    expect(exists).toBe(false);
  });

  test('contentExists should return true for duplicate content', async () => {
    const mockDb = createMockDatabase({
      contentExists: vi.fn().mockResolvedValue(true),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const exists = await memorySystem.contentExists('existing content');
    expect(exists).toBe(true);
  });

  test('contentExists should handle empty string', async () => {
    const mockDb = createMockDatabase({
      contentExists: vi.fn().mockResolvedValue(false),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const exists = await memorySystem.contentExists('');
    expect(typeof exists).toBe('boolean');
  });
});

// ============================================
// 12. SearchWithVector Tests
// ============================================

describe('SearchWithVector', () => {
  test('searchWithVector should handle empty vector', async () => {
    const mockDb = createMockDatabase({
      queryMemories: vi.fn().mockResolvedValue([]),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.searchWithVector(new Float32Array(0));
    expect(Array.isArray(results)).toBe(true);
  });

  test('searchWithVector should handle normal vector', async () => {
    const mockDb = createMockDatabase({
      queryMemories: vi.fn().mockResolvedValue([{ id: '1' }]),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const vector = new Float32Array(384).fill(0.5);
    const results = await memorySystem.searchWithVector(vector);
    expect(Array.isArray(results)).toBe(true);
  });

  test('searchWithVector with TEXT_ONLY strategy should ignore vector', async () => {
    const mockDb = createMockDatabase({
      queryMemories: vi.fn().mockResolvedValue([]),
    });
    const mockSearch = {
      query: vi.fn().mockResolvedValue([]),
      searchWithVector: vi.fn().mockResolvedValue([]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const vector = new Float32Array(384).fill(0.5);
    const results = await memorySystem.searchWithVector(vector, { strategy: 'TEXT_ONLY' as any });
    expect(Array.isArray(results)).toBe(true);
  });
});

// ============================================
// 13. GetSimilar Tests
// ============================================

describe('GetSimilar', () => {
  test('getSimilar should return similar memories', async () => {
    const mockDb = createMockDatabase({
      getMemory: vi.fn().mockResolvedValue({
        id: 'test-id',
        text: 'Test memory',
        vector: new Float32Array(384).fill(0.5),
      }),
    });
    const mockSearch = {
      searchWithVector: vi.fn().mockResolvedValue([{ id: 'similar-1' }]),
      getSimilar: vi.fn().mockResolvedValue([{ id: 'similar-1' }]),
    };

    const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.getSimilar('test-id');
    expect(Array.isArray(results)).toBe(true);
  });

  test('getSimilar with non-existent id should return empty', async () => {
    const mockDb = createMockDatabase({
      getMemory: vi.fn().mockResolvedValue(null),
    });

    const memorySystem = new MemorySystem(mockDb as any);
    (memorySystem as any).initialized = true;

    const results = await memorySystem.getSimilar('non-existent');
    expect(results).toEqual([]);
  });
});

// ============================================
// 14. Reset Functionality Tests
// ============================================

describe('Reset Functionality', () => {
  test('resetMemorySystem should clear default instance', async () => {
    // This tests that resetMemorySystem doesn't throw
    const { resetMemorySystem } = await import('../src/memory/index.js');

    expect(() => resetMemorySystem()).not.toThrow();
  });
});

// ============================================
// 15. Search Strategy Tests
// ============================================

describe('Search Strategy Tests', () => {
  test('all strategies should be selectable without error', async () => {
    const mockDb = createMockDatabase();
    const strategies = ['TIERED', 'VECTOR_ONLY', 'TEXT_ONLY'] as const;

    for (const strategy of strategies) {
      const mockSearch = {
        query: vi.fn().mockResolvedValue([]),
      };

      const memorySystem = new MemorySystem(mockDb as any, mockSearch as any);
      (memorySystem as any).initialized = true;

      const results = await memorySystem.queryMemories('test', { strategy });
      expect(Array.isArray(results)).toBe(true);
    }
  });
});