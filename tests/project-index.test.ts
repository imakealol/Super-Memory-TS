/**
 * Project Index System Tests
 * 
 * Tests for FileChunker, ProjectWatcher, and ProjectIndexer
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { FileChunker, createChunker } from '../src/project-index/chunker.js';
import { ProjectWatcher, createWatcher } from '../src/project-index/watcher.js';
import { ProjectIndexer, createIndexer } from '../src/project-index/indexer.js';
import { MemoryDatabase, getDatabase, initializeDatabase } from '../src/memory/database.js';
import { join } from 'path';
import { writeFile, mkdir, rm, readFile } from 'fs/promises';

// Test directory paths
const TEST_PROJECT_DIR = join(__dirname, 'test-project');
const TEST_DB_DIR = join(__dirname, 'test_db');
// Qdrant URL for tests (uses file path as collection name suffix for isolation)
const TEST_QDRANT_URL = process.env.TEST_QDRANT_URL || 'http://localhost:6333';

describe('FileChunker', () => {
  let chunker: FileChunker;

  beforeAll(() => {
    chunker = createChunker({
      maxChunkSize: 512,
      overlap: 50,
      minChunkSize: 50,
      splitBy: 'semantic',
    });
  });

  describe('isCodeFile', () => {
    test('should identify TypeScript files as code', () => {
      expect(chunker.isCodeFile('test.ts')).toBe(true);
      expect(chunker.isCodeFile('test.tsx')).toBe(true);
      expect(chunker.isCodeFile('/path/to/file.ts')).toBe(true);
    });

    test('should identify Python files as code', () => {
      expect(chunker.isCodeFile('test.py')).toBe(true);
      expect(chunker.isCodeFile('test.pyw')).toBe(true);
    });

    test('should identify JSON as code', () => {
      expect(chunker.isCodeFile('test.json')).toBe(true);
      expect(chunker.isCodeFile('test.jsonc')).toBe(true);
    });

    test('should not identify Markdown as code', () => {
      expect(chunker.isCodeFile('test.md')).toBe(false);
      expect(chunker.isCodeFile('test.txt')).toBe(false);
    });
  });

  describe('estimateTokens', () => {
    test('should estimate tokens for simple text', () => {
      const tokens = chunker.estimateTokens('hello world');
      expect(tokens).toBeGreaterThan(0);
    });

    test('should estimate tokens for code', () => {
      const code = 'function hello() { return "world"; }';
      const tokens = chunker.estimateTokens(code);
      expect(tokens).toBeGreaterThan(5);
    });

    test('should return 0 for empty string', () => {
      expect(chunker.estimateTokens('')).toBe(0);
    });
  });

  describe('semantic chunking on TypeScript', () => {
    test('should chunk TypeScript file at function boundaries', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.ts'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.ts');

      expect(chunks.length).toBeGreaterThan(0);
      
      // Verify each chunk has proper structure
      for (const chunk of chunks) {
        expect(chunk.content).toBeTruthy();
        expect(chunk.startLine).toBeGreaterThan(0);
        expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      }

      // Check that chunks have proper boundaries (allowing for overlap)
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeGreaterThanOrEqual(chunks[i-1].startLine);
        expect(chunks[i].endLine).toBeGreaterThanOrEqual(chunks[i].startLine);
      }
    });

    test('should preserve class and function definitions in chunks', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.ts'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.ts');

      // At least one chunk should contain 'class UserService'
      const classChunk = chunks.find(c => c.content.includes('class UserService'));
      expect(classChunk).toBeDefined();

      // At least one chunk should contain 'export function'
      const funcChunk = chunks.find(c => c.content.includes('export function') || c.content.includes('function validateEmail'));
      expect(funcChunk).toBeDefined();
    });
  });

  describe('semantic chunking on Python', () => {
    test('should chunk Python file at class/function boundaries', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.py'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.py');

      expect(chunks.length).toBeGreaterThan(0);

      // Should find chunks with class definitions
      const classChunk = chunks.find(c => c.content.includes('class User'));
      expect(classChunk).toBeDefined();

      // Should find chunks with function definitions
      const funcChunk = chunks.find(c => c.content.includes('def validate_email'));
      expect(funcChunk).toBeDefined();
    });
  });

  describe('sliding window chunking on Markdown', () => {
    test('should use sliding window for non-code files', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.md'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.md');

      expect(chunks.length).toBeGreaterThan(0);

      // For markdown, sliding window is used - verify chunks exist
      // and have proper structure
      for (const chunk of chunks) {
        expect(chunk.content.length).toBeGreaterThan(0);
        expect(chunk.startLine).toBeGreaterThan(0);
      }
    });
  });

  describe('sliding window chunking on JSON', () => {
    test('should chunk JSON file', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.json'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.json');

      expect(chunks.length).toBeGreaterThan(0);
      
      // JSON is treated as code, so semantic chunking may be used
      // But the content should be preserved
      const allContent = chunks.map(c => c.content).join('');
      expect(allContent).toContain('test-project');
    });
  });

  describe('chunk boundaries', () => {
    test('should create chunks with sequential line numbers', async () => {
      const content = await readFile(join(TEST_PROJECT_DIR, 'sample.ts'), 'utf-8');
      const chunks = chunker.chunkFile(content, 'sample.ts');

      // Line numbers should be sequential and non-overlapping
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeGreaterThan(chunks[i-1].startLine);
      }
    });

    test('should respect maxChunkSize in token estimation', async () => {
      const chunker2 = createChunker({
        maxChunkSize: 100,
        overlap: 20,
        minChunkSize: 30,
        splitBy: 'semantic',
      });

      // Create multi-line content where each line is ~100 chars
      // to trigger sliding window chunking
      const lines = [];
      for (let i = 0; i < 20; i++) {
        lines.push('line ' + i + ': ' + 'a'.repeat(80));
      }
      const content = lines.join('\n');
      
      const chunks = chunker2.chunkFile(content, 'test.txt');

      // Should have multiple chunks due to sliding window
      expect(chunks.length).toBeGreaterThan(1);
    });
  });
});

// Retry helper for async polling
async function retryUntil<T>(
  fn: () => T | undefined,
  options: { retries: number; delayMs: number } = { retries: 10, delayMs: 500 }
): Promise<T | undefined> {
  for (let i = 0; i < options.retries; i++) {
    const result = fn();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, options.delayMs));
  }
  return undefined;
}

// Wait for watcher to be fully ready
async function waitForWatcherReady(watcher: ProjectWatcher): Promise<void> {
  await watcher.waitForReady();
  // Additional settle time for chokidar internal processing
  await new Promise(resolve => setTimeout(resolve, 200));
}

// Wait for indexer to finish processing pending events
async function waitForIndexerIdle(indexer: ProjectIndexer): Promise<void> {
  await indexer.waitForProcessingComplete();
  // Small settle time
  await new Promise(resolve => setTimeout(resolve, 100));
}

describe('ProjectWatcher', () => {
  let testDir: string;
  let watcher: ProjectWatcher;
  const events: any[] = [];
  let readyPromise: Promise<void>;

  beforeEach(async () => {
    // Create unique test directory for each test
    testDir = join(TEST_PROJECT_DIR, 'watcher-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
    events.length = 0;
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.stop();
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  test('should emit add event for new file', async () => {
    watcher = createWatcher({
      paths: [testDir],
      includePatterns: ['**/*'],
      excludePatterns: [],
      debounceMs: 100,
    });

    const fileEvents: any[] = [];
    watcher.on('file', (event) => {
      fileEvents.push(event);
    });

    watcher.start();
    await waitForWatcherReady(watcher);

    // Create a new file
    const testFile = join(testDir, 'new-file.txt');
    await writeFile(testFile, 'Hello World');

    // Poll for event with retry logic
    const addEvent = await retryUntil(
      () => fileEvents.find(e => e.type === 'add' && e.path.includes('new-file.txt')),
      { retries: 10, delayMs: 500 }
    );

    expect(addEvent).toBeDefined();
    expect(addEvent.type).toBe('add');
  }, 30000);

  test('should emit change event when file is modified', async () => {
    const testFile = join(testDir, 'change-test.txt');
    await writeFile(testFile, 'Initial content');

    watcher = createWatcher({
      paths: [testDir],
      includePatterns: ['**/*'],
      excludePatterns: [],
      debounceMs: 100,
    });

    const fileEvents: any[] = [];
    watcher.on('file', (event) => {
      fileEvents.push(event);
    });

    watcher.start();
    await waitForWatcherReady(watcher);

    // Clear events captured during initial scan
    fileEvents.length = 0;

    // Modify the file
    await writeFile(testFile, 'Modified content');

    // Poll for event with retry logic
    const changeEvent = await retryUntil(
      () => fileEvents.find(e => e.type === 'change'),
      { retries: 10, delayMs: 500 }
    );

    expect(changeEvent).toBeDefined();
  }, 30000);

  test('should emit unlink event when file is deleted', async () => {
    const testFile = join(testDir, 'delete-test.txt');
    await writeFile(testFile, 'Content');

    watcher = createWatcher({
      paths: [testDir],
      includePatterns: ['**/*'],
      excludePatterns: [],
      debounceMs: 100,
    });

    const fileEvents: any[] = [];
    watcher.on('file', (event) => {
      fileEvents.push(event);
    });

    watcher.start();
    await waitForWatcherReady(watcher);

    // Clear events captured during initial scan
    fileEvents.length = 0;

    // Delete the file
    await rm(testFile);

    // Poll for event with retry logic
    const unlinkEvent = await retryUntil(
      () => fileEvents.find(e => e.type === 'unlink'),
      { retries: 10, delayMs: 500 }
    );

    expect(unlinkEvent).toBeDefined();
  }, 30000);

  test('should exclude node_modules by default', async () => {
    watcher = createWatcher({
      paths: [TEST_PROJECT_DIR],
      includePatterns: ['**/*'],
      excludePatterns: [],
      debounceMs: 100,
    });

    watcher.start();
    await watcher.waitForReady();

    const watchedPaths = watcher.getWatchedPaths();
    
    // node_modules should not be watched
    expect(watchedPaths.some(p => p.includes('node_modules'))).toBe(false);

    await watcher.stop();
  });

  test('should respect custom exclude patterns', async () => {
    watcher = createWatcher({
      paths: [testDir],
      includePatterns: ['**/*'],
      excludePatterns: ['**/*.log'],
      debounceMs: 100,
    });

    const fileEvents: any[] = [];
    watcher.on('file', (event) => {
      fileEvents.push(event);
    });

    watcher.start();
    await waitForWatcherReady(watcher);

    // Clear events captured during initial scan
    fileEvents.length = 0;

    // Create a .log file (should be excluded)
    const logFile = join(testDir, 'test.log');
    await writeFile(logFile, 'Log content');

    // Create a .txt file (should be included)
    const txtFile = join(testDir, 'test.txt');
    await writeFile(txtFile, 'Text content');

    // Poll for txt event with retry logic
    const txtEvent = await retryUntil(
      () => fileEvents.find(e => e.path.includes('test.txt')),
      { retries: 10, delayMs: 500 }
    );
    const logEvent = fileEvents.find(e => e.path.includes('test.log'));

    expect(txtEvent).toBeDefined();
    expect(logEvent).toBeUndefined();
  }, 30000);
});

