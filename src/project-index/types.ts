/**
 * Project index types
 */

// ==================== Core Interfaces ====================

export interface ProjectChunk {
  id: string;
  filePath: string;
  content: string;
  vector?: Float32Array;
  chunkIndex: number;
  totalChunks: number;
  fileType: string;
  contentHash: string;
  lastModified: Date;
  lineStart: number;
  lineEnd: number;
}

export interface ProjectIndexConfig {
  rootPath: string;
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;
  chunkSize: number;
  chunkOverlap: number;
  // Performance config (optional)
  workers?: number;
  flushIntervalMs?: number;
  flushThreshold?: number;
  memoryThreshold?: number;
  maxBufferBytes?: number;
}

export interface ProjectIndexConfigInternal {
  rootPath: string;
  includePatterns: string[];
  excludePatterns: string[];
  maxFileSize: number;
  chunkSize: number;
  chunkOverlap: number;
  workers: number;
  flushIntervalMs: number;
  flushThreshold: number;
  memoryThreshold: number;
  maxBufferBytes: number;
}

// ==================== File Events ====================

export type FileEventType = 'add' | 'change' | 'unlink';

export interface FileEvent {
  type: FileEventType;
  path: string;
  timestamp: Date;
  size?: number;
}

// ==================== Chunking ====================

export interface ChunkOptions {
  maxChunkSize: number;
  overlap: number;
  minChunkSize: number;
  splitBy: 'lines' | 'semantic' | 'sliding';
}

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  startToken: number;
  endToken: number;
}

// ==================== Indexed Files ====================

export interface IndexedFile {
  path: string;
  hash: string;
  lastModified: Date;
  fileType: string;
  size: number;
  chunkCount: number;
}

export interface FileHash {
  hash: string;
  timestamp: Date;
}

// ==================== Search ====================

export interface ProjectSearchOptions {
  topK?: number;
  mode?: 'tiered' | 'parallel';
  rerank?: boolean;
  filters?: ProjectSearchFilters;
  fileTypes?: string[];
}

export interface ProjectSearchFilters {
  since?: Date;
  fileTypes?: string[];
  paths?: string[];
}

export interface ProjectSearchResult {
  chunk: ProjectChunk;
  score: number;
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

// ==================== Watcher ====================

export interface WatcherConfig {
  paths: string[];
  includePatterns: string[];
  excludePatterns: string[];
  debounceMs: number;
  ignoreHidden?: boolean;
}

// ==================== Indexer ====================

export interface ProjectIndexerStats {
  totalFiles: number;
  totalChunks: number;
  indexedFiles: number;
  failedFiles: number;
  lastIndexing?: Date;
}

export interface IndexerEvents {
  'file': (event: FileEvent) => void;
  'ready': () => void;
  'error': (error: Error) => void;
  'stats': (stats: ProjectIndexerStats) => void;
}