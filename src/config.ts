/**
 * Configuration management for Super-Memory
 * 
 * Supports loading from environment variables and JSON config files.
 */

import { readFile } from 'fs/promises';
import { resolve } from 'path';

// ==================== Types ====================

export type Precision = 'fp32' | 'fp16' | 'q8' | 'q4';
export type ComputeDevice = 'auto' | 'gpu' | 'cpu';

export interface Config {
  model: ModelConfig;
  database: DatabaseConfig;
  indexer: IndexerConfig;
  logging: LoggingConfig;
}

export interface ModelConfig {
  precision: Precision;
  device: ComputeDevice;
  useGpu: boolean;
  embeddingDim: number;
  batchSize: number;
}

export interface DatabaseConfig {
  dbPath: string;
  tableName: string;
}

export interface IndexerConfig {
  chunkSize: number;
  chunkOverlap: number;
  maxFileSize: number;
  excludePatterns: string[];
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
}

// ==================== Constants ====================

const CONFIG_FILE_NAME = 'super-memory.json';

const DEFAULT_CONFIG: Config = {
  model: {
    precision: 'fp16',
    device: 'auto',
    useGpu: false,
    embeddingDim: 1024,
    batchSize: 32,
  },
  database: {
    dbPath: './.super-memory/db',
    tableName: 'memories',
  },
  indexer: {
    chunkSize: 512,
    chunkOverlap: 50,
    maxFileSize: 10 * 1024 * 1024, // 10MB
    excludePatterns: ['node_modules', '.git', 'dist', '*.log', '.DS_Store'],
  },
  logging: {
    level: 'info',
  },
};

// ==================== Environment Variable Names ====================

export const ENV_VARS = {
  BOOMERANG_PRECISION: 'BOOMERANG_PRECISION',
  BOOMERANG_DEVICE: 'BOOMERANG_DEVICE',
  BOOMERANG_USE_GPU: 'BOOMERANG_USE_GPU',
  BOOMERANG_EMBEDDING_DIM: 'BOOMERANG_EMBEDDING_DIM',
  BOOMERANG_DB_PATH: 'BOOMERANG_DB_PATH',
  BOOMERANG_LOG_LEVEL: 'BOOMERANG_LOG_LEVEL',
  BOOMERANG_CHUNK_SIZE: 'BOOMERANG_CHUNK_SIZE',
  BOOMERANG_CHUNK_OVERLAP: 'BOOMERANG_CHUNK_OVERLAP',
  BOOMERANG_MAX_FILE_SIZE: 'BOOMERANG_MAX_FILE_SIZE',
  BOOMERANG_ROOT_PATH: 'BOOMERANG_ROOT_PATH',
} as const;

// ==================== Validation ====================