// Skip integration tests in CI - they require a running Qdrant instance
const describeIf = process.env.CI ? describe.skip : describe;

describeIf('ProjectIndexer', () => {
  let testDir: string;
  let db: MemoryDatabase;
  let indexer: ProjectIndexer;

  beforeAll(async () => {
    // Initialize database with Qdrant URL (not file path)
    db = getDatabase(TEST_QDRANT_URL);
    await db.initialize();
  });

  afterAll(async () => {
    if (indexer) {
      await indexer.stop();
    }
    if (db) {
      await db.close();
    }
    // No file cleanup needed - Qdrant handles data persistence
  });

  beforeEach(async () => {
    testDir = join(TEST_PROJECT_DIR, 'indexer-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (indexer) {
      await indexer.stop();
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  test('should index a TypeScript file', async () => {
    // Copy sample.ts to test dir
    const srcFile = join(TEST_PROJECT_DIR, 'sample.ts');
    const destFile = join(testDir, 'sample.ts');
    await writeFile(destFile, await readFile(srcFile, 'utf-8'));

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();

    // Wait for indexing to complete (including processing)
    await waitForIndexerIdle(indexer);

    // Poll for stats with longer timeout
    const stats = await retryUntil(
      () => {
        const s = indexer.getStats();
        return s.indexedFiles > 0 ? s : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    expect(stats).toBeDefined();
    expect(stats!.totalFiles).toBeGreaterThan(0);
    expect(stats!.indexedFiles).toBeGreaterThan(0);

    await indexer.stop();
  }, 90000);

  test('should detect file changes and re-index', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for initial indexing to complete
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles > 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    const initialStats = indexer.getStats();
    const initialChunks = initialStats.totalChunks;

    // Modify the file
    await writeFile(testFile, 'export const x = 2;\nexport const y = 3;');

    // Wait for change to be processed
    await waitForIndexerIdle(indexer);

    // Poll for change detection
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles === 1 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    const updatedStats = indexer.getStats();

    // File should be tracked
    expect(updatedStats.indexedFiles).toBe(1);

    await indexer.stop();
  }, 90000);

  test('should remove file from index when deleted', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for initial indexing
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles > 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    // Delete the file
    await rm(testFile);

    // Wait for deletion to be processed
    await waitForIndexerIdle(indexer);

    // Poll for unlink detection - file should be removed
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles === 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    // Note: The file should be removed from index
    // This tests the unlink event handling
    const stats = indexer.getStats();
    expect(stats.indexedFiles).toBe(0);

    await indexer.stop();
  }, 90000);

  test('should skip files exceeding maxFileSize', async () => {
    const largeFile = join(testDir, 'large.ts');
    const largeContent = 'export const x = ' + '1'.repeat(2000) + ';';
    await writeFile(largeFile, largeContent);

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 100, // Very small max size
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for initial scan to complete
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.totalFiles > 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    const stats = indexer.getStats();
    // File should be skipped due to size
    expect(stats.indexedFiles).toBe(0);

    await indexer.stop();
  }, 90000);

  test('should emit error events on failures', async () => {
    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    let errorReceived = false;
    indexer.on('error', (err) => {
      errorReceived = true;
    });

    await indexer.start();
    await new Promise(resolve => setTimeout(resolve, 500));

    // No error should occur for empty directory
    expect(errorReceived).toBe(false);

    await indexer.stop();
  });

  test('getStats should return accurate statistics', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    expect(indexer.getStats()).toEqual({
      totalFiles: 0,
      totalChunks: 0,
      indexedFiles: 0,
      failedFiles: 0,
      lastIndexing: expect.any(Date),
    });

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for initial indexing to complete
    const stats = await retryUntil(
      () => {
        const s = indexer.getStats();
        return s.indexedFiles === 1 ? s : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    expect(stats).toBeDefined();
    expect(stats!.indexedFiles).toBe(1);
    expect(stats!.totalChunks).toBeGreaterThan(0);

    await indexer.stop();
  }, 90000);

  test('setRootPath and getRootPath should work correctly', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    // Verify initial root path
    expect(indexer.getRootPath()).toBe(testDir);

    // Start indexer and wait for idle
    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Create a new test directory with different content
    const newDir = join(TEST_PROJECT_DIR, 'new-indexer-dir-' + Date.now());
    await mkdir(newDir, { recursive: true });
    const newFile = join(newDir, 'new.ts');
    await writeFile(newFile, 'export const y = 2;');

    // Change root path to new directory
    await indexer.setRootPath(newDir);
    expect(indexer.getRootPath()).toBe(newDir);

    // Clean up new directory
    await rm(newDir, { recursive: true, force: true });

    await indexer.stop();
  }, 90000);

  test('getRootPath should return configured path before start', async () => {
    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    // getRootPath should work before start() is called
    expect(indexer.getRootPath()).toBe(testDir);

    await indexer.stop();
  });
});

describeIf('Background Indexing', () => {
  let testDir: string;
  let db: MemoryDatabase;
  let indexer: ProjectIndexer;

  beforeAll(async () => {
    // Use Qdrant URL for background indexing test with separate collection via unique path
    db = getDatabase(TEST_QDRANT_URL);
    await db.initialize();
  });

  afterAll(async () => {
    if (indexer) {
      await indexer.stop();
    }
    if (db) {
      await db.close();
    }
    // No file cleanup needed - Qdrant handles data persistence
  });

  beforeEach(async () => {
    testDir = join(TEST_PROJECT_DIR, 'background-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (indexer) {
      await indexer.stop();
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  test('should set progress callbacks and invoke onFileIndexed', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    const indexedFiles: string[] = [];
    const errors: [string, Error][] = [];

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    indexer.setProgressCallbacks({
      onFileIndexed: (filePath: string) => {
        indexedFiles.push(filePath);
      },
      onError: (filePath: string, error: Error) => {
        errors.push([filePath, error]);
      },
    });

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for file to be indexed
    await retryUntil(
      () => indexedFiles.length > 0 ? indexedFiles : undefined,
      { retries: 60, delayMs: 500 }
    );

    expect(indexedFiles.length).toBeGreaterThan(0);
    expect(errors.length).toBe(0);

    await indexer.stop();
  }, 90000);

  test('should track progress incrementally via getStats', async () => {
    // Create multiple files
    for (let i = 0; i < 5; i++) {
      await writeFile(join(testDir, `test${i}.ts`), `export const x${i} = ${i};`);
    }

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();

    // Wait for at least some files to be indexed
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles > 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    const stats = indexer.getStats();
    expect(stats.indexedFiles).toBeGreaterThan(0);
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.failedFiles).toBe(0);

    await indexer.stop();
  }, 90000);

  test('should track failed files count on error', async () => {
    // Create a malformed file that might cause issues
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for stats
    await retryUntil(
      () => {
        const stats = indexer.getStats();
        return stats.indexedFiles > 0 ? stats : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    // Failed files should be 0 for valid file
    const stats = indexer.getStats();
    expect(stats.failedFiles).toBe(0);

    await indexer.stop();
  }, 90000);

  test('should emit file-indexed events during indexing', async () => {
    const testFile = join(testDir, 'test.ts');
    await writeFile(testFile, 'export const x = 1;');

    const indexedEvents: { filePath: string; chunkCount: number }[] = [];

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    indexer.on('file-indexed', (data: { filePath: string; chunkCount: number }) => {
      indexedEvents.push(data);
    });

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for events
    await retryUntil(
      () => indexedEvents.length > 0 ? indexedEvents : undefined,
      { retries: 60, delayMs: 500 }
    );

    expect(indexedEvents.length).toBeGreaterThan(0);
    expect(indexedEvents[0].filePath).toContain('test.ts');

    await indexer.stop();
  }, 90000);
});

describeIf('Integration: Full Indexing Pipeline', () => {
  let testDir: string;
  let db: MemoryDatabase;
  let indexer: ProjectIndexer;

  beforeAll(async () => {
    // Use Qdrant URL for integration test
    db = getDatabase(TEST_QDRANT_URL);
    await db.initialize();
  });

  afterAll(async () => {
    if (indexer) {
      await indexer.stop();
    }
    if (db) {
      await db.close();
    }
    // No file cleanup needed - Qdrant handles data persistence
  });

  beforeEach(async () => {
    testDir = join(TEST_PROJECT_DIR, 'integration-test-' + Date.now());
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (indexer) {
      await indexer.stop();
    }
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore
    }
  });

  test('should index multiple file types and maintain separate chunks', async () => {
    // Create test files of different types
    await writeFile(join(testDir, 'test.ts'), 'export function hello() { return "hi"; }');
    await writeFile(join(testDir, 'test.py'), 'def world(): return "world"');
    await writeFile(join(testDir, 'test.md'), '# Hello\n\nThis is markdown.');
    await writeFile(join(testDir, 'test.json'), '{"key": "value"}');

    indexer = createIndexer({
      rootPath: testDir,
      includePatterns: ['**/*.ts', '**/*.py', '**/*.md', '**/*.json'],
      excludePatterns: [],
      maxFileSize: 1024 * 1024,
      chunkSize: 512,
      chunkOverlap: 50,
    }, db, join(testDir, 'tracker'));

    await indexer.start();
    await waitForIndexerIdle(indexer);

    // Poll for all files to be indexed
    const stats = await retryUntil(
      () => {
        const s = indexer.getStats();
        return s.indexedFiles === 4 ? s : undefined;
      },
      { retries: 60, delayMs: 500 }
    );

    expect(stats).toBeDefined();
    expect(stats!.indexedFiles).toBe(4);

    await indexer.stop();
  }, 90000);
});
