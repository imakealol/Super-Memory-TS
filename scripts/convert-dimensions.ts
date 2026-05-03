/**
 * Conversion Script: 384-dim (MiniLM) → 1024-dim (BGE-Large) Embedding Dimension Migration
 *
 * Qdrant collections have FIXED dimensions. This script creates a NEW collection with 1024-dim
 * vectors and migrates all memories from the source collection.
 *
 * Usage:
 *   bun run scripts/convert-dimensions.ts
 *   bun run scripts/convert-dimensions.ts --source-collection memories --target-collection memories_bge_large
 *   bun run scripts/convert-dimensions.ts --batch-size 32 --confirm
 *
 * Options:
 *   --source-collection <name>   Source Qdrant collection (default: memories)
 *   --target-collection <name>   Target Qdrant collection (default: memories_bge_large)
 *   --qdrant-url <url>           Qdrant server URL (default: http://localhost:6333)
 *   --batch-size <n>             Number of memories to process per batch (default: 16)
 *   --dry-run                   Show what would happen without making changes (default)
 *   --confirm                   Actually perform the migration (required to modify data)
 *   --gpu                       Use GPU for BGE-Large (default: true)
 *   --precision <p>             Precision: fp16, fp32, q8, q4 (default: fp16)
 *   --help, -h                  Show this help message
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { DEFAULT_QDRANT_URL, MEMORY_TABLE_NAME, PAYLOAD_FIELDS, QDRANT_HNSW_CONFIG } from '../src/memory/schema.js';
import { ModelManager } from '../src/model/index.js';
import { generateEmbeddings } from '../src/model/embeddings.js';
import { BGE_LARGE_DIMENSIONS, ENV_PRECISION, ENV_DEVICE, ENV_USE_GPU } from '../src/model/types.js';

interface ConversionOptions {
  sourceCollection: string;
  targetCollection: string;
  qdrantUrl: string;
  batchSize: number;
  dryRun: boolean;
  gpu: boolean;
  precision: 'fp32' | 'fp16' | 'q8' | 'q4';
}

interface ConversionResult {
  totalPoints: number;
  migratedCount: number;
  failedCount: number;
  targetCollection: string;
  errors: string[];
}

interface ScrolledPoint {
  id: string | number;
  payload: Record<string, unknown>;
  vector: number[];
}

function parseArgs(): { options: ConversionOptions; errors: string[] } {
  const errors: string[] = [];
  const options: ConversionOptions = {
    sourceCollection: MEMORY_TABLE_NAME,
    targetCollection: `${MEMORY_TABLE_NAME}_bge_large`,
    qdrantUrl: process.env.QDRANT_URL || DEFAULT_QDRANT_URL,
    batchSize: 16,
    dryRun: true,
    gpu: true,
    precision: 'fp16',
  };

  const args = process.argv.slice(2);
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
}

function printUsage(): void {
  console.log(`
Conversion Script: 384-dim (MiniLM) → 1024-dim (BGE-Large)

Usage:
  bun run scripts/convert-dimensions.ts [options]

Options:
  --source-collection <name>   Source Qdrant collection (default: memories)
  --target-collection <name>   Target Qdrant collection (default: memories_bge_large)
  --qdrant-url <url>           Qdrant server URL (default: http://localhost:6333)
  --batch-size <n>             Number of memories to process per batch (default: 16)
  --dry-run                   Show what would happen without making changes (default)
  --confirm                   Actually perform the migration (required to modify data)
  --gpu                       Use GPU for BGE-Large (default: true)
  --no-gpu                    Disable GPU (use CPU instead)
  --precision <p>              Precision: fp16, fp32, q8, q4 (default: fp16)
  --help, -h                  Show this help message

Examples:
  # Preview what would be migrated (dry-run)
  bun run scripts/convert-dimensions.ts

  # Actually perform the migration
  bun run scripts/convert-dimensions.ts --confirm

  # Custom collection names and batch size
  bun run scripts/convert-dimensions.ts --source-collection memories_v2 --target-collection memories_v3 --batch-size 32 --confirm

  # Use CPU instead of GPU
  bun run scripts/convert-dimensions.ts --no-gpu --confirm

Safety:
  This script defaults to dry-run mode. You must pass --confirm to actually
  modify the database. It creates a NEW collection - it does NOT modify the
  source collection. A 5-second delay occurs before live migration starts.
`);
}

async function collectionExists(client: QdrantClient, collectionName: string): Promise<boolean> {
  try {
    const result = await client.getCollection(collectionName);
    return !!result;
  } catch {
    return false;
  }
}

async function createTargetCollection(client: QdrantClient, collectionName: string): Promise<void> {
  await client.createCollection(collectionName, {
    vectors: {
      size: BGE_LARGE_DIMENSIONS,
      distance: 'Cosine',
    },
    hnsw: QDRANT_HNSW_CONFIG,
  });

  // Create payload indexes for filtering
  await client.createPayloadIndex(collectionName, {
    field_name: PAYLOAD_FIELDS.projectId,
    field_schema: 'keyword',
  });
  await client.createPayloadIndex(collectionName, {
    field_name: PAYLOAD_FIELDS.sourceType,
    field_schema: 'keyword',
  });
  await client.createPayloadIndex(collectionName, {
    field_name: PAYLOAD_FIELDS.sessionId,
    field_schema: 'keyword',
  });
  await client.createPayloadIndex(collectionName, {
    field_name: PAYLOAD_FIELDS.timestamp,
    field_schema: 'datetime',
  });
}

async function scrollAllPoints(
  client: QdrantClient,
  collectionName: string,
  batchSize: number,
  callback: (points: ScrolledPoint[]) => Promise<void>
): Promise<number> {
  let offset: string | undefined = undefined;
  let totalProcessed = 0;

  do {
    const result = await client.scroll(collectionName, {
      limit: batchSize,
      offset,
      with_payload: true,
      with_vector: true,
    });

    const points: ScrolledPoint[] = result.points.map(p => ({
      id: p.id,
      payload: p.payload ?? {},
      vector: p.vector ?? [],
    }));

    if (points.length === 0) {
      break;
    }

    await callback(points);
    totalProcessed += points.length;

    if (result.next_page_offset) {
      offset = String(result.next_page_offset);
    } else {
      break;
    }
  } while (true);

  return totalProcessed;
}

async function convertDimensions(options: ConversionOptions): Promise<ConversionResult> {
  const client = new QdrantClient({ url: options.qdrantUrl, timeout: 60000 });

  const result: ConversionResult = {
    totalPoints: 0,
    migratedCount: 0,
    failedCount: 0,
    targetCollection: options.targetCollection,
    errors: [],
  };

  // Validate source collection exists
  console.log(`Checking source collection: ${options.sourceCollection}`);
  const sourceExists = await collectionExists(client, options.sourceCollection);
  if (!sourceExists) {
    throw new Error(`Source collection '${options.sourceCollection}' does not exist. Exiting.`);
  }

  // Check if target collection already exists
  const targetExists = await collectionExists(client, options.targetCollection);
  if (targetExists) {
    throw new Error(`Target collection '${options.targetCollection}' already exists. Please delete it first or use a different target collection name.`);
  }

  // Get total count
  const countResult = await client.count(options.sourceCollection, { exact: true });
  result.totalPoints = countResult.count;
  console.log(`Total points in source collection: ${result.totalPoints}`);
  console.log(`Target collection will have ${BGE_LARGE_DIMENSIONS}-dim vectors`);
  console.log(`Mode: ${options.dryRun ? 'DRY-RUN (no changes will be made)' : 'LIVE (changes will be made)'}`);
  console.log(`GPU: ${options.gpu}, Precision: ${options.precision}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log('');

  if (result.totalPoints === 0) {
    console.log('No points to migrate. Exiting.');
    return result;
  }

  // Configure and load BGE-Large model
  console.log('Loading BGE-Large model...');
  const manager = ModelManager.getInstance();

  // Configure for BGE-Large with GPU and specified precision
  manager.updateConfig({
    device: options.gpu ? 'gpu' : 'cpu',
    precision: options.precision,
    useGpu: options.gpu,
  });

  try {
    await manager.acquire();
    const metadata = manager.getMetadata();
    console.log(`Model loaded: ${metadata.modelId} (${metadata.dimensions}-dim, ${metadata.device}, ${metadata.precision})`);
  } catch (error) {
    if (options.gpu) {
      const gpuError = [
        `Failed to load BGE-Large on GPU: ${error instanceof Error ? error.message : String(error)}`,
        ``,
        `To use CPU instead, run with --no-gpu flag:`,
        `  bun run scripts/convert-dimensions.ts --no-gpu --confirm`,
      ].join('\n');
      throw new Error(gpuError);
    }
    throw error;
  }
  console.log('');

  // Create target collection (only in live mode)
  if (!options.dryRun) {
    console.log(`Creating target collection: ${options.targetCollection}`);
    await createTargetCollection(client, options.targetCollection);
    console.log('Target collection created with payload indexes.');
    console.log('');
  }

  // Process points in batches
  console.log(`Starting migration...`);
  console.log('');

  let processedCount = 0;

  await scrollAllPoints(client, options.sourceCollection, options.batchSize, async (points) => {
    const texts = points.map(p => {
      const text = p.payload.text || p.payload.content;
      return typeof text === 'string' ? text : '';
    }).filter(t => t.length > 0);

    if (options.dryRun) {
      result.migratedCount += points.length;
    } else {
      try {
        // Generate new embeddings
        const embeddings = await generateEmbeddings(texts, options.batchSize);
        const embeddingMap = new Map<string, number[]>();
        
        // Map embeddings back to points (only those with text)
        let embIdx = 0;
        for (const point of points) {
          const text = point.payload.text || point.payload.content;
          if (typeof text === 'string' && text.length > 0 && embIdx < embeddings.length) {
            embeddingMap.set(String(point.id), embeddings[embIdx++].embedding);
          }
        }

        // Prepare points for upsert
        const upsertPoints = points
          .filter(p => embeddingMap.has(String(p.id)))
          .map(p => ({
            id: p.id,
            vector: embeddingMap.get(String(p.id))!,
            payload: p.payload,
          }));

        if (upsertPoints.length > 0) {
          await client.upsert(options.targetCollection, {
            wait: true,
            points: upsertPoints,
          });
          result.migratedCount += upsertPoints.length;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Batch failed: ${errorMsg}`);
        result.failedCount += points.length;
        console.error(`  ERROR in batch: ${errorMsg}`);
      }
    }

    processedCount += points.length;
    const percentage = Math.round((processedCount / result.totalPoints) * 100);
    console.log(`  Progress: ${processedCount}/${result.totalPoints} (${percentage}%)`);

    // Small delay to avoid overwhelming Qdrant
    if (!options.dryRun) {
      await new Promise(r => setTimeout(r, 50));
    }
  });

  // Release model
  await manager.release();

  return result;
}

async function main(): Promise<void> {
  const { options, errors } = parseArgs();

  // Handle help
  if (errors.includes('SHOW_HELP')) {
    printUsage();
    process.exit(0);
  }

  // Handle errors
  if (errors.length > 0) {
    for (const error of errors) {
      console.error(error);
    }
    console.log('');
    printUsage();
    process.exit(1);
  }

  // Safety warning for live mode
  if (!options.dryRun) {
    console.log('=================================================================');
    console.log('  WARNING: This is a LIVE migration that will create a new collection!');
    console.log('  It creates a NEW collection - source collection remains unchanged.');
    console.log('  Press Ctrl+C to abort, or wait 5 seconds to continue...');
    console.log('=================================================================');
    console.log('');
    await new Promise(r => setTimeout(r, 5000));
  }

  try {
    const result = await convertDimensions(options);

    console.log('');
    console.log('=================================================================');
    console.log('  Migration Summary');
    console.log('=================================================================');
    console.log(`  Total points:       ${result.totalPoints}`);
    console.log(`  Migrated:          ${result.migratedCount}`);
    console.log(`  Failed:            ${result.failedCount}`);
    console.log(`  Target collection: ${result.targetCollection}`);

    if (result.errors.length > 0) {
      console.log('');
      console.log('  Errors:');
      for (const error of result.errors) {
        console.log(`    - ${error}`);
      }
    }

    if (options.dryRun) {
      console.log('');
      console.log('  This was a DRY-RUN. To actually perform the migration,');
      console.log('  run again with --confirm flag.');
    }
  } catch (err) {
    console.error('Migration failed with error:', err);
    process.exit(1);
  }
}

// Export for testing
export { convertDimensions, scrollAllPoints, collectionExists, createTargetCollection, parseArgs, ConversionOptions, ConversionResult };

// Run if executed directly
main();