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

    return {
      modelId: BGE_LARGE_MODEL_ID,
      device: envDevice ?? 'auto',
      precision: envPrecision ?? 'fp32',
      useGpu: envUseGpu === 'true',
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

    this.loadingPromise = this.loadModelWithRetry();
    return this.loadingPromise as Promise<Pipeline>;
  }

  /**
   * Load model with retry mechanism for transient failures
   */
  private async loadModelWithRetry(retries = 3): Promise<Pipeline> {
    let lastError: Error | null = null;

    for (let i = 0; i < retries; i++) {
      try {
        await this.loadModel();
        if (this.extractor) return this.extractor;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn(`Model load attempt ${i + 1} failed, retrying...`, lastError.message);
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        }
      }
    }

    throw new Error(`Failed to load model after ${retries} retries: ${lastError?.message}`);
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
   * Load the embedding model with specified precision
   * Throws error if loading fails - no silent fallback to prevent dimension mismatch
   */
  private async loadModel(): Promise<void> {
    if (this.extractor) return;

    this.loadingPromise = (async () => {
      const modelId = this.selectModel();
      this.config.modelId = modelId;

      // Determine dtype based on precision
      let dtype: 'fp32' | 'fp16' | 'q8' | 'q4' | undefined;
      if (this.config.precision === 'fp16') {
        dtype = 'fp16';
      }

      // Determine device
      let device: string;
      switch (this.config.device) {
        case 'gpu':
          device = 'cuda';
          break;
        case 'cpu':
          device = 'cpu';
          break;
        case 'auto':
        default:
          device = 'auto';
      }

      try {
        // @ts-expect-error @xenova/transformers types don't fully reflect runtime API
        this.extractor = await pipeline('feature-extraction', modelId, { dtype, device });
      } catch (error) {
        // DO NOT silently fallback - dimension mismatch causes crashes
        // Instead, throw a clear error that tells user to use CPU or fix GPU setup
        const errorMsg = [
          `Failed to load embedding model '${modelId}' on device '${device}'.`,
          `Error: ${error instanceof Error ? error.message : String(error)}`,
          ``,
          `To fix this, either:`,
          `  1. Set BOOMERANG_DEVICE=cpu to use CPU-only mode`,
          `  2. Ensure GPU drivers are properly installed for CUDA`,
          `  3. Check that your GPU has enough VRAM for the model`,
        ].join('\n');
        throw new Error(errorMsg);
      }

      return this.extractor;
    })();

    await this.loadingPromise;
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

    // Suggest garbage collection for VRAM cleanup (Node.js specific)
    if (typeof globalThis.gc === 'function') {
      globalThis.gc();
    }
  }

  /**
   * Get the embedding dimensions for current model
   * Uses selectModel to determine which model will actually be used
   */
  getDimensions(): number {
    const actualModelId = this.selectModel();
    if (actualModelId === BGE_LARGE_MODEL_ID) {
      return BGE_LARGE_DIMENSIONS;
    }
    return MINI_LM_DIMENSIONS;
  }

  /**
   * Get current model metadata
   */
  getMetadata(): ModelMetadata {
    return {
      modelId: this.config.modelId,
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
