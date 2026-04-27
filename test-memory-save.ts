/**
 * Diagnostic Script for super-memory-add_memory "Bad Request" issue
 * 
 * Tests:
 * 1. Memory system initialization
 * 2. Embedding generation and dimension checking
 * 3. Adding a memory entry
 * 4. Querying memories
 */

import { MemorySystem } from './src/memory/index.js';
import { ModelManager } from './src/model/index.js';
import { generateEmbedding } from './src/model/embeddings.js';
import { getEmbeddingDimensions, getModelMetadata } from './src/model/embeddings.js';
import { MEMORY_TABLE_NAME } from './src/memory/schema.js';

async function runDiagnostics() {
  console.log('='.repeat(60));
  console.log('MEMORY SYSTEM DIAGNOSTIC SCRIPT');
  console.log('='.repeat(60));
  console.log('');

  // 1. Model Information
  console.log('--- MODEL INFORMATION ---');
  try {
    const modelMeta = getModelMetadata();
    const dimensions = getEmbeddingDimensions();
    console.log(`Model ID: ${modelMeta.modelId}`);
    console.log(`Dimensions: ${dimensions}`);
    console.log(`Device: ${modelMeta.device}`);
    console.log(`Precision: ${modelMeta.precision}`);
    console.log(`Is Loaded: ${modelMeta.isLoaded}`);
    console.log('');
  } catch (error) {
    console.error('ERROR getting model metadata:', error);
    console.trace();
    console.log('');
  }

  // 2. Initialize Memory System
  console.log('--- INITIALIZING MEMORY SYSTEM ---');
  const memory = new MemorySystem();
  try {
    await memory.initialize();
    console.log('Memory system initialized successfully');
    console.log('');
  } catch (error) {
    console.error('ERROR initializing memory system:', error);
    console.trace();
    process.exit(1);
  }

  // 3. Test embedding generation
  console.log('--- TESTING EMBEDDING GENERATION ---');
  const testContent = 'Diagnostic test memory';
  try {
    const result = await generateEmbedding(testContent);
    console.log(`Embedding generated:`);
    console.log(`  Model ID: ${result.modelId}`);
    console.log(`  Vector dimension: ${result.embedding.length}`);
    console.log(`  Token count: ${result.tokenCount}`);
    console.log(`  Latency: ${result.latencyMs}ms`);
    console.log(`  Device: ${result.device}`);
    console.log(`  First 5 values: ${result.embedding.slice(0, 5).join(', ')}...`);
    console.log('');
  } catch (error) {
    console.error('ERROR generating embedding:', error);
    console.trace();
    console.log('');
  }

  // 4. Check expected vs actual dimensions
  console.log('--- DIMENSION CHECK ---');
  const expectedDim = getEmbeddingDimensions();
  console.log(`Expected dimension (from model): ${expectedDim}`);
  console.log('');

  // 5. Try to add a memory
  console.log('--- ATTEMPTING TO ADD MEMORY ---');
  try {
    const input = {
      text: testContent,
      sourceType: 'session' as const,
      sourcePath: 'test-memory-save.ts',
    };
    console.log(`Input:`, JSON.stringify(input, null, 2));
    
    const id = await memory.addMemory(input);
    console.log(`SUCCESS: Memory added with ID: ${id}`);
    console.log('');
  } catch (error) {
    console.error('ERROR adding memory:', error);
    console.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) {
      console.error('Stack trace:');
      console.trace(error);
    } else {
      console.trace();
    }
    console.log('');
  }

  // 6. Try to query memories
  console.log('--- ATTEMPTING TO QUERY MEMORIES ---');
  try {
    const results = await memory.queryMemories('test', { topK: 5 });
    console.log(`Query results: ${results.length} memories found`);
    for (const r of results) {
      console.log(`  - ID: ${r.id}, Text: "${r.text.slice(0, 50)}...", Score: ${r.score}`);
    }
    console.log('');
  } catch (error) {
    console.error('ERROR querying memories:', error);
    console.error(`Error message: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) {
      console.error('Stack trace:');
      console.trace(error);
    } else {
      console.trace();
    }
    console.log('');
  }

  // 7. List all memories
  console.log('--- LISTING ALL MEMORIES ---');
  try {
    const allMemories = await memory.listMemories();
    console.log(`Total memories: ${allMemories.length}`);
    for (const m of allMemories) {
      console.log(`  - ID: ${m.id}, Text: "${m.text.slice(0, 50)}..."`);
    }
    console.log('');
  } catch (error) {
    console.error('ERROR listing memories:', error);
    console.trace();
    console.log('');
  }

  // 8. Get stats
  console.log('--- MEMORY STATS ---');
  try {
    const stats = await memory.getStats();
    console.log(`Memory count: ${stats.count}`);
    console.log('');
  } catch (error) {
    console.error('ERROR getting stats:', error);
    console.trace();
    console.log('');
  }

  console.log('='.repeat(60));
  console.log('DIAGNOSTIC COMPLETE');
  console.log('='.repeat(60));
}

runDiagnostics().catch((error) => {
  console.error('Fatal error in diagnostic script:', error);
  console.trace();
  process.exit(1);
});
