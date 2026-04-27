/**
 * Performance Benchmarking Script for Super-Memory-TS Qdrant Operations
 * 
 * Measures and reports performance metrics for memory operations to establish baselines.
 * 
 * Usage: bun run scripts/benchmark.ts
 * 
 * Prerequisites:
 * - Qdrant running at QDRANT_URL (default: http://localhost:6333)
 * - Node.js >= 20
 */

import { MemorySystem, resetMemorySystem } from '../src/memory/index.js';
import { MemoryDatabase } from '../src/memory/database.js';
import { generateEmbeddings } from '../src/model/embeddings.js';
import { readFile, writeFile, mkdir, stat, rm } from 'fs/promises';
import { join } from 'path';
import { createHash } from 'crypto';

// Configuration
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const PROJECT_ID = 'benchmark-test-' + Date.now();
const BENCHMARK_DIR = join(process.cwd(), 'benchmark-test-files');

// Performance targets from AGENTS.md
const TARGETS = {
  queryLatencyP50: 10, // ms
  embeddingTime: 100, // ms
  memoryUsageMax: 500, // MB
  indexingThroughputMin: 100, // files/min
};

// Benchmark parameters
const QUERY_COUNT = 50;
const MEMORY_ADD_COUNT = 20;
const TEST_FILE_COUNT = 100;

interface BenchmarkResults {
  timestamp: string;
  version: string;
  benchmarks: {
    query_latency_ms: Record<string, { p50: number; p95: number; p99: number; avg: number; min: number; max: number; stdDev: number }>;
    embedding_time_ms: { short: number; medium: number; long: number };
    indexing_throughput: { files_per_minute: number; total_files: number; total_mb: number };
    memory_usage_mb: { peak_query: number; peak_embedding: number; peak_indexing: number };
    add_memory_latency_ms: { p50: number; p95: number; avg: number; min: number; max: number; stdDev: number };
  };
  targets: typeof TARGETS;
  pass: Record<string, boolean>;
}

/**
 * Calculate percentile from sorted array
 */
function percentile(sortedArr: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

/**
 * Calculate standard deviation
 */
function stdDev(arr: number[], avg: number): number {
  const squaredDiffs = arr.map(v => Math.pow(v - avg, 2));
  const avgSquaredDiff = squaredDiffs.reduce((a, b) => a + b, 0) / arr.length;
  return Math.sqrt(avgSquaredDiff);
}

/**
 * Format bytes to MB
 */
function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

/**
 * Get current heap usage in MB
 */
function getHeapUsedMB(): number {
  if (global.gc) {
    global.gc();
  }
  return bytesToMB(process.memoryUsage().heapUsed);
}

/**
 * Create test text of specified word count
 */
function createTestText(wordCount: number): string {
  const words = ['benchmark', 'performance', 'test', 'memory', 'system', 'query', 'vector', 'embedding', 
    'search', 'database', 'index', 'file', 'data', 'analysis', 'result', 'metrics', 'latency',
    'throughput', 'model', 'neural', 'network', 'deep', 'learning', 'algorithm', 'optimization',
    'efficient', 'fast', 'quick', 'rapid', 'speed', 'processing', 'computation'];
  
  const result: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    result.push(words[i % words.length]);
  }
  return result.join(' ');
}

/**
 * Benchmark 1: Query Latency
 */
