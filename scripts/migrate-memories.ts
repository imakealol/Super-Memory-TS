/**
 * Migration Script: Tag Untouched Memories with Default Project ID
 *
 * Before v2.2.0, memories were stored without a `projectId` field in their Qdrant payload.
 * The new project isolation feature (v2.2.0+) filters by `projectId`, so untagged memories
 * are invisible when querying with a specific project ID.
 *
 * This script tags existing memories without a `projectId` with a default project ID.
 *
 * Usage:
 *   bun run scripts/migrate-memories.ts
 *   bun run scripts/migrate-memories.ts --project-id my-project
 *   bun run scripts/migrate-memories.ts --dry-run
 *   bun run scripts/migrate-memories.ts --batch-size 50
 *
 * Options:
 *   --project-id <id>   Project ID to assign (default: "default")
 *   --dry-run           Show what would be changed without making changes
 *   --batch-size <n>    Number of memories to process per batch (default: 100)
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import { DEFAULT_QDRANT_URL, MEMORY_TABLE_NAME, PAYLOAD_FIELDS } from '../src/memory/schema.js';

interface MigrationOptions {
  qdrantUrl: string;
  projectId: string;
  dryRun: boolean;
  batchSize: number;
}

interface MigrationResult {
  totalMemories: number;
  migratedCount: number;
  skippedCount: number;
  failedCount: number;
  errors: string[];
}

interface PointWithoutProjectId {
  id: string;
  payload: Record<string, unknown>;
}

function parseArgs(): {
  options: MigrationOptions;
  errors: string[];
} {
  const errors: string[] = [];
  const options: MigrationOptions = {
    qdrantUrl: process.env.QDRANT_URL || DEFAULT_QDRANT_URL,
    projectId: 'default',
    dryRun: true, // Default to dry-run for safety
    batchSize: 100,
  };

  const args = process.argv.slice(2);
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

      case '--qdrant-url':
        if (i + 1 >= args.length) {
          errors.push('Error: --qdrant-url requires a value');
        } else {
          options.qdrantUrl = args[++i];
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
Migration Script: Tag Untouched Memories with Default Project ID

Usage:
  bun run scripts/migrate-memories.ts [options]

Options:
  --project-id <id>   Project ID to assign (default: "default")
  --dry-run           Show what would be changed without making changes (default)
  --confirm           Actually perform the migration (required to modify data)
  --batch-size <n>    Number of memories to process per batch (default: 100)
  --qdrant-url <url>  Qdrant server URL (default: http://localhost:6333)
  --help, -h          Show this help message

Examples:
  # Preview what would be migrated (dry-run)
  bun run scripts/migrate-memories.ts

  # Preview with a specific project ID
  bun run scripts/migrate-memories.ts --project-id my-project

  # Actually perform the migration
  bun run scripts/migrate-memories.ts --confirm

  # Migrate with custom settings
  bun run scripts/migrate-memories.ts --project-id legacy --batch-size 50 --confirm

Safety:
  This script defaults to dry-run mode. You must pass --confirm to actually
  modify the database. It is recommended to backup your Qdrant data before
  running this script with --confirm.
`);
}

async function countTotalMemories(client: QdrantClient): Promise<number> {
  const result = await client.count(MEMORY_TABLE_NAME, { exact: true });
  return result.count;
}

async function scrollWithoutProjectId(
  client: QdrantClient,
  batchSize: number,
  callback: (points: PointWithoutProjectId[]) => Promise<void>
): Promise<number> {
  let offset: string | undefined = undefined;
  let totalProcessed = 0;

  // Filter for memories WITHOUT projectId (is_empty filter)
  const filter = {
    is_empty: { key: PAYLOAD_FIELDS.projectId },
  };

  do {
    const result = await client.scroll(MEMORY_TABLE_NAME, {
      filter,
      limit: batchSize,
      offset,
      with_payload: true,
      with_vector: false,
    });

    const points: PointWithoutProjectId[] = result.points.map(p => ({
      id: String(p.id),
      payload: p.payload ?? {},
    }));

    if (points.length === 0) {
      break;
    }

    await callback(points);
    totalProcessed += points.length;

    // Check if there are more points
    if (result.next_page_offset) {
      offset = String(result.next_page_offset);
    } else {
      break;
    }
  } while (true);

  return totalProcessed;
}

async function migrateMemories(options: MigrationOptions): Promise<MigrationResult> {
  const client = new QdrantClient({ url: options.qdrantUrl, timeout: 30000 });

  const result: MigrationResult = {
    totalMemories: 0,
    migratedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: [],
  };

  // Get total count
  result.totalMemories = await countTotalMemories(client);
  console.log(`Total memories in collection: ${result.totalMemories}`);
  console.log(`Project ID to assign: "${options.projectId}"`);
  console.log(`Mode: ${options.dryRun ? 'DRY-RUN (no changes will be made)' : 'LIVE (changes will be made)'}`);
  console.log(`Batch size: ${options.batchSize}`);
  console.log('');

  // Count memories without projectId first
  let withoutProjectIdCount = 0;
  await scrollWithoutProjectId(client, 1, (points) => {
    withoutProjectIdCount += points.length;
    return Promise.resolve();
  });

  // If we got any, that means there's at least one
  if (withoutProjectIdCount > 0 || result.totalMemories > 0) {
    // We need to re-scroll properly to get the count
    withoutProjectIdCount = 0;
    await scrollWithoutProjectId(client, options.batchSize, (points) => {
      withoutProjectIdCount += points.length;
      return Promise.resolve();
    });
  }

  console.log(`Memories without projectId: ${withoutProjectIdCount}`);
  console.log(`Memories with projectId: ${result.totalMemories - withoutProjectIdCount}`);
  console.log('');

  if (withoutProjectIdCount === 0) {
    console.log('No memories to migrate. Exiting.');
    return result;
  }

  // Perform migration
  console.log(`Starting migration...`);
  console.log('');

  await scrollWithoutProjectId(client, options.batchSize, async (points) => {
    const pointIds = points.map(p => p.id);

    if (options.dryRun) {
      result.migratedCount += points.length;
      console.log(`  [DRY-RUN] Would migrate ${points.length} memories (IDs: ${pointIds.slice(0, 3).join(', ')}${pointIds.length > 3 ? '...' : ''})`);
    } else {
      try {
        // Use set_payload to add projectId to existing points
        await client.setPayload(MEMORY_TABLE_NAME, {
          points: pointIds,
          payload: {
            [PAYLOAD_FIELDS.projectId]: options.projectId,
          },
        });
        result.migratedCount += points.length;
        console.log(`  Migrated ${result.migratedCount}/${withoutProjectIdCount} memories...`);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Failed to migrate batch starting at ${pointIds[0]}: ${errorMsg}`);
        result.failedCount += points.length;
        console.error(`  ERROR: Failed to migrate batch: ${errorMsg}`);
      }
    }

    // Small delay to avoid overwhelming Qdrant
    if (!options.dryRun) {
      await new Promise(r => setTimeout(r, 50));
    }
  });

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

  // Safety warning
  if (!options.dryRun) {
    console.log('=================================================================');
    console.log('  WARNING: This is a LIVE migration that will modify your data!');
    console.log('  It is recommended to backup your Qdrant data before running.');
    console.log('  Press Ctrl+C to abort, or wait 5 seconds to continue...');
    console.log('=================================================================');
    console.log('');
    await new Promise(r => setTimeout(r, 5000));
  }

  try {
    const result = await migrateMemories(options);

    console.log('');
    console.log('=================================================================');
    console.log('  Migration Summary');
    console.log('=================================================================');
    console.log(`  Total memories:     ${result.totalMemories}`);
    console.log(`  Migrated:          ${result.migratedCount}`);
    console.log(`  Skipped (has ID):  ${result.skippedCount}`);
    console.log(`  Failed:            ${result.failedCount}`);

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
export { migrateMemories, countTotalMemories, scrollWithoutProjectId, parseArgs, MigrationOptions, MigrationResult };

// Run if executed directly
main();
