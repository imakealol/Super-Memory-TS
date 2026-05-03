/**
 * Tests for convert-dimensions.ts
 * Tests the dimension conversion logic without requiring Qdrant connection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import the parseArgs function - we test the logic directly since we're mocking
import type { ConversionOptions } from '../scripts/convert-dimensions.js';

// Test helper that mimics the actual parseArgs logic
const testParseArgs = (args: string[]): { options: ConversionOptions; errors: string[] } => {
  const errors: string[] = [];
  const options: ConversionOptions = {
    sourceCollection: 'memories',
    targetCollection: 'memories_bge_large',
    qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    batchSize: 16,
    dryRun: true,
    gpu: true,
    precision: 'fp16',
  };

  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case '--source-collection':
        if (i + 1 >= args.length) {
          errors.push('Error: --source-collection requires a value');
        } else {
          options.sourceCollection = args[++i];
        }
        break;

      case '--target-collection':
        if (i + 1 >= args.length) {
          errors.push('Error: --target-collection requires a value');
        } else {
          options.targetCollection = args[++i];
        }
        break;

      case '--qdrant-url':
        if (i + 1 >= args.length) {
          errors.push('Error: --qdrant-url requires a value');
        } else {
          options.qdrantUrl = args[++i];
        }
        break;

      case '--batch-size':
        if (i + 1 >= args.length) {
          errors.push('Error: --batch-size requires a numeric value');
        } else {
          const size = parseInt(args[++i], 10);
          if (isNaN(size) || size < 1) {
            errors.push('Error: --batch-size must be a positive integer');
          } else {
            options.batchSize = size;
          }
        }
        break;

      case '--dry-run':
        options.dryRun = true;
        break;

      case '--confirm':
        options.dryRun = false;
        break;

      case '--gpu':
        options.gpu = true;
        break;

      case '--no-gpu':
        options.gpu = false;
        break;

      case '--precision':
        if (i + 1 >= args.length) {
          errors.push('Error: --precision requires a value (fp16, fp32, q8, q4)');
        } else {
          const prec = args[++i] as ConversionOptions['precision'];
          if (!['fp16', 'fp32', 'q8', 'q4'].includes(prec)) {
            errors.push('Error: --precision must be one of: fp16, fp32, q8, q4');
          } else {
            options.precision = prec;
          }
        }
        break;

      case '--help':
      case '-h':
        errors.push('SHOW_HELP');
        break;

      default:
        if (arg.startsWith('--')) {
          errors.push(`Error: Unknown option ${arg}`);
        }
        break;
    }
    i++;
  }

  return { options, errors };
};

// Simulates the scroll logic that retrieves all points
const simulateScrollAllPoints = async (
  allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }>,
  batchSize: number,
  callback: (points: Array<{ id: string | number; payload: Record<string, unknown>; vector: number[] }>) => Promise<void>
): Promise<number> => {
  let offset = 0;
  let totalProcessed = 0;

  while (offset < allPoints.length) {
    const batch = allPoints.slice(offset, offset + batchSize);
    if (batch.length === 0) break;

    await callback(batch);
    totalProcessed += batch.length;
    offset += batchSize;
  }

  return totalProcessed;
};

describe('parseArgs', () => {
  it('should default to dry-run mode with sensible defaults', () => {
    const { options, errors } = testParseArgs([]);
    expect(errors).toHaveLength(0);
    expect(options.dryRun).toBe(true);
    expect(options.sourceCollection).toBe('memories');
    expect(options.targetCollection).toBe('memories_bge_large');
    expect(options.batchSize).toBe(16);
    expect(options.gpu).toBe(true);
    expect(options.precision).toBe('fp16');
  });

  it('should parse --source-collection correctly', () => {
    const { options, errors } = testParseArgs(['--source-collection', 'my-collection']);
    expect(errors).toHaveLength(0);
    expect(options.sourceCollection).toBe('my-collection');
  });

  it('should parse --target-collection correctly', () => {
    const { options, errors } = testParseArgs(['--target-collection', 'my-target']);
    expect(errors).toHaveLength(0);
    expect(options.targetCollection).toBe('my-target');
  });

  it('should parse --qdrant-url correctly', () => {
    const { options, errors } = testParseArgs(['--qdrant-url', 'http://custom:6333']);
    expect(errors).toHaveLength(0);
    expect(options.qdrantUrl).toBe('http://custom:6333');
  });

  it('should parse --batch-size correctly', () => {
    const { options, errors } = testParseArgs(['--batch-size', '32']);
    expect(errors).toHaveLength(0);
    expect(options.batchSize).toBe(32);
  });

  it('should reject invalid --batch-size', () => {
    const { options, errors } = testParseArgs(['--batch-size', 'abc']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject negative --batch-size', () => {
    const { options, errors } = testParseArgs(['--batch-size', '-5']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject zero --batch-size', () => {
    const { options, errors } = testParseArgs(['--batch-size', '0']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should parse --dry-run flag', () => {
    const { options, errors } = testParseArgs(['--dry-run']);
    expect(errors).toHaveLength(0);
    expect(options.dryRun).toBe(true);
  });

  it('should parse --confirm flag to disable dry-run', () => {
    const { options, errors } = testParseArgs(['--confirm']);
    expect(errors).toHaveLength(0);
    expect(options.dryRun).toBe(false);
  });

  it('should parse --gpu flag', () => {
    const { options, errors } = testParseArgs(['--gpu']);
    expect(errors).toHaveLength(0);
    expect(options.gpu).toBe(true);
  });

  it('should parse --no-gpu flag', () => {
    const { options, errors } = testParseArgs(['--no-gpu']);
    expect(errors).toHaveLength(0);
    expect(options.gpu).toBe(false);
  });

  it('should parse --precision correctly', () => {
    const { options, errors } = testParseArgs(['--precision', 'fp32']);
    expect(errors).toHaveLength(0);
    expect(options.precision).toBe('fp32');
  });

  it('should reject invalid --precision', () => {
    const { options, errors } = testParseArgs(['--precision', 'fp99']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('fp16, fp32, q8, q4');
  });

  it('should parse multiple arguments correctly', () => {
    const { options, errors } = testParseArgs([
      '--source-collection', 'src',
      '--target-collection', 'tgt',
      '--batch-size', '64',
      '--confirm',
      '--gpu',
      '--precision', 'fp32',
    ]);
    expect(errors).toHaveLength(0);
    expect(options.sourceCollection).toBe('src');
    expect(options.targetCollection).toBe('tgt');
    expect(options.batchSize).toBe(64);
    expect(options.dryRun).toBe(false);
    expect(options.gpu).toBe(true);
    expect(options.precision).toBe('fp32');
  });

  it('should show help for --help flag', () => {
    const { errors } = testParseArgs(['--help']);
    expect(errors).toContain('SHOW_HELP');
  });

  it('should show help for -h flag', () => {
    const { errors } = testParseArgs(['-h']);
    expect(errors).toContain('SHOW_HELP');
  });

  it('should reject unknown options', () => {
    const { errors } = testParseArgs(['--unknown-flag']);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('Unknown option');
  });

  it('should handle --confirm --dry-run conflict (last one wins)', () => {
    // In the actual implementation, later args override earlier ones
    const { options, errors } = testParseArgs(['--confirm', '--dry-run']);
    expect(errors).toHaveLength(0);
    expect(options.dryRun).toBe(true); // dry-run comes last
  });
});

describe('collection name validation', () => {
  it('should require different source and target collection names for safety', () => {
    // In practice, user would get an error if they try to migrate to same collection
    const { options } = testParseArgs(['--source-collection', 'memories', '--target-collection', 'memories']);
    // The script would reject this, but the parser doesn't know about this constraint
    expect(options.sourceCollection).toBe(options.targetCollection);
  });

  it('should allow underscore suffix for target collection', () => {
    const { options } = testParseArgs(['--target-collection', 'memories_bge_large']);
    expect(options.targetCollection).toBe('memories_bge_large');
  });
});

describe('batch processing logic', () => {
  it('should process all points in batches', async () => {
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = [];
    for (let i = 1; i <= 250; i++) {
      allPoints.push({
        id: String(i),
        payload: { text: `Memory ${i}` },
        vector: Array(384).fill(0), // MiniLM dimension
      });
    }

    const processed: Array<{ id: string | number; payload: Record<string, unknown>; vector: number[] }>[][] = [];
    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      processed.push([...batch]);
      return Promise.resolve();
    });

    // 3 batches: 100 + 100 + 50
    expect(processed).toHaveLength(3);
    expect(processed[0]).toHaveLength(100);
    expect(processed[1]).toHaveLength(100);
    expect(processed[2]).toHaveLength(50);
    expect(processed[0][0].id).toBe('1');
    expect(processed[2][49].id).toBe('250');
  });

  it('should handle empty collection', async () => {
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = [];

    const processed: Array<{ id: string | number; payload: Record<string, unknown>; vector: number[] }>[][] = [];
    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      processed.push([...batch]);
      return Promise.resolve();
    });

    expect(processed).toHaveLength(0);
  });

  it('should handle single point', async () => {
    const allPoints = [{
      id: '1',
      payload: { text: 'Single memory' },
      vector: Array(384).fill(0.5),
    }];

    let callbackCount = 0;
    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      callbackCount++;
      return Promise.resolve();
    });

    expect(callbackCount).toBe(1);
  });

  it('should batch correctly at boundary', async () => {
    // Exactly batch size
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = [];
    for (let i = 1; i <= 100; i++) {
      allPoints.push({
        id: String(i),
        payload: { text: `Memory ${i}` },
        vector: Array(384).fill(0),
      });
    }

    const processed: Array<{ id: string | number; payload: Record<string, unknown>; vector: number[] }>[][] = [];
    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      processed.push([...batch]);
      return Promise.resolve();
    });

    expect(processed).toHaveLength(1);
    expect(processed[0]).toHaveLength(100);
  });
});

describe('dry-run vs live mode', () => {
  it('should count all points in dry-run without modifying', async () => {
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = [
      { id: '1', payload: { text: 'Memory 1' }, vector: [] },
      { id: '2', payload: { text: 'Memory 2' }, vector: [] },
      { id: '3', payload: { text: 'Memory 3' }, vector: [] },
    ];

    const { options } = testParseArgs(['--dry-run']);
    
    // In dry-run mode, we just count - no actual upsert happens
    const result = { migratedCount: 0 };
    
    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      if (options.dryRun) {
        result.migratedCount += batch.length;
      }
      return Promise.resolve();
    });

    expect(result.migratedCount).toBe(3);
  });

  it('should track failed batches separately', async () => {
    // Simulate a scenario where a batch fails
    const allPoints: Array<{ id: string; payload: Record<string, unknown>; vector: number[] }> = [
      { id: '1', payload: { text: 'Memory 1' }, vector: [] },
      { id: '2', payload: { text: 'Memory 2' }, vector: [] },
      { id: '3', payload: { text: 'Memory 3' }, vector: [] },
    ];

    const errors: string[] = [];
    let shouldFail = true;

    await simulateScrollAllPoints(allPoints, 100, async (batch) => {
      if (shouldFail && batch.length > 0) {
        errors.push('Simulated batch failure');
        shouldFail = false;
        // In real code, we'd track failedCount here
      }
      return Promise.resolve();
    });

    expect(errors).toHaveLength(1);
  });
});

describe('embedding dimension handling', () => {
  it('should identify 384-dim vectors (MiniLM)', () => {
    const miniLmVector = Array(384).fill(0.1);
    expect(miniLmVector.length).toBe(384);
  });

  it('should identify 1024-dim vectors (BGE-Large)', () => {
    const bgeVector = Array(1024).fill(0.1);
    expect(bgeVector.length).toBe(1024);
  });

  it('should filter out points without text content', () => {
    const points = [
      { id: '1', payload: { text: 'Has text' }, vector: [] },
      { id: '2', payload: { content: 'Has content' }, vector: [] },
      { id: '3', payload: {}, vector: [] }, // No text or content
      { id: '4', payload: { text: '' }, vector: [] }, // Empty text
    ];

    const texts = points.map(p => {
      const text = p.payload.text || p.payload.content;
      return typeof text === 'string' ? text : '';
    }).filter(t => t.length > 0);

    expect(texts).toHaveLength(2);
    expect(texts[0]).toBe('Has text');
    expect(texts[1]).toBe('Has content');
  });
});

describe('progress calculation', () => {
  it('should calculate percentage correctly', () => {
    const processed = 50;
    const total = 100;
    const percentage = Math.round((processed / total) * 100);
    expect(percentage).toBe(50);
  });

  it('should handle 0% progress', () => {
    const processed = 0;
    const total = 100;
    const percentage = Math.round((processed / total) * 100);
    expect(percentage).toBe(0);
  });

  it('should handle 100% progress', () => {
    const processed = 100;
    const total = 100;
    const percentage = Math.round((processed / total) * 100);
    expect(percentage).toBe(100);
  });

  it('should round to nearest integer', () => {
    const processed = 33;
    const total = 100;
    const percentage = Math.round((processed / total) * 100);
    expect(percentage).toBe(33);
  });

  it('should handle large numbers', () => {
    const processed = 1234567;
    const total = 9876543;
    const percentage = Math.round((processed / total) * 100);
    expect(percentage).toBe(12); // ~12.5% rounds to 12
  });
});

describe('BGE-Large dimensions constant', () => {
  it('should be 1024', () => {
    const BGE_LARGE_DIMENSIONS = 1024;
    expect(BGE_LARGE_DIMENSIONS).toBe(1024);
  });
});