async function benchmarkQueryLatency(memory: MemorySystem): Promise<Record<string, { p50: number; p95: number; p99: number; avg: number; min: number; max: number; stdDev: number }>> {
  console.log('\n📊 Benchmark 1: Query Latency');
  console.log('='.repeat(50));
  
  const strategies = ['TIERED', 'VECTOR_ONLY', 'TEXT_ONLY'] as const;
  const results: Record<string, { p50: number; p95: number; p99: number; avg: number; min: number; max: number; stdDev: number }> = {};
  
  // Test queries
  const testQueries = [
    'how to implement vector search',
    'benchmarking performance metrics',
    'memory system optimization',
    'indexing throughput efficiency',
    'query latency measurement',
  ];
  
  for (const strategy of strategies) {
    console.log(`\n  Testing ${strategy} strategy (${QUERY_COUNT} queries)...`);
    
    const latencies: number[] = [];
    
    for (let i = 0; i < QUERY_COUNT; i++) {
      const query = testQueries[i % testQueries.length];
      const start = performance.now();
      
      await memory.queryMemories(query, { strategy, topK: 10 });
      
      const latency = performance.now() - start;
      latencies.push(latency);
    }
    
    // Sort for percentile calculations
    const sorted = [...latencies].sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    
    results[strategy] = {
      p50: Math.round(percentile(sorted, 50)),
      p95: Math.round(percentile(sorted, 95)),
      p99: Math.round(percentile(sorted, 99)),
      avg: Math.round(avg * 100) / 100,
      min: Math.round(sorted[0] * 100) / 100,
      max: Math.round(sorted[sorted.length - 1] * 100) / 100,
      stdDev: Math.round(stdDev(latencies, avg) * 100) / 100,
    };
    
    console.log(`    p50: ${results[strategy].p50}ms, p95: ${results[strategy].p95}ms, p99: ${results[strategy].p99}ms`);
    console.log(`    avg: ${results[strategy].avg}ms, min: ${results[strategy].min}ms, max: ${results[strategy].max}ms`);
    console.log(`    stdDev: ${results[strategy].stdDev}ms`);
  }
  
  return results;
}

/**
 * Benchmark 2: Embedding Time
 */
async function benchmarkEmbeddingTime(): Promise<{ short: number; medium: number; long: number }> {
  console.log('\n📊 Benchmark 2: Embedding Time');
  console.log('='.repeat(50));
  
  const testCases = {
    short: { words: 10, label: 'short (10 words)' },
    medium: { words: 100, label: 'medium (100 words)' },
    long: { words: 500, label: 'long (500 words)' },
  };
  
  const results: { short: number; medium: number; long: number } = { short: 0, medium: 0, long: 0 };
  
  for (const [key, { words, label }] of Object.entries(testCases)) {
    console.log(`\n  Testing ${label}...`);
    
    const texts = Array.from({ length: 5 }, () => createTestText(words));
    
    // Warmup
    await generateEmbeddings([texts[0]]);
    
    // Actual benchmark
    const start = performance.now();
    await generateEmbeddings(texts);
    const elapsed = performance.now() - start;
    
    const avgTime = elapsed / texts.length;
    results[key as keyof typeof results] = Math.round(avgTime * 100) / 100;
    
    console.log(`    Average embedding time: ${results[key as keyof typeof results]}ms`);
  }
  
  return results;
}

/**
 * Benchmark 3: Indexing Throughput
 */
async function benchmarkIndexingThroughput(memory: MemorySystem): Promise<{ files_per_minute: number; total_files: number; total_mb: number }> {
  console.log('\n📊 Benchmark 3: Indexing Throughput');
  console.log('='.repeat(50));
  
  // Create test files
  console.log(`\n  Creating ${TEST_FILE_COUNT} test files...`);
  
  await mkdir(BENCHMARK_DIR, { recursive: true });
  
  const testContent = createTestText(200); // ~1KB per file
  const fileSizeBytes = new TextEncoder().encode(testContent).length;
  
  for (let i = 0; i < TEST_FILE_COUNT; i++) {
    const filePath = join(BENCHMARK_DIR, `test-${i.toString().padStart(4, '0')}.txt`);
    await writeFile(filePath, testContent + '\nFile index: ' + i);
  }
  
  const totalMB = bytesToMB(fileSizeBytes * TEST_FILE_COUNT);
  console.log(`  Created ${TEST_FILE_COUNT} files (${totalMB.toFixed(2)} MB total)`);
  
  // Benchmark indexing by adding memories
  console.log(`\n  Indexing ${TEST_FILE_COUNT} memories...`);
  const start = performance.now();
  
  for (let i = 0; i < TEST_FILE_COUNT; i++) {
    await memory.addMemory({
      text: testContent + '\nFile index: ' + i,
      sourceType: 'file',
      sourcePath: join(BENCHMARK_DIR, `test-${i.toString().padStart(4, '0')}.txt`),
    });
  }
  
  const elapsedSeconds = (performance.now() - start) / 1000;
  const filesPerMinute = Math.round((TEST_FILE_COUNT / elapsedSeconds) * 60);
  
  console.log(`  Indexed ${TEST_FILE_COUNT} files in ${elapsedSeconds.toFixed(2)}s`);
  console.log(`  Throughput: ${filesPerMinute} files/minute`);
  
  // Cleanup
  await rm(BENCHMARK_DIR, { recursive: true, force: true });
  
  return {
    files_per_minute: filesPerMinute,
    total_files: TEST_FILE_COUNT,
    total_mb: Math.round(totalMB * 100) / 100,
  };
}

