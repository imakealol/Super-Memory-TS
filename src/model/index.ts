/**
 * Model Layer - Singleton ModelManager
 * Manages embedding model lifecycle with reference counting
 */

import os from 'os';
import path from 'path';
import { env, pipeline, Pipeline } from '@xenova/transformers';

// Set cache directory to user-writable location to avoid permission issues in global installs
env.cacheDir = path.join(os.homedir(), '.cache', 'transformers');
import {
  ModelConfig,
  ComputeDevice,
  ModelMetadata,
  BGE_LARGE_MODEL_ID,
  MINI_LM_MODEL_ID,
  BGE_LARGE_DIMENSIONS,
  MINI_LM_DIMENSIONS,
  ENV_PRECISION,
  ENV_DEVICE,
  ENV_USE_GPU,
  ENV_GPU_FALLBACK,
} from './types.js';
import { logger } from '../utils/logger.js';

let instance: ModelManager | null = null;

/**
 * Singleton ModelManager for embedding model lifecycle management.
 * Prevents VRAM duplication by sharing model across multiple users.
 * Reference counting ensures model stays loaded while in use.
 */
export class ModelManager {
  private config: ModelConfig;
  private extractor: Pipeline | null = null;
  private refCount: number = 0;
  private loadingPromise: Promise<Pipeline | null> | null = null;
  /** The actual model ID that was loaded (may differ from config.modelId after fallback) */
  private activeModelId: string = BGE_LARGE_MODEL_ID;

  private constructor(config: ModelConfig) {
    this.config = config;
  }

  /**
   * Get singleton instance, creating if necessary
   */
  static getInstance(): ModelManager {
    if (!instance) {
      const config = ModelManager.createConfig();
      instance = new ModelManager(config);
    }
    return instance;
  }

  /**
   * Create ModelConfig from environment variables
   */
  private static createConfig(): ModelConfig {
    const envPrecision = process.env[ENV_PRECISION] as ModelConfig['precision'] | undefined;
    const envDevice = process.env[ENV_DEVICE] as ComputeDevice | undefined;
    const envUseGpu = process.env[ENV_USE_GPU];
    const gpuFallback = process.env[ENV_GPU_FALLBACK];

    return {
      modelId: BGE_LARGE_MODEL_ID,
      device: envDevice ?? 'auto',
      precision: envPrecision ?? 'fp32',
      useGpu: envUseGpu === 'true',
      gpuFallback: gpuFallback !== 'false', // Default true
    };
  }

  /**
   * Acquire model (increment reference count).
   * Loads model if not already loaded.
   * Lazy loading with retry - doesn't block caller.
   */
  async acquire(): Promise<Pipeline> {
    this.refCount++;
    if (this.extractor) return this.extractor;
    if (this.loadingPromise) return this.loadingPromise as Promise<Pipeline>;

    this.loadingPromise = this.loadModelWithFallback();
    return this.loadingPromise as Promise<Pipeline>;
  }

  /**
   * Load model with automatic GPU->CPU fallback.
   * Tries BGE-Large on GPU first; if it fails and gpuFallback is enabled, falls back to MiniLM on CPU.
   */
  private async loadModelWithFallback(): Promise<Pipeline> {
    const gpuFallback = this.config.gpuFallback ?? true;

    // If device is CPU, just load MiniLM directly
    if (this.config.device === 'cpu' || !this.config.useGpu) {
      return this.loadModelWithRetry(MINI_LM_MODEL_ID, 'cpu');
    }

    // Try GPU with BGE-Large first
    try {
      await this.loadModelWithRetry(BGE_LARGE_MODEL_ID, 'cuda');
      if (this.extractor) return this.extractor;
    } catch (gpuErr) {
      if (!gpuFallback) {
        throw gpuErr;
      }
      logger.warn('GPU/BGE model failed to load, falling back to CPU/MiniLM:', gpuErr instanceof Error ? gpuErr.message : String(gpuErr));
    }

    // Fallback to MiniLM on CPU
    logger.info('Using CPU fallback model: MiniLM (384-dim)');
    return this.loadModelWithRetry(MINI_LM_MODEL_ID, 'cpu');
  }

