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

  test('TEXT_ONLY should not call db.queryMemories', async () => {
    await search.query('test', { strategy: 'TEXT_ONLY', topK: 5 });
    expect(mockDb.queryMemories).not.toHaveBeenCalled();
  });

  test('VECTOR_ONLY should call db.queryMemories', async () => {
    const mockResults = [];
    mockDb.queryMemories = vi.fn().mockResolvedValue(mockResults);

    await search.query('test', { strategy: 'VECTOR_ONLY', topK: 5 });
    expect(mockDb.queryMemories).toHaveBeenCalled();
  });
});