/**
 * Benchmark 4: Memory Usage
 */
async function benchmarkMemoryUsage(memory: MemorySystem): Promise<{ peak_query: number; peak_embedding: number; peak_indexing: number }> {
  console.log('\n📊 Benchmark 4: Memory Usage');
  console.log('='.repeat(50));
  
  const results = { peak_query: 0, peak_embedding: 0, peak_indexing: 0 };
  
  // Baseline
  global.gc?.();
  const baseline = bytesToMB(process.memoryUsage().heapUsed);
  console.log(`\n  Baseline heap: ${baseline.toFixed(2)} MB`);
  
  // Query memory peak
  console.log('\n  Testing query memory usage...');
  let peakQuery = baseline;
  
  for (let i = 0; i < 20; i++) {
    await memory.queryMemories('benchmark test query for memory usage', { strategy: 'TIERED', topK: 10 });
    const current = bytesToMB(process.memoryUsage().heapUsed);
    peakQuery = Math.max(peakQuery, current);
  }
  results.peak_query = Math.round((peakQuery - baseline) * 100) / 100;
  console.log(`  Peak query overhead: ${results.peak_query} MB`);
  
  // Embedding memory peak
  console.log('\n  Testing embedding memory usage...');
  global.gc?.();
  const beforeEmbedding = bytesToMB(process.memoryUsage().heapUsed);
  
  const texts = Array.from({ length: 50 }, () => createTestText(100));
  await generateEmbeddings(texts);
  
  const afterEmbedding = bytesToMB(process.memoryUsage().heapUsed);
  results.peak_embedding = Math.round((afterEmbedding - beforeEmbedding) * 100) / 100;
  console.log(`  Peak embedding overhead: ${results.peak_embedding} MB`);
  
  // Indexing memory peak (add memories)
  console.log('\n  Testing indexing memory usage...');
  global.gc?.();
  const beforeIndexing = bytesToMB(process.memoryUsage().heapUsed);
  
  for (let i = 0; i < 20; i++) {
    await memory.addMemory({
      text: createTestText(100) + ' index ' + i,
      sourceType: 'file',
      sourcePath: '/benchmark/test-' + i + '.txt',
    });
  }
  
  const afterIndexing = bytesToMB(process.memoryUsage().heapUsed);
  results.peak_indexing = Math.round((afterIndexing - beforeIndexing) * 100) / 100;
  console.log(`  Peak indexing overhead: ${results.peak_indexing} MB`);
  
  return results;
}

/**
 * Benchmark 5: Add Memory Latency
 */
async function benchmarkAddMemoryLatency(memory: MemorySystem): Promise<{ p50: number; p95: number; avg: number; min: number; max: number; stdDev: number }> {
  console.log('\n📊 Benchmark 5: Add Memory Latency');
  console.log('='.repeat(50));
  
  console.log(`\n  Testing ${MEMORY_ADD_COUNT} sequential add operations...`);
  
  const latencies: number[] = [];
  
  for (let i = 0; i < MEMORY_ADD_COUNT; i++) {
    const start = performance.now();
    
    await memory.addMemory({
      text: createTestText(50) + ' add test ' + i,
      sourceType: 'manual',
      sourcePath: 'benchmark-' + i,
    });
    
    const latency = performance.now() - start;
    latencies.push(latency);
  }
  
  const sorted = [...latencies].sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  
  const result = {
    p50: Math.round(percentile(sorted, 50)),
    p95: Math.round(percentile(sorted, 95)),
    avg: Math.round(avg * 100) / 100,
    min: Math.round(sorted[0] * 100) / 100,
    max: Math.round(sorted[sorted.length - 1] * 100) / 100,
    stdDev: Math.round(stdDev(latencies, avg) * 100) / 100,
  };
  
  console.log(`  p50: ${result.p50}ms, p95: ${result.p95}ms`);
  console.log(`  avg: ${result.avg}ms, min: ${result.min}ms, max: ${result.max}ms`);
  console.log(`  stdDev: ${result.stdDev}ms`);
  
  return result;
}

