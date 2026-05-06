/**
 * Model Layer Types for Super-Memory-TS
 * Defines types for embedding model management and inference
 */

/** Supported precision formats for model inference */
export type Precision = 'fp32' | 'fp16' | 'q8' | 'q4';

/** Compute device options for model execution */
export type ComputeDevice = 'auto' | 'gpu' | 'cpu';

/** Environment-configurable precision setting */
export type EnvPrecision = 'fp32' | 'fp16' | 'q8' | 'q4' | 'auto';

/**
 * Configuration for embedding model initialization
 */
export interface ModelConfig {
  /** Model identifier (e.g., 'Xenova/bge-large-en-v1.5') */
  modelId: string;
  /** Compute device: 'auto', 'gpu', or 'cpu' */
  device: ComputeDevice;
  /** Numerical precision: 'fp32', 'fp16', 'q8', or 'q4' */
  precision: Precision;
  /** Enable GPU via CUDA/metal backend */
  useGpu: boolean;
  /** Enable GPU if available (legacy env var support) */
  gpuEnabled?: boolean;
  /** Enable auto CPU fallback if GPU model fails to load (default: true) */
  gpuFallback?: boolean;
  /** The actual model ID that was loaded (may differ from modelId after fallback) */
  activeModelId?: string;
}

/**
 * Result of embedding generation
 */
export interface EmbeddingResult {
  /** Single embedding vector */
  embedding: number[];
  /** Number of tokens in the input text */
  tokenCount: number;
  /** Model used to generate embedding */
  modelId: string;
  /** Compute device used */
  device: ComputeDevice;
  /** Generation timestamp (Unix ms) */
  timestamp: number;
  /** Latency in milliseconds */
  latencyMs: number;
}

/**
 * Batch embedding result for multiple texts
 */
export interface BatchEmbeddingResult {
  /** Array of embedding vectors */
  embeddings: number[][];
  /** Token counts per text */
  tokenCounts: number[];
  /** Model used to generate embeddings */
  modelId: string;
  /** Compute device used */
  device: ComputeDevice;
  /** Generation timestamp (Unix ms) */
  timestamp: number;
  /** Total latency in milliseconds */
  latencyMs: number;
}

/**
 * Model metadata for diagnostics and logging
 */
export interface ModelMetadata {
  /** Model identifier */
  modelId: string;
  /** Embedding dimension */
  dimensions: number;
  /** Compute device */
  device: ComputeDevice;
  /** Numerical precision */
  precision: Precision;
  /** Whether model is currently loaded */
  isLoaded: boolean;
  /** Reference count (number of active users) */
  referenceCount: number;
}

/** BGE-Large model identifier */
export const BGE_LARGE_MODEL_ID = 'Xenova/bge-large-en-v1.5';

/** MiniLM (CPU fallback) model identifier */
export const MINI_LM_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

/** BGE-Large embedding dimensions */
export const BGE_LARGE_DIMENSIONS = 1024;

/** MiniLM embedding dimensions */
export const MINI_LM_DIMENSIONS = 384;

/** Environment variable names */
export const ENV_PRECISION = 'BOOMERANG_PRECISION';
export const ENV_DEVICE = 'BOOMERANG_DEVICE';
export const ENV_USE_GPU = 'BOOMERANG_USE_GPU';
export const ENV_GPU_FALLBACK = 'GPU_FALLBACK';
