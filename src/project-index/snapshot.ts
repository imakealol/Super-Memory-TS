import createXXHash64 from 'xxhash-wasm';
import { promises as fs, statSync, type Dirent } from 'node:fs';
import { glob } from 'node:fs/promises';
import { resolve, relative, dirname } from 'path';
import { loadGitignorePatterns } from './indexer.js';
import { ALWAYS_EXCLUDED_PATTERNS } from './constants.js';

interface SnapshotEntry {
  hash: string;        // xxhash64 hex
  size: number;        // file size in bytes
  mtime: number;       // modification time ms
  lastIndexed: number; // timestamp
}

interface Snapshot {
  version: number;
  createdAt: number;
  files: Record<string, SnapshotEntry>; // path relative to root -> entry
}

interface FileDelta {
  new: string[];      // paths not in snapshot
  changed: string[];  // paths with different hash
  deleted: string[];  // paths in snapshot but not on disk
  unchanged: string[]; // paths with same hash
}

export class SnapshotIndex {
  private xxhash!: Awaited<ReturnType<typeof createXXHash64>>;
  private snapshotPath: string;
  private rootPath: string;
  private snapshot: Snapshot;
  
  constructor(rootPath: string, snapshotPath: string) {
    this.rootPath = resolve(rootPath);
    this.snapshotPath = snapshotPath;
    this.snapshot = { version: 1, createdAt: 0, files: {} };
  }
  
  async init(): Promise<void> {
    this.xxhash = await createXXHash64();
    await this.load();
  }
  
  private async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.snapshotPath, 'utf-8');
      this.snapshot = JSON.parse(data);
    } catch {
      this.snapshot = { version: 1, createdAt: Date.now(), files: {} };
    }
  }
  
  async save(): Promise<void> {
    const tmpPath = this.snapshotPath + '.tmp';
    await fs.mkdir(dirname(tmpPath), { recursive: true });
    await fs.writeFile(tmpPath, JSON.stringify(this.snapshot, null, 2));
    await fs.rename(tmpPath, this.snapshotPath);
  }
  
  private async computeHash(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    // h64Raw works with Uint8Array and returns bigint, then convert to hex
    const hash = this.xxhash.h64Raw(buffer);
    return hash.toString(16).padStart(16, '0');
  }
  
  async scan(): Promise<FileDelta> {
    // Load .gitignore patterns and combine with hardcoded patterns
    const gitignorePatterns = loadGitignorePatterns(this.rootPath);
    const excludePatterns = [...ALWAYS_EXCLUDED_PATTERNS, ...gitignorePatterns];

    // Helper to check if path matches any exclude pattern
    const isExcluded = (path: string | Dirent): boolean => {
      const filePath = typeof path === 'string' ? path : path.name;
      return excludePatterns.some(pattern => {
        // Convert glob pattern to regex-like check
        const regexPattern = pattern
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '.');
        return new RegExp('^' + regexPattern + '$').test(filePath);
      });
    };

    // Glob all files respecting exclude patterns - node:fs/promises.glob returns async iterable
    const allFiles: string[] = [];
    for await (const file of glob('**/*', {
      cwd: this.rootPath,
      withFileTypes: false,
      exclude: isExcluded as (file: string | Dirent<string>) => boolean,
    })) {
      // Convert relative path to absolute
      const absolutePath = resolve(this.rootPath, file as string);
      allFiles.push(absolutePath);
    }
    
    const currentPaths = new Set<string>();
    const delta: FileDelta = { new: [], changed: [], deleted: [], unchanged: [] };
    
    for (const filePath of allFiles) {
      const relPath = relative(this.rootPath, filePath);
      currentPaths.add(relPath);
      
      const stat = statSync(filePath);
      const existing = this.snapshot.files[relPath];
      
      // Fast path: if mtime and size match, assume unchanged
      if (existing && existing.size === stat.size && existing.mtime === stat.mtimeMs) {
        delta.unchanged.push(relPath);
        continue;
      }
      
      // Need to compute hash
      const hash = await this.computeHash(filePath);
      
      if (!existing) {
        delta.new.push(relPath);
      } else if (existing.hash !== hash) {
        delta.changed.push(relPath);
      } else {
        delta.unchanged.push(relPath);
      }
      
      // Update snapshot entry
      this.snapshot.files[relPath] = {
        hash,
        size: stat.size,
        mtime: stat.mtimeMs,
        lastIndexed: Date.now()
      };
    }
    
    // Find deleted files
    for (const relPath of Object.keys(this.snapshot.files)) {
      if (!currentPaths.has(relPath)) {
        delta.deleted.push(relPath);
        delete this.snapshot.files[relPath];
      }
    }
    
    this.snapshot.createdAt = Date.now();
    await this.save();
    
    return delta;
  }
  
  getFileHash(relPath: string): string | undefined {
    return this.snapshot.files[relPath]?.hash;
  }
  
  isIndexed(relPath: string): boolean {
    return relPath in this.snapshot.files;
  }
  
  markDeleted(relPath: string): void {
    delete this.snapshot.files[relPath];
  }
}