/**
 * Print human-readable summary table
 */
function printSummary(results: BenchmarkResults): void {
  console.log('\n' + '='.repeat(70));
  console.log('📋 BENCHMARK SUMMARY');
  console.log('='.repeat(70));
  
  console.log('\n📈 Query Latency (ms)');
  console.log('-'.repeat(50));
  console.log('Strategy       │ p50   │ p95   │ p99   │ avg   │ target');
  console.log('-'.repeat(50));
  
  for (const [strategy, metrics] of Object.entries(results.benchmarks.query_latency_ms)) {
    const pass = metrics.p50 <= TARGETS.queryLatencyP50 ? '✅' : '❌';
    console.log(`${strategy.padEnd(14)} │ ${metrics.p50.toString().padStart(5)} │ ${metrics.p95.toString().padStart(5)} │ ${metrics.p99.toString().padStart(5)} │ ${metrics.avg.toString().padStart(5)} │ <${TARGETS.queryLatencyP50} ${pass}`);
  }
  
  console.log('\n📊 Embedding Time (ms)');
  console.log('-'.repeat(50));
  console.log('Text Length   │ Time  │ Target');
  console.log('-'.repeat(50));
  
  const embeddingResults = results.benchmarks.embedding_time_ms;
  for (const [length, time] of Object.entries(embeddingResults)) {
    const pass = time <= TARGETS.embeddingTime ? '✅' : '❌';
    console.log(`${length.padEnd(12)} │ ${time.toString().padStart(5)} │ <${TARGETS.embeddingTime} ${pass}`);
  }
  
  console.log('\n⚡ Indexing Throughput');
  console.log('-'.repeat(50));
  const throughput = results.benchmarks.indexing_throughput;
  const throughputPass = throughput.files_per_minute >= TARGETS.indexingThroughputMin ? '✅' : '❌';
  console.log(`Files/min: ${throughput.files_per_minute} (target: >${TARGETS.indexingThroughputMin}) ${throughputPass}`);
  console.log(`Total: ${throughput.total_files} files, ${throughput.total_mb} MB`);
  
  console.log('\n💾 Memory Usage (MB)');
  console.log('-'.repeat(50));
  const mem = results.benchmarks.memory_usage_mb;
  const totalPeak = mem.peak_query + mem.peak_embedding + mem.peak_indexing;
  const memPass = totalPeak <= TARGETS.memoryUsageMax ? '✅' : '❌';
  console.log(`Peak Query: ${mem.peak_query} MB`);
  console.log(`Peak Embedding: ${mem.peak_embedding} MB`);
  console.log(`Peak Indexing: ${mem.peak_indexing} MB`);
  console.log(`Total Peak: ${totalPeak.toFixed(2)} MB (target: <${TARGETS.memoryUsageMax} MB) ${memPass}`);
  
  console.log('\n➕ Add Memory Latency (ms)');
  console.log('-'.repeat(50));
  const addMem = results.benchmarks.add_memory_latency_ms;
  console.log(`p50: ${addMem.p50}, p95: ${addMem.p95}, avg: ${addMem.avg}`);
  console.log(`min: ${addMem.min}, max: ${addMem.max}, stdDev: ${addMem.stdDev}`);
  
  console.log('\n' + '='.repeat(70));
  console.log('🎯 TARGET COMPARISON');
  console.log('='.repeat(70));
  
  const allPass = Object.values(results.pass).every(v => v);
  console.log(`\nQuery Latency p50 < ${TARGETS.queryLatencyP50}ms: ${results.pass.queryLatency ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Embedding Time < ${TARGETS.embeddingTime}ms: ${results.pass.embeddingTime ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Indexing Throughput > ${TARGETS.indexingThroughputMin} files/min: ${results.pass.indexingThroughput ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Memory Usage < ${TARGETS.memoryUsageMax}MB: ${results.pass.memoryUsage ? '✅ PASS' : '❌ FAIL'}`);
  
  console.log(`\n${'='.repeat(70)}`);
  console.log(allPass ? '✅ ALL BENCHMARKS PASSED' : '⚠️  SOME BENCHMARKS FAILED');
  console.log('='.repeat(70));
}

