/**
 * Model Layer - Embedding Generation
 * Handles embedding creation with batching support
 */

import { ModelManager } from './index.js';
import {
  EmbeddingResult,
} from './types.js';

/**
 * Default batch size for embedding generation
 */
const DEFAULT_BATCH_SIZE = 8;

/**
 * Generate a single embedding for text
 */
export async function generateEmbedding(text: string): Promise<EmbeddingResult> {
  const startTime = Date.now();
  const manager = ModelManager.getInstance();

  // Ensure model is loaded
  if (!manager.getMetadata().isLoaded) {
    await manager.acquire();
  }

  const extractor = manager.getExtractor();
  const metadata = manager.getMetadata();

  try {
    // Run feature extraction
    const output = await extractor(text, {
      pooling: 'mean',
      normalize: true,
    });

    // Extract embedding (token count estimated from text length / 4)
    const embedding = Array.from(output.data) as number[];
    const tokenCount = Math.ceil(text.length / 4);

    const latencyMs = Date.now() - startTime;

    return {
      embedding,
      tokenCount,
      modelId: metadata.modelId,
      device: metadata.device,
      timestamp: Date.now(),
      latencyMs,
    };
  } catch (error) {
    throw new Error(`Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Generate embeddings for multiple texts with batch processing
 */
export async function generateEmbeddings(
  texts: string[],
  batchSize: number = DEFAULT_BATCH_SIZE
): Promise<EmbeddingResult[]> {
  if (texts.length === 0) {
    return [];
  }

  const manager = ModelManager.getInstance();

  // Ensure model is loaded
  if (!manager.getMetadata().isLoaded) {
    await manager.acquire();
  }

  const results: EmbeddingResult[] = [];

  // Process in batches for memory efficiency
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await processBatch(batch, manager);
    results.push(...batchResults);
  }

  return results;
}

/**
 * Process a batch of texts
 */
async function processBatch(
  texts: string[],
  manager: ModelManager
): Promise<EmbeddingResult[]> {
  const extractor = manager.getExtractor();
  const metadata = manager.getMetadata();
  const startTime = Date.now();

  try {
    // Run batch feature extraction
    const outputs = await Promise.all(
      texts.map((text) =>
        extractor(text, {
          pooling: 'mean',
          normalize: true,
        })
      )
    );

    const results: EmbeddingResult[] = outputs.map((output, index) => ({
      embedding: Array.from(output.data) as number[],
      tokenCount: Math.ceil(texts[index].length / 4),
      modelId: metadata.modelId,
      device: metadata.device,
      timestamp: Date.now(),
      latencyMs: Date.now() - startTime,
    }));

    return results;
  } catch (error) {
    throw new Error(`Failed to generate batch embeddings: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export default {
  generateEmbedding,
  generateEmbeddings,
};