  /**
   * Internal: Load a specific model with retry
   */
  private async loadModelWithRetry(modelId: string, device: string, retries = 3): Promise<Pipeline> {
    let lastError: Error | null = null;

    for (let i = 0; i < retries; i++) {
      try {
        await this.loadModelSpecific(modelId, device);
        if (this.extractor) return this.extractor;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }

    throw new Error(`Failed to load model '${modelId}' on '${device}' after ${retries} retries: ${lastError?.message}`);
  }

  /**
   * Internal: Load a specific model ID on specific device (no fallback here)
   */
  private async loadModelSpecific(modelId: string, device: string): Promise<void> {
    if (this.extractor) return;

    this.loadingPromise = (async () => {
      this.config.modelId = modelId;
      this.activeModelId = modelId;

      // Determine dtype based on precision
      let dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | undefined;
      if (this.config.precision === 'fp16') {
        dtype = 'fp16';
      }

      try {
        // @ts-expect-error @xenova/transformers types don't fully reflect runtime API
        this.extractor = await pipeline('feature-extraction', modelId, { dtype, device });
      } catch (error) {
        const errorMsg = [
          `Failed to load embedding model '${modelId}' on device '${device}'.`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          ``,
          `To fix this, either:`,
          `  1. Set BOOMERANG_DEVICE=cpu to use CPU-only mode`,
          `  2. Ensure GPU drivers are properly installed for CUDA`,
          `  3. Check that your GPU has enough VRAM for the model`,
          `  4. Set GPU_FALLBACK=false to disable auto CPU fallback`,
        ].join('\n');
        throw new Error(errorMsg);
      }

      return this.extractor;
    })();

    await this.loadingPromise;
  }

  /**
   * Release model (decrement reference count).
   * Unloads model when reference count reaches zero.
   */
  async release(): Promise<void> {
    if (this.refCount > 0) {
      this.refCount--;
    }
    if (this.refCount === 0 && this.extractor) {
      this.unload();
    }
  }

  /**
   * Get current reference count
   */
  getRefCount(): number {
    return this.refCount;
  }

  /**
   * Select appropriate model based on device and availability
   */
  selectModel(device: ComputeDevice = this.config.device): string {
    if (device === 'cpu' || !this.config.useGpu) {
      return MINI_LM_MODEL_ID;
    }
    return BGE_LARGE_MODEL_ID;
  }

  /**
   * Unload model and trigger garbage collection
   */
  unload(): void {
    if (this.extractor) {
      this.extractor = null;
    }
    this.refCount = 0;
    this.loadingPromise = null;
    this.activeModelId = this.config.modelId; // Reset to configured model

    // Suggest garbage collection for VRAM cleanup (Node.js specific)
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
  }

  /**
   * Get the embedding dimensions for current model.
   * Uses the actually-loaded model (activeModelId), or predicts based on config if not loaded.
   */
  getDimensions(): number {
    // If model is loaded, use active model dimensions
    if (this.extractor) {
      return this.activeModelId === BGE_LARGE_MODEL_ID ? BGE_LARGE_DIMENSIONS : MINI_LM_DIMENSIONS;
    }
    // Model not loaded yet - predict which model will be loaded based on config
    const willUseGpu = this.config.device !== 'cpu' && this.config.useGpu;
    if (!willUseGpu && this.config.gpuFallback !== false) {
      // Will fall back to MiniLM
      return MINI_LM_DIMENSIONS;
    }
    return BGE_LARGE_DIMENSIONS;
  }

  /**
   * Get the actual model ID that was loaded (may differ from config.modelId after fallback)
   */
  getActiveModelId(): string {
    return this.activeModelId;
  }

  /**
   * Get current model metadata
   */
  getMetadata(): ModelMetadata {
    return {
      modelId: this.activeModelId,
      dimensions: this.getDimensions(),
      device: this.config.device,
      precision: this.config.precision,
      isLoaded: this.extractor !== null,
      referenceCount: this.refCount,
    };
  }

  /**
   * Get the transformer pipeline instance
   * Throws if model not loaded
   */
  getExtractor(): Pipeline {
    if (!this.extractor) {
      throw new Error('Model not loaded. Call acquire() first.');
    }
    return this.extractor;
  }

  /**
   * Check if GPU is available
   */
  isGpuAvailable(): boolean {
    return this.config.useGpu && this.config.device !== 'cpu';
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(updates: Partial<ModelConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  /**
   * Force reload the model (e.g., after config change)
   */
  async reload(): Promise<void> {
    this.unload();
    await this.acquire();
  }
}

export default ModelManager;