const VALID_PRECISIONS: Precision[] = ['fp32', 'fp16', 'q8', 'q4'];
const VALID_DEVICES: ComputeDevice[] = ['auto', 'gpu', 'cpu'];
const VALID_LOG_LEVELS: Config['logging']['level'][] = ['debug', 'info', 'warn', 'error'];

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateConfig(config: Config): ValidationResult {
  const errors: string[] = [];

  // Model validation
  if (!VALID_PRECISIONS.includes(config.model.precision)) {
    errors.push(`Invalid precision: ${config.model.precision}. Must be one of: ${VALID_PRECISIONS.join(', ')}`);
  }
  if (!VALID_DEVICES.includes(config.model.device)) {
    errors.push(`Invalid device: ${config.model.device}. Must be one of: ${VALID_DEVICES.join(', ')}`);
  }
  if (config.model.embeddingDim <= 0) {
    errors.push('Embedding dimension must be positive');
  }
  if (config.model.batchSize <= 0) {
    errors.push('Batch size must be positive');
  }

  // Database validation
  if (!config.database.dbPath) {
    errors.push('Database path is required');
  }

  // Indexer validation
  if (config.indexer.chunkSize <= 0) {
    errors.push('Chunk size must be positive');
  }
  if (config.indexer.chunkOverlap < 0) {
    errors.push('Chunk overlap cannot be negative');
  }
  if (config.indexer.maxFileSize <= 0) {
    errors.push('Max file size must be positive');
  }

  // Logging validation
  if (!VALID_LOG_LEVELS.includes(config.logging.level)) {
    errors.push(`Invalid log level: ${config.logging.level}. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ==================== Config Loading ====================

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
}

function parseEnvConfig(): Partial<Config> {
  return {
    model: {
      precision: (process.env[ENV_VARS.BOOMERANG_PRECISION] as Precision) || DEFAULT_CONFIG.model.precision,
      device: (process.env[ENV_VARS.BOOMERANG_DEVICE] as ComputeDevice) || DEFAULT_CONFIG.model.device,
      useGpu: parseBoolean(process.env[ENV_VARS.BOOMERANG_USE_GPU], DEFAULT_CONFIG.model.useGpu),
      embeddingDim: parseInt(process.env[ENV_VARS.BOOMERANG_EMBEDDING_DIM] || '', 10) || DEFAULT_CONFIG.model.embeddingDim,
      batchSize: DEFAULT_CONFIG.model.batchSize,
    },
    database: {
      dbPath: process.env[ENV_VARS.BOOMERANG_DB_PATH] || DEFAULT_CONFIG.database.dbPath,
      tableName: DEFAULT_CONFIG.database.tableName,
    },
    indexer: {
      chunkSize: parseInt(process.env[ENV_VARS.BOOMERANG_CHUNK_SIZE] || '', 10) || DEFAULT_CONFIG.indexer.chunkSize,
      chunkOverlap: parseInt(process.env[ENV_VARS.BOOMERANG_CHUNK_OVERLAP] || '', 10) || DEFAULT_CONFIG.indexer.chunkOverlap,
      maxFileSize: parseInt(process.env[ENV_VARS.BOOMERANG_MAX_FILE_SIZE] || '', 10) || DEFAULT_CONFIG.indexer.maxFileSize,
      excludePatterns: DEFAULT_CONFIG.indexer.excludePatterns,
    },
    logging: {
      level: (process.env[ENV_VARS.BOOMERANG_LOG_LEVEL] as Config['logging']['level']) || DEFAULT_CONFIG.logging.level,
    },
  };
}

async function loadJsonConfig(configPath: string): Promise<Partial<Config>> {
  try {
    const content = await readFile(resolve(configPath), 'utf-8');
    const json = JSON.parse(content);
    
    return {
      model: json.model ? {
        precision: json.model.precision || DEFAULT_CONFIG.model.precision,
        device: json.model.device || DEFAULT_CONFIG.model.device,
        useGpu: json.model.useGpu ?? DEFAULT_CONFIG.model.useGpu,
        embeddingDim: json.model.embeddingDim || DEFAULT_CONFIG.model.embeddingDim,
        batchSize: json.model.batchSize || DEFAULT_CONFIG.model.batchSize,
      } : undefined,
      database: json.database ? {
        dbPath: json.database.dbPath || DEFAULT_CONFIG.database.dbPath,
        tableName: json.database.tableName || DEFAULT_CONFIG.database.tableName,
      } : undefined,
      indexer: json.indexer ? {
        chunkSize: json.indexer.chunkSize || DEFAULT_CONFIG.indexer.chunkSize,
        chunkOverlap: json.indexer.chunkOverlap ?? DEFAULT_CONFIG.indexer.chunkOverlap,
        maxFileSize: json.indexer.maxFileSize || DEFAULT_CONFIG.indexer.maxFileSize,
        excludePatterns: json.indexer.excludePatterns || DEFAULT_CONFIG.indexer.excludePatterns,
      } : undefined,
      logging: json.logging ? {
        level: json.logging.level || DEFAULT_CONFIG.logging.level,
      } : undefined,
    };
  } catch {
    // Config file doesn't exist or is invalid - use defaults
    return {};
  }
}

/**
 * Deep merge two objects
 */
function deepMerge<T>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] !== undefined) {
      if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])) {
        result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>) as T[Extract<keyof T, string>];
      } else {
        result[key] = source[key] as T[Extract<keyof T, string>];
      }
    }
  }
  return result;
}

/**
 * Load configuration from environment variables and optional JSON config file
 * 
 * Priority (highest to lowest):
 * 1. Environment variables
 * 2. JSON config file
 * 3. Default values
 */
export async function loadConfig(configPath?: string): Promise<Config> {
  // Try to load from JSON config file first (lowest priority)
  const jsonConfig = configPath 
    ? await loadJsonConfig(configPath) 
    : await loadJsonConfig(CONFIG_FILE_NAME);
  
  // Environment variables override JSON config (medium priority)
  const envConfig = parseEnvConfig();
  
  // Merge: defaults < JSON < env
  let config = deepMerge(DEFAULT_CONFIG, jsonConfig);
  config = deepMerge(config, envConfig);
  
  return config;
}

/**
 * Synchronous config load (uses defaults and env vars only, no JSON file)
 */
export function loadConfigSync(configPath?: string): Config {
  const envConfig = parseEnvConfig();
  
  if (configPath) {
    // For sync, we can't load JSON, so just use env vars and defaults
    return deepMerge(DEFAULT_CONFIG, envConfig);
  }
  
  return deepMerge(DEFAULT_CONFIG, envConfig);
}

// ==================== Config Instance ====================

let configInstance: Config | null = null;

/**
 * Get the singleton config instance
 */
export function getConfig(): Config {
  if (!configInstance) {
    configInstance = loadConfigSync();
  }
  return configInstance;
}

/**
 * Reset the config instance (useful for testing)
 */
export function resetConfig(): void {
  configInstance = null;
}