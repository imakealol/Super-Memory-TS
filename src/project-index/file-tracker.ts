import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';

export interface TrackedFile {
  hash: string;
  lastIndexed: string;
  chunkCount: number;
}

/** Database row shape for indexed_files table */
interface IndexedFileRow {
  file_path: string;
  content_hash: string;
  last_indexed: string;
  chunk_count: number;
}

/**
 * SQLite-based persistent file tracker to avoid re-indexing unchanged files.
 */
export class FileTracker {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.initTable();
  }

  private initTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexed_files (
        file_path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        last_indexed TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      )
    `);
  }

  getFile(filePath: string): TrackedFile | undefined {
    const row = this.db.prepare('SELECT * FROM indexed_files WHERE file_path = ?').get(filePath) as unknown as IndexedFileRow | undefined;
    if (!row) return undefined;
    return {
      hash: row.content_hash,
      lastIndexed: row.last_indexed,
      chunkCount: row.chunk_count,
    };
  }

  setFile(filePath: string, hash: string, chunkCount: number): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO indexed_files (file_path, content_hash, last_indexed, chunk_count)
      VALUES (?, ?, ?, ?)
    `).run(filePath, hash, new Date().toISOString(), chunkCount);
  }

  removeFile(filePath: string): void {
    this.db.prepare('DELETE FROM indexed_files WHERE file_path = ?').run(filePath);
  }

  getAllFiles(): Map<string, TrackedFile> {
    const rows = this.db.prepare('SELECT * FROM indexed_files').all() as unknown as IndexedFileRow[];
    const map = new Map<string, TrackedFile>();
    for (const row of rows) {
      map.set(row.file_path, {
        hash: row.content_hash,
        lastIndexed: row.last_indexed,
        chunkCount: row.chunk_count,
      });
    }
    return map;
  }

  close(): void {
    this.db.close();
  }
}