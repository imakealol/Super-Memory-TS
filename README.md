# Super-Memory-TS

[![npm version](https://img.shields.io/npm/v/@veedubin/super-memory-ts)](https://www.npmjs.com/package/@veedubin/super-memory-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first semantic memory server with project indexing for AI assistants.**

> **Version**: v2.3.3 | **Database**: Qdrant (HNSW indexing, payload filtering) | **Embeddings**: BGE-Large (GPU, 1024-dim) / MiniLM-L6-v2 (CPU, 384-dim) | **Precision**: fp16 (~325MB) | **NPM**: [@veedubin/super-memory-ts](https://www.npmjs.com/package/@veedubin/super-memory-ts)

Super-Memory-TS is a TypeScript implementation of a persistent, local-first memory system that provides semantic search over memories and project code using embeddings and vector search. It runs as an MCP (Model Context Protocol) server, enabling AI assistants like Boomerang to store, retrieve, and search through accumulated knowledge.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Performance](#performance)
- [Development](#development)

---

## Overview

### What is Super-Memory v2?

Super-Memory v2 is a complete rewrite of the original Python-based memory system in TypeScript. It provides:

- **Semantic Memory Search**: Store and retrieve memories using natural language queries
- **Project Indexing**: Automatically index project files for code-aware search
- **Local-First**: All data stays on your machine—no cloud dependencies
- **MCP Server**: Standard MCP protocol for integration with AI assistants
- **FP16 Support**: Reduce memory usage by 50% with floating-point precision options
- **HNSW Vector Search**: Sub-10ms query latency using state-of-the-art approximate nearest neighbor search

### Key Features

| Feature | Description |
|---------|-------------|
| **fp16/fp32 Precision** | Reduce memory footprint from ~650MB to ~325MB per model instance |
| **BGE-Large Embeddings** | 1024-dimensional embeddings from BAAI/bge-large-en-v1.5 |
| **MiniLM Fallback** | CPU-friendly 384-dimensional embeddings from sentence-transformers/all-MiniLM-L6-v2 |
| **HNSW Index** | IVF_HNSW_SQ index for optimal recall/speed tradeoff |
| **Incremental Indexing** | xxhash-wasm snapshot-based change detection (10x faster than SHA-256) |
| **Semantic Chunking** | Intelligent code splitting at function/class boundaries |
| **Reference Counting** | Singleton model manager prevents VRAM duplication |
| **Project Isolation** | Payload-based filtering by `projectId` for multi-project memory separation |
| **Tiered Search** | `tiered` (default), `vector_only`, `text_only` search strategies |
| **Snapshot Indexing** | `.opencode/super-memory-ts/snapshot.json` for persistent file tracking |

---

## Features

### Project Isolation

Super-Memory-TS supports **multi-project memory isolation** using `projectId` tagging in Qdrant payloads.

#### How It Works

1. **Set Project ID** via `BOOMERANG_PROJECT_ID` environment variable:
   ```bash
   export BOOMERANG_PROJECT_ID=my-project
   ```

2. **Automatic Tagging**: All memories added are tagged with `projectId` in the Qdrant payload

3. **Automatic Filtering**: Queries are automatically filtered by `projectId` - you only see memories from the current project

4. **Backward Compatible**: Memories without a `projectId` tag are still searchable (untagged memories are visible to all projects)

#### Use Cases

- **Single project**: Set `BOOMERANG_PROJECT_ID` once, all operations are isolated
- **Multiple projects**: Change `BOOMERANG_PROJECT_ID` to switch between projects
- **Shared memories**: Omit `BOOMERANG_PROJECT_ID` to create cross-project shared memories

#### Example

```typescript
// In project "backend-api"
await memorySystem.addMemory({ text: "Use JWT for auth" });
// → Stored with projectId: "backend-api"

// Query from "backend-api" → Returns the JWT memory
// Query from "frontend-app" → Does NOT see the JWT memory
```

---

### Semantic Memory Search

Store memories with automatic embedding generation and retrieve them using natural language queries:

```typescript
// Add a memory
await memorySystem.addMemory({
  text: "User prefers dark mode in VS Code",
  sourceType: 'session',
  metadata: { context: "settings discussion" }
});

// Query memories
const results = await memorySystem.queryMemories("What theme settings does the user have?");
```

### Automatic Project Indexing

Index project files on startup with background watching for changes:

- Supports TypeScript, JavaScript, Python, Markdown, JSON, and more
- Semantic chunking preserves code structure (functions, classes)
- Incremental updates via SHA-256 hash comparison
- File watching with debouncing (500ms)

#### Custom Path Indexing

You can index any directory using the `path` parameter in the `index_project` tool:

```json
{
  "path": "/path/to/other/project",
  "force": true
}
```

**Use cases**:
- Index a subdirectory of your project
- Index a completely different codebase
- Re-index specific folders after major changes

**Example**: Index a shared library:
```json
{
  "path": "/home/user/Projects/shared-utils",
  "force": false
}
```

### Tiered Memory Architecture

Super-Memory-TS provides **two search strategies** optimized for different use cases:

| Mode | Strategy | Description | Best For |
|------|----------|-------------|----------|
| **Fast Reply** | `TIERED` (default) | Quick MiniLM search with BGE fallback | Interactive queries, real-time responses |
| **Archivist** | `PARALLEL` | Dual-tier search with RRF fusion | Comprehensive recall, research tasks |

#### Fast Reply (TIERED)

Hybrid approach optimized for speed:

1. **Primary**: MiniLM-L6-v2 (384-dim) search - fast CPU-based search
2. **Fallback**: BGE-Large (1024-dim) for refinement when MiniLM results are ambiguous
3. **Use when**: Speed matters, general purpose queries

```
Query → MiniLM Search → [if low confidence] → BGE Refinement → Results
```

#### Archivist (PARALLEL)

Dual-tier search optimized for recall:

1. **Parallel**: Both MiniLM and BGE searches run simultaneously
2. **Fusion**: Reciprocal Rank Fusion (RRF) combines results
3. **Use when**: Thorough search is needed, research, debugging

```
Query → MiniLM Search ─┐
                       ├→ RRF Fusion → Results
       → BGE Search   ─┘
```

#### Configuration

```bash
# Default: TIERED (Fast Reply)
BOOMERANG_SEARCH_STRATEGY=tiered

# Archivist mode for maximum recall
BOOMERANG_SEARCH_STRATEGY=parallel
```

Or via MCP tool:
```json
{
  "query": "authentication middleware",
  "strategy": "parallel"
}
```

### HNSW Vector Search

High-performance approximate nearest neighbor search:

```typescript
// Configure HNSW index
const HNSW_CONFIG = {
  m: 16,                    // Max connections per layer
  efConstruction: 128,      // Build-time search depth
  efSearch: 64,            // Query-time search depth
  distanceType: 'cosine',  // Cosine similarity
};
```

### CPU/GPU Support

Automatic device detection with fallback:

- **GPU**: BGE-Large with fp16 for maximum quality
- **CPU**: MiniLM-L6-v2 fallback if GPU unavailable
- Environment variable control: `BOOMERANG_USE_GPU`, `BOOMERANG_DEVICE`

### Precision Options

| Precision | Memory (BGE-Large) | Accuracy | Use Case |
|-----------|-------------------|----------|----------|
| `fp32` | ~650MB | Highest | **Default** |
| `fp16` | ~325MB | Near-lossy | Production |
| `q8` | ~162MB | Good | Memory constrained |
| `q4` | ~81MB | Acceptable | Edge devices |

---

## Architecture

### Dual Use Cases

Super-Memory-TS supports **two integration modes**:

| Mode | Description | Use Case |
|------|-------------|----------|
| **MCP Server (External)** | Runs as standalone MCP server accessible via HTTP | External AI tools, cross-framework sharing |
| **Built-in (Boomerang)** | Core modules imported directly into Boomerang | Boomerang plugin operation, zero-overhead |

#### MCP Server Mode (External Users)
Traditional MCP server deployment for external AI assistants:
- Standalone Node.js process
- MCP protocol over stdio/HTTP
- Full tool interface (query_memories, add_memory, search_project, index_project)
- Suitable for Claude Desktop, Cursor, other MCP-compatible tools

#### Built-in Mode (Boomerang Integration)
Direct module integration with Boomerang:
- Core modules imported as TypeScript/JS imports
- No MCP protocol overhead
- Automatic startup and file watching
- Direct memory operations for Boomerang agents

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        SuperMemoryServer                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │  MCP Tools  │  │   Memory    │  │   ProjectIndexer        ││
│  │             │  │   System    │  │                         ││
│  │ query_      │  │             │  │  ┌─────────────────────┐ ││
│  │ memories    │  │  ┌────────┐  │  │   FileWatcher      │ ││
│  │             │  │  │Qdrant │  │  │   (chokidar)       │ ││
│  │ add_memory  │──│  │  +     │  │  │ └─────────────────────┘ ││
│  │             │  │  │ HNSW   │  │  │  ┌─────────────────────┐ ││
│  │ search_     │  │  └────────┘  │  │  │   FileChunker       │ ││
│  │ project     │  │             │  │  │   (semantic/sliding) │ ││
│  │             │  │             │  │  └─────────────────────┘ ││
│  │ index_      │  │             │  │                         ││
│  │ project     │  │             │  │                         ││
│  └─────────────┘  └─────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ModelManager (Singleton)                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  @xenova/transformers                        │ │
│  │  ┌─────────────────────┐    ┌─────────────────────────────┐ │ │
│  │  │   BGE-Large         │    │    MiniLM-L6-v2             │ │ │
│  │  │   (1024-dim, fp16)  │    │    (384-dim, fp32)         │ │ │
│  │  │   ~325MB            │    │    ~80MB                    │ │ │
│  │  └─────────────────────┘    └─────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Automatic Indexing

When integrated with Boomerang (built-in mode):

1. **Startup**: ProjectIndexer automatically scans and indexes project files
2. **Watching**: FileWatcher monitors for changes with 500ms debounce
3. **Incremental**: SHA-256 hash comparison skips unchanged files
4. **Background**: All indexing runs in background without blocking agent operations
┌─────────────────────────────────────────────────────────────────┐
│                        SuperMemoryServer                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐│
│  │  MCP Tools  │  │   Memory    │  │   ProjectIndexer        ││
│  │             │  │   System    │  │                         ││
│  │ query_      │  │             │  │  ┌─────────────────────┐ ││
│  │ memories    │  │  ┌────────┐  │  │  │   FileWatcher      │ ││
│  │             │  │  │Qdrant │  │  │  │   (chokidar)       │ ││
│  │ add_memory  │──│  │  +     │  │  │  └─────────────────────┘ ││
│  │             │  │  │ HNSW   │  │  │  ┌─────────────────────┐ ││
│  │ search_     │  │  └────────┘  │  │  │   FileChunker       │ ││
│  │ project     │  │             │  │  │   (semantic/sliding) │ ││
│  │             │  │             │  │  └─────────────────────┘ ││
│  │ index_      │  │             │  │                         ││
│  │ project     │  │             │  │                         ││
│  └─────────────┘  └─────────────┘  └─────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ModelManager (Singleton)                     │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │                  @xenova/transformers                        │ │
│  │  ┌─────────────────────┐    ┌─────────────────────────────┐ │ │
│  │  │   BGE-Large         │    │    MiniLM-L6-v2             │ │ │
│  │  │   (1024-dim, fp16)  │    │    (384-dim, fp32)         │ │ │
│  │  │   ~325MB            │    │    ~80MB                    │ │ │
│  │  └─────────────────────┘    └─────────────────────────────┘ │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

#### Memory Storage Flow

```
add_memory tool
      │
      ▼
┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│ Input Text   │────▶│ Generate        │────▶│ Qdrant      │
│              │     │ Embedding        │     │ + HNSW Index│
└──────────────┘     │ (ModelManager)  │     └─────────────┘
                     └─────────────────┘
```

#### Query Flow

```
query_memories tool
      │
      ▼
┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│ Query Text  │────▶│ Generate Query  │────▶│ HNSW Search │
│              │     │ Embedding       │     │ (Qdrant)    │
└──────────────┘     │ (ModelManager)  │     └─────────────┘
                     └─────────────────┘            │
                                                   ▼
                                          ┌─────────────────┐
                                          │ Return Top-K   │
                                          │ Results         │
                                          └─────────────────┘
```

#### Project Indexing Flow

```
FileWatcher (chokidar)
      │
      ├── add/change ──▶ processFile()
      │                      │
      │                      ▼
      │               ┌─────────────────┐
      │               │ Semantic        │
      │               │ Chunking         │
      │               └─────────────────┘
      │                      │
      │                      ▼
      │               ┌─────────────────┐
      │               │ Generate        │
      │               │ Embeddings       │
      │               └─────────────────┘
      │                      │
      │                      ▼
      │               ┌─────────────────┐
      └── unlink ────▶│ Remove from     │
                      │ Database        │
                      └─────────────────┘
```

### Model Layer (`src/model/`)

**ModelManager** - Singleton pattern with reference counting:

```typescript
// Get instance (creates if necessary)
const manager = ModelManager.getInstance();

// Acquire model (loads if not already)
await manager.acquire();

// Generate embeddings
const extractor = manager.getExtractor();
const embedding = await extractor(text, { pooling: 'mean', normalize: true });

// Release when done
manager.release();
```

**Models**:
- **BGE-Large** (`BAAI/bge-large-en-v1.5`): 1024-dim, fp16 capable
- **MiniLM-L6-v2** (`sentence-transformers/all-MiniLM-L6-v2`): 384-dim, CPU fallback

### Memory Storage (`src/memory/`)

**Qdrant** with HNSW indexing:

```typescript
// Schema
interface MemoryEntry {
  id: string;              // UUID
  text: string;            // Content
  vector: Float32Array;    // 1024-dim embedding
  sourceType: MemorySourceType;
  sourcePath?: string;
  timestamp: Date;
  contentHash: string;     // SHA-256 for deduplication
  metadataJson?: string;
}
```

**Search Strategies**:
- `TIERED`: Hybrid vector + keyword search (default)
- `VECTOR_ONLY`: Pure semantic similarity
- `TEXT_ONLY`: Keyword matching via Fuse.js

### Project Indexing (`src/project-index/`)

**FileChunker** - Hybrid chunking:
1. **Semantic**: Splits at function/class boundaries for code files
2. **Sliding Window**: Falls back for non-code or ambiguous content

**ProjectWatcher** - File monitoring:
- Uses `chokidar` for cross-platform file watching
- 500ms debounce to batch rapid changes
- SHA-256 hash comparison for incremental updates

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | ≥20.0.0 | Required for ESM modules |
| npm or bun | Latest | For package management |

**Optional**:
- CUDA-capable GPU (for GPU acceleration)
- Python 3.10+ (for @xenova/transformers)

### Install Dependencies

```bash
# Using npm
npm install

# Using bun (recommended for faster install)
bun install
```

### Build from Source

```bash
npm run build
```

This produces output in `dist/` directory.

---

## Quick Start

### 1. Environment Variables (Optional)

Create a `.env` file or set environment variables:

```bash
# Model configuration
BOOMERANG_PRECISION=fp16        # fp32, fp16, q8, q4
BOOMERANG_DEVICE=auto           # auto, gpu, cpu
BOOMERANG_USE_GPU=true          # true, false

# Database
export QDRANT_URL=http://localhost:6333  # Qdrant server URL

# Logging
BOOMERANG_LOG_LEVEL=info        # debug, info, warn, error

# Indexing
BOOMERANG_CHUNK_SIZE=512
BOOMERANG_CHUNK_OVERLAP=50
BOOMERANG_MAX_FILE_SIZE=10485760  # 10MB
```

### 2. Start the Server

```bash
# Development mode (with watch)
npm run dev

# Production mode
npm run build
npm start
```

### Build Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run prepublishOnly` | Runs `npm run build` before publish |
| `npm run dev` | Watch mode with `tsx` |
| `npm run test` | Run tests with `bun test` |
| `npm run lint` | ESLint on `src/` |

### 3. Basic Usage Example

```typescript
import { SuperMemoryServer } from './src/index.ts';

async function main() {
  const server = new SuperMemoryServer();
  await server.start();
  console.log('Super-Memory MCP Server running...');
}

main();
```

### 4. Configure Boomerang Plugin

In your Boomerang configuration:

```json
{
  "superMemory": {
    "server": "super-memory-ts",
    "enabled": true
  }
}
```

---

## Configuration

### Configuration File

Create `super-memory.json` in your project root:

```json
{
  "model": {
    "precision": "fp16",
    "device": "auto",
    "useGpu": false,
    "embeddingDim": 1024,
    "batchSize": 32
  },
  "database": {
    "qdrantUrl": "http://localhost:6333",
    "tableName": "memories"
  },
  "indexer": {
    "chunkSize": 512,
    "chunkOverlap": 50,
    "maxFileSize": 10485760,
    "excludePatterns": [
      "node_modules",
      ".git",
      "dist",
      "*.log"
    ]
  },
  "logging": {
    "level": "info"
  }
}
```

### Configuration Priority

Settings are merged in the following order (highest to lowest):

1. **Environment variables**
2. **JSON config file** (`super-memory.json`)
3. **Default values**

### Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `BOOMERANG_PRECISION` | `fp32` | Model precision: `fp32`, `fp16`, `q8`, `q4` |
| `BOOMERANG_DEVICE` | `auto` | Compute device: `auto`, `gpu`, `cpu` |
| `BOOMERANG_USE_GPU` | `false` | Enable GPU usage |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `BOOMERANG_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `BOOMERANG_CHUNK_SIZE` | `512` | Token chunk size for indexing |
| `BOOMERANG_CHUNK_OVERLAP` | `50` | Overlap between chunks |
| `BOOMERANG_MAX_FILE_SIZE` | `10485760` | Max file size (bytes) to index |
| `BOOMERANG_PROJECT_ID` | - | Project identifier for memory isolation |
| `BOOMERANG_SEARCH_STRATEGY` | `tiered` | Default search strategy: `tiered`, `parallel` |

---

## API Reference

### MCP Tools

The server provides five MCP tools:

#### `query_memories`

Semantic search over stored memories.

**Arguments**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search query text |
| `limit` | number | No | 10 | Max results to return |
| `strategy` | string | No | `tiered` | Search strategy: `tiered`, `vector_only`, `text_only` |

**Example**:

```json
{
  "query": "What was discussed about authentication?",
  "limit": 5,
  "strategy": "tiered"
}
```

**Response**:

```json
{
  "count": 2,
  "memories": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "content": "User mentioned OAuth2 integration needed",
      "sourceType": "session",
      "sourcePath": null,
      "timestamp": "2026-04-23T10:30:00Z"
    }
  ]
}
```

---

#### `add_memory`

Store a new memory entry.

**Arguments**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `content` | string | Yes | - | Memory content to store |
| `sourceType` | string | No | `manual` | Source type: `manual`, `file`, `conversation`, `web` |
| `sourcePath` | string | No | - | Source URL or file path |
| `metadata` | object | No | - | Additional metadata |

**Example**:

```json
{
  "content": "Remember that the user prefers TypeScript over JavaScript",
  "sourceType": "conversation",
  "sourcePath": "/session/123",
  "metadata": {
    "userId": "user-456",
    "importance": "high"
  }
}
```

**Response**:

```json
{
  "success": true,
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "message": "Memory added successfully"
}
```

**Note**: Duplicate content (same SHA-256 hash) is rejected with `duplicate: true`.

---

#### `search_project`

Search indexed project files.

**Arguments**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | Yes | - | Search query |
| `topK` | number | No | 20 | Max results |
| `fileTypes` | string[] | No | - | Filter by extensions (e.g., `["ts", "js"]`) |
| `paths` | string[] | No | - | Filter by directory paths |

**Example**:

```json
{
  "query": "authentication middleware",
  "topK": 10,
  "fileTypes": ["ts", "tsx"],
  "paths": ["src/api", "src/middleware"]
}
```

**Response**:

```json
{
  "count": 3,
  "chunks": [
    {
      "filePath": "src/middleware/auth.ts",
      "content": "export async function authMiddleware(req, res, next) { ... }",
      "lineStart": 15,
      "lineEnd": 42,
      "score": 0.89
    }
  ]
}
```

---

#### `index_project`

Trigger project indexing.

**Arguments**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | string | No | cwd | Directory to index |
| `force` | boolean | No | `false` | Force re-index all files |

**Example**:

```json
{
  "path": "/home/user/project",
  "force": true
}
```

**Response**:

```json
{
  "success": true,
  "message": "Indexing completed",
  "stats": {
    "totalFiles": 150,
    "indexedFiles": 148,
    "failedFiles": 2,
    "totalChunks": 1247,
    "lastIndexing": "2026-04-23T10:35:00Z"
  }
}
```

---

#### `get_file_contents`

Reconstruct file contents from indexed chunks.

**Arguments**:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `filePath` | string | Yes | - | Path to the file to reconstruct |
| `triggerIndex` | boolean | No | `false` | If true and file not found, trigger indexing |

**Example**:

```json
{
  "filePath": "src/server.ts",
  "triggerIndex": false
}
```

**Response**:

```json
{
  "success": true,
  "filePath": "src/server.ts",
  "content": "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n...",
  "chunks": [
    { "chunkIndex": 0, "lineStart": 1, "lineEnd": 25 },
    { "chunkIndex": 1, "lineStart": 26, "lineEnd": 50 }
  ],
  "lineCount": 850,
  "indexedAt": "2026-04-28T10:35:00Z",
  "truncated": false
}
```

**Notes**:
- Content is reconstructed by concatenating indexed chunks in order
- Max content size: 100KB (returns `truncated: true` if exceeded)
- Pauses/resumes indexer during read operations

---

### Configuration File Format

The `super-memory.json` configuration file:

```json
{
  "model": {
    "precision": "fp16",
    "device": "auto",
    "useGpu": false,
    "embeddingDim": 1024,
    "batchSize": 32
  },
  "database": {
    "qdrantUrl": "http://localhost:6333",
    "tableName": "memories"
  },
  "indexer": {
    "chunkSize": 512,
    "chunkOverlap": 50,
    "maxFileSize": 10485760,
    "excludePatterns": [
      "**/node_modules/**",
      "**/.git/**",
      "**/dist/**",
      "**/*.log",
      "**/.cache/**"
    ]
  },
  "logging": {
    "level": "info"
  }
}
```

### Memory Source Types

| Type | Description |
|------|-------------|
| `session` | Session-scoped memory (default) |
| `file` | Imported from a file |
| `web` | Scraped from web content |
| `boomerang` | Generated by Boomerang plugin |
| `project` | Indexed from project files |

---

## Performance

### Memory Usage

| Configuration | Model Memory | Total Memory | Notes |
|---------------|-------------|-------------|-------|
| 1 instance, BGE-Large fp16 | ~325MB | ~500MB | Default single-user |
| 3 instances, BGE-Large fp16 | ~975MB | ~1.2GB | Shared via singleton |
| 3 instances, BGE-Large fp32 | ~1.95GB | ~2.2GB | High accuracy |
| CPU fallback, MiniLM fp32 | ~80MB | ~200MB | CPU-only systems |

### Query Latency Targets

| Operation | Target | Notes |
|-----------|--------|-------|
| Semantic query (HNSW) | <10ms p50 | With warm cache |
| Embedding generation | <100ms | BGE-Large single text |
| Batch embedding | <50ms/text | Batch of 8 |
| Project search | <50ms | With indexed project |

### Benchmarks

**Test Environment**:
- CPU: AMD Ryzen 9 5950X
- RAM: 64GB DDR4
- GPU: NVIDIA RTX 3090 (24GB)

**Single Query Latency** (p50):

```
Strategy: TIERED
├── Embedding generation: 45ms
├── HNSW search (top 10): 3ms
└── Total: ~48ms
```

**Throughput**:

| Operation | Throughput |
|-----------|-----------|
| Memory add (with embedding) | ~20/sec |
| Memory query | ~100/sec |
| Project file indexing | ~100 files/min |

---

### Security

**Accepted Vulnerabilities** (with monitoring schedule):

| Package | Vulnerability | Status | Notes |
|---------|---------------|--------|-------|
| `uuid` | CVE-2024-21539 | Accepted | Monitoring for patch updates |
| `@modelcontextprotocol/sdk` | Moderate | Accepted | Used for MCP protocol; monitoring |
| `protobufjs` | Moderate | Accepted | Used for serialization; monitoring |

**Monitoring**: Run `npm audit` monthly to check for new vulnerabilities. Update packages when security patches become available without breaking changes.

---

## Architecture Decisions

### Why TypeScript?

- **Type Safety**: Catch errors at compile time
- **ESM Modules**: Native support in Node.js 20+
- **MCP SDK**: Official TypeScript SDK available
- **Bundle Size**: Lighter than Python runtime

### Search Strategy Selection

| Scenario | Recommended Strategy |
|----------|---------------------|
| Interactive chat, speed critical | `tiered` (Fast Reply) |
| Research, debugging, thorough recall | `parallel` (Archivist) |
| Exact keyword matching | `text_only` |
| Pure semantic similarity | `vector_only` |

### Singleton Model Manager

Prevents VRAM duplication when multiple components need embeddings:

```typescript
// Instead of creating new models
const extractor = await pipeline('feature-extraction', 'bge-large'); // Bad

// Use singleton
const manager = ModelManager.getInstance();
await manager.acquire();  // Loads once, shares across users
```

### Qdrant over Alternatives

| Database | Pros | Cons |
|----------|------|------|
| **Qdrant** | REST API, payload filtering, HNSW, open source | Requires separate process |
| LanceDB | Embedded, Arrow format | TypeScript support was immature |
| Chroma | Simple, local | Less mature |
| Pinecone | Managed, scalable | Requires API key |

### Hybrid Chunking

```typescript
// Semantic boundaries detected:
function handleAuth() { ... }    // Split here
class UserService { ... }        // And here
const config = { ... };          // Continue until max size

// Fallback: sliding window for ambiguous content
```

---

## Development

### Project Structure

```
Super-Memory-TS/
├── src/
│   ├── index.ts              # Entry point
│   ├── server.ts             # MCP server implementation
│   ├── config.ts             # Configuration management
│   ├── model/
│   │   ├── index.ts          # ModelManager singleton
│   │   ├── embeddings.ts     # Embedding generation
│   │   └── types.ts          # Model type definitions
│   ├── memory/
│   │   ├── index.ts          # MemorySystem facade
│   │   ├── database.ts       # Qdrant operations
│   │   ├── schema.ts         # Memory schema
│   │   └── search.ts         # Search strategies
│   ├── project-index/
│   │   ├── indexer.ts        # ProjectIndexer class
│   │   ├── chunker.ts        # FileChunker (semantic/sliding)
│   │   ├── watcher.ts        # FileWatcher (chokidar)
│   │   └── types.ts          # Indexer types
│   └── utils/
│       ├── logger.ts         # Logging utility
│       ├── hash.ts           # SHA-256 hashing
│       └── errors.ts         # Custom error types
├── tests/
│   ├── server.test.ts        # Server unit tests
│   ├── index.test.ts         # Integration tests
│   ├── project-index.test.ts # Indexer tests
│   └── test-project/         # Sample project for testing
├── package.json
├── tsconfig.json
└── README.md
```

### Building from Source

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Build
npm run build

# Output in dist/
```

### Running Tests

```bash
# Run all tests (requires bun)
npm test

# Run with coverage
bun test --coverage

# Run specific test file
bun test tests/server.test.ts
```

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make changes with tests
4. Run linting: `npm run lint`
5. Commit with conventional messages
6. Push and create PR

### Error Handling

All errors extend `MemoryError`:

```typescript
// Throwing errors
throw new MemoryError('Query failed', 'QUERY_FAILED');

// Error codes
VALIDATION_ERROR  // Invalid input
QUERY_FAILED      // Search failed
ADD_FAILED        // Memory add failed
INDEX_NOT_INITIALIZED  // Indexer not ready
INTERNAL_ERROR    // Unexpected errors
```

---

## License

MIT License - see project repository for details.

---

## Related Documentation

- [MCP SDK Documentation](https://modelcontextprotocol.io/)
- [Qdrant Documentation](https://qdrant.tech/documentation/)
- [@xenova/transformers](https://huggingface.co/docs/xenova/transformers)
- [BGE-Large Model Card](https://huggingface.co/BAAI/bge-large-en-v1.5)
