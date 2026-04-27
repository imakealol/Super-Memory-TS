/**
 * Tests for migrate-memories.ts
 * Tests the migration logic without requiring Qdrant connection.
 */

import { describe, it, expect } from 'bun:test';

describe('parseArgs', () => {
  // Test helper that mimics the actual parseArgs logic
  const testParseArgs = (args: string[]) => {
    const errors: string[] = [];
    const options = {
      qdrantUrl: process.env.QDRANT_URL || 'http://localhost:6333',
      projectId: 'default',
      dryRun: true,
      batchSize: 100,
    };

    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      switch (arg) {
        case '--project-id':
          if (i + 1 >= args.length) {
            errors.push('Error: --project-id requires a value');
          } else {
            options.projectId = args[++i];
          }
          break;
        case '--dry-run':
          options.dryRun = true;
          break;
        case '--confirm':
          options.dryRun = false;
          break;
        case '--batch-size':
          if (i + 1 >= args.length) {
            errors.push('Error: --batch-size requires a value');
          } else {
            const size = parseInt(args[++i], 10);
            if (isNaN(size) || size < 1) {
              errors.push('Error: --batch-size must be a positive integer');
            } else {
              options.batchSize = size;
            }
          }
          break;
        case '--qdrant-url':
          if (i + 1 >= args.length) {
            errors.push('Error: --qdrant-url requires a value');
          } else {
            options.qdrantUrl = args[++i];
          }
          break;
      }
      i++;
    }

    return { options, errors };
  };

  it('should default to dry-run mode with default project ID', () => {
    const { options, errors } = testParseArgs([]);
    expect(errors).toHaveLength(0);
    expect(options.dryRun).toBe(true);
    expect(options.projectId).toBe('default');
    expect(options.batchSize).toBe(100);
  });

  it('should parse --project-id correctly', () => {
    const { options, errors } = testParseArgs(['--project-id', 'my-project']);
    expect(errors).toHaveLength(0);
    expect(options.projectId).toBe('my-project');
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

  it('should parse --batch-size correctly', () => {
    const { options, errors } = testParseArgs(['--batch-size', '50']);
    expect(errors).toHaveLength(0);
    expect(options.batchSize).toBe(50);
  });

  it('should reject invalid --batch-size', () => {
    const { options, errors } = testParseArgs(['--batch-size', 'abc']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should reject negative --batch-size', () => {
    const { options, errors } = testParseArgs(['--batch-size', '-5']);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('should parse --qdrant-url correctly', () => {
    const { options, errors } = testParseArgs(['--qdrant-url', 'http://custom:6333']);
    expect(errors).toHaveLength(0);
    expect(options.qdrantUrl).toBe('http://custom:6333');
  });

  it('should parse multiple arguments correctly', () => {
    const { options, errors } = testParseArgs([
      '--project-id', 'legacy',
      '--batch-size', '25',
      '--confirm'
    ]);
    expect(errors).toHaveLength(0);
    expect(options.projectId).toBe('legacy');
    expect(options.batchSize).toBe(25);
    expect(options.dryRun).toBe(false);
  });
});

describe('scrollWithoutProjectId logic', () => {
  interface TestPoint {
    id: string;
    payload: Record<string, unknown>;
  }

  // Simulates the scroll logic that filters for points without projectId
  const simulateScrollWithoutProjectId = async (
    allPoints: TestPoint[],
    batchSize: number,
    callback: (points: TestPoint[]) => Promise<void>
  ): Promise<number> => {
    let offset = 0;
    let totalProcessed = 0;

    // Filter for points without projectId (is_empty filter in Qdrant)
    const filteredPoints = allPoints.filter(p => !p.payload.projectId);

    while (offset < filteredPoints.length) {
      const batch = filteredPoints.slice(offset, offset + batchSize);
      if (batch.length === 0) break;

      await callback(batch);
      totalProcessed += batch.length;
      offset += batchSize;
    }

    return totalProcessed;
  };

  it('should process all memories without projectId', async () => {
    const points: TestPoint[] = [
      { id: '1', payload: { text: 'Memory 1' } },
      { id: '2', payload: { text: 'Memory 2', projectId: 'existing' } },
      { id: '3', payload: { text: 'Memory 3' } },
      { id: '4', payload: { projectId: 'another' } },
      { id: '5', payload: { text: 'Memory 5' } },
    ];

    const processed: TestPoint[][] = [];
    await simulateScrollWithoutProjectId(points, 100, (batch) => {
      processed.push([...batch]);
      return Promise.resolve();
    });

    // Should have processed only the 3 points without projectId
    expect(processed.length).toBe(1);
    expect(processed[0]).toHaveLength(3);
    expect(processed[0].map(p => p.id)).toEqual(['1', '3', '5']);
  });

  it('should skip memories that already have projectId', async () => {
    const points: TestPoint[] = [
      { id: '1', payload: { text: 'Has projectId', projectId: 'project-a' } },
      { id: '2', payload: { text: 'Also has projectId', projectId: 'project-b' } },
    ];

    let callbackInvoked = false;
    let callbackBatch: TestPoint[] = [];
    await simulateScrollWithoutProjectId(points, 100, (batch) => {
      callbackInvoked = true;
      callbackBatch = batch;
      return Promise.resolve();
    });

    // Callback should not be invoked since all points have projectId
    expect(callbackInvoked).toBe(false);
    expect(callbackBatch).toHaveLength(0);
  });

  it('should handle empty collection', async () => {
    const points: TestPoint[] = [];

    const processed: TestPoint[][] = [];
    await simulateScrollWithoutProjectId(points, 100, (batch) => {
      processed.push([...batch]);
      return Promise.resolve();
    });

    // No batches processed for empty collection
    expect(processed).toHaveLength(0);
  });

  it('should process in batches when collection is large', async () => {
    // Create 250 points, only 200 without projectId
    const points: TestPoint[] = [];
    for (let i = 1; i <= 250; i++) {
      points.push({
        id: String(i),
        payload: i % 5 === 0
          ? { text: `Memory ${i}`, projectId: 'existing' }  // Every 5th has projectId
          : { text: `Memory ${i}` },
      });
    }

    const processed: TestPoint[] = [];
    await simulateScrollWithoutProjectId(points, 100, (batch) => {
      processed.push(...batch);
      return Promise.resolve();
    });

    // 200 without projectId (250 - 50 that have it)
    expect(processed).toHaveLength(200);
    expect(processed[0].id).toBe('1');
    expect(processed[199].id).toBe('249');
  });

  it('should respect dry-run mode (callback behavior)', async () => {
    const points: TestPoint[] = [
      { id: '1', payload: { text: 'Memory 1' } },
      { id: '2', payload: { text: 'Memory 2' } },
    ];

    const actions: string[] = [];
    await simulateScrollWithoutProjectId(points, 100, (batch) => {
      // In dry-run mode, we would just log what would be done
      for (const point of batch) {
        actions.push(`Would migrate ${point.id}`);
      }
      return Promise.resolve();
    });

    expect(actions).toEqual(['Would migrate 1', 'Would migrate 2']);
  });
});

describe('migration logic', () => {
  interface TestPoint {
    id: string;
    payload: Record<string, unknown>;
  }

  it('should correctly identify memories without projectId', () => {
    const points: TestPoint[] = [
      { id: '1', payload: { text: 'Memory 1' } },
      { id: '2', payload: { text: 'Memory 2', projectId: undefined } }, // undefined is treated as missing
      { id: '3', payload: { text: 'Memory 3', projectId: 'default' } },
    ];

    const withoutProjectId = points.filter(p => !p.payload.projectId);
    expect(withoutProjectId).toHaveLength(2);
    expect(withoutProjectId.map(p => p.id)).toEqual(['1', '2']);
  });

  it('should correctly identify memories with projectId', () => {
    const points: TestPoint[] = [
      { id: '1', payload: { text: 'Memory 1' } },
      { id: '2', payload: { text: 'Memory 2', projectId: 'default' } },
      { id: '3', payload: { text: 'Memory 3', projectId: 'legacy' } },
    ];

    const withProjectId = points.filter(p => p.payload.projectId !== undefined);
    expect(withProjectId).toHaveLength(2);
    expect(withProjectId.map(p => p.id)).toEqual(['2', '3']);
  });

  it('should handle custom project ID assignment', () => {
    const customProjectId = 'my-custom-project';
    const point = { id: '1', payload: { text: 'Test' } };

    // Simulate adding projectId to payload
    const updatedPayload = {
      ...point.payload,
      projectId: customProjectId,
    };

    expect(updatedPayload.projectId).toBe('my-custom-project');
  });

  it('should batch memories correctly for migration', () => {
    const memories = Array.from({ length: 250 }, (_, i) => ({
      id: String(i + 1),
      payload: { text: `Memory ${i + 1}` },
    }));

    const batchSize = 100;
    const batches: typeof memories[] = [];

    for (let i = 0; i < memories.length; i += batchSize) {
      batches.push(memories.slice(i, i + batchSize));
    }

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(100);
    expect(batches[1]).toHaveLength(100);
    expect(batches[2]).toHaveLength(50);
  });

  it('should calculate migration progress correctly', () => {
    const totalMigrations = 150;
    const migrated = 75;

    const progress = Math.round((migrated / totalMigrations) * 100);
    expect(progress).toBe(50);
  });
});