/**
 * Main benchmark runner
 */
async function main(): Promise<void> {
  console.log('🚀 Super-Memory-TS Performance Benchmark');
  console.log('='.repeat(70));
  console.log(`QDRANT_URL: ${QDRANT_URL}`);
  console.log(`Project ID: ${PROJECT_ID}`);
  console.log(`Node.js: ${process.version}`);
  console.log(` Bun: ${process.versions.bun || 'N/A'}`);
  
  const startTime = Date.now();
  
  // Initialize memory system
  console.log('\n📦 Initializing memory system...');
  resetMemorySystem();
  const memory = new MemorySystem(undefined, undefined, { projectId: PROJECT_ID });
  
  try {
    await memory.initialize(QDRANT_URL);
    console.log('✅ Memory system initialized');
  } catch (error) {
    console.error('❌ Failed to initialize memory system:', error);
    console.error('\nMake sure Qdrant is running at:', QDRANT_URL);
    console.error('Run: docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant');
    process.exit(1);
  }
  
  // Run benchmarks
  const results: BenchmarkResults = {
    timestamp: new Date().toISOString(),
    version: '2.2.2',
    benchmarks: {
      query_latency_ms: {},
      embedding_time_ms: { short: 0, medium: 0, long: 0 },
      indexing_throughput: { files_per_minute: 0, total_files: 0, total_mb: 0 },
      memory_usage_mb: { peak_query: 0, peak_embedding: 0, peak_indexing: 0 },
      add_memory_latency_ms: { p50: 0, p95: 0, avg: 0, min: 0, max: 0, stdDev: 0 },
    },
    targets: TARGETS,
    pass: {},
  };
  
  try {
    results.benchmarks.query_latency_ms = await benchmarkQueryLatency(memory);
    results.benchmarks.embedding_time_ms = await benchmarkEmbeddingTime();
    results.benchmarks.indexing_throughput = await benchmarkIndexingThroughput(memory);
    results.benchmarks.memory_usage_mb = await benchmarkMemoryUsage(memory);
    results.benchmarks.add_memory_latency_ms = await benchmarkAddMemoryLatency(memory);
  } catch (error) {
    console.error('\n❌ Benchmark failed:', error);
    throw error;
  }
  
  // Evaluate targets
  const tieredLatency = results.benchmarks.query_latency_ms['TIERED'];
  results.pass.queryLatency = tieredLatency ? tieredLatency.p50 <= TARGETS.queryLatencyP50 : false;
  
  const avgEmbedding = (results.benchmarks.embedding_time_ms.short + 
                       results.benchmarks.embedding_time_ms.medium + 
                       results.benchmarks.embedding_time_ms.long) / 3;
  results.pass.embeddingTime = avgEmbedding <= TARGETS.embeddingTime;
  
  results.pass.indexingThroughput = results.benchmarks.indexing_throughput.files_per_minute >= TARGETS.indexingThroughputMin;
  
  const totalMemory = results.benchmarks.memory_usage_mb.peak_query + 
                     results.benchmarks.memory_usage_mb.peak_embedding + 
                     results.benchmarks.memory_usage_mb.peak_indexing;
  results.pass.memoryUsage = totalMemory <= TARGETS.memoryUsageMax;
  
  // Print summary
  printSummary(results);
  
  // Write JSON report
  const reportPath = join(process.cwd(), `benchmark-report-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 JSON report saved to: ${reportPath}`);
  
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`\n⏱️  Total benchmark time: ${totalTime}s`);
  
  // Cleanup
  await rm(BENCHMARK_DIR, { recursive: true, force: true }).catch(() => {});
  
  process.exit(0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});