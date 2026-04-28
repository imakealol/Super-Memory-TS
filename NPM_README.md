# Super-Memory-TS

[![npm version](https://img.shields.io/npm/v/@veedubin/super-memory-ts)](https://www.npmjs.com/package/@veedubin/super-memory-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Local-first semantic memory server with project indexing for AI assistants.** Store, search, and retrieve memories using natural language queries with high-performance vector search.

## Installation

```bash
npm install -g @veedubin/super-memory-ts
```

**Requirements**:
- Node.js ≥20.0.0
- [Qdrant](https://qdrant.tech/) running on `http://localhost:6333` (or set `QDRANT_URL`)

### Start Qdrant (if needed)

```bash
docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

## Quick Start

```bash
# 1. Set environment (optional)
export QDRANT_URL=http://localhost:6333
export BOOMERANG_PROJECT_ID=my-project

# 2. Start the server
npx @veedubin/super-memory-ts

# 3. Use with Boomerang or any MCP-compatible AI assistant
```

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `BOOMERANG_PROJECT_ID` | - | Project ID for memory isolation |
| `BOOMERANG_PRECISION` | `fp32` | Model precision: `fp32`, `fp16`, `q8`, `q4` |
| `BOOMERANG_DEVICE` | `auto` | Device: `auto`, `gpu`, `cpu` |
| `BOOMERANG_SEARCH_STRATEGY` | `tiered` | Search: `tiered`, `parallel`, `vector_only`, `text_only` |

## Basic Usage

### MCP Tools

```typescript
// Query memories
{
  "query": "What was discussed about authentication?",
  "limit": 5
}

// Add a memory
{
  "content": "User prefers TypeScript over JavaScript",
  "sourceType": "conversation"
}

// Search project files
{
  "query": "authentication middleware",
  "fileTypes": ["ts", "tsx"]
}

// Index a project
{
  "path": "/path/to/project",
  "force": true
}
```

### Programmatic Usage

```typescript
import { SuperMemoryServer } from '@veedubin/super-memory-ts';

const server = new SuperMemoryServer();
await server.start();

// Server provides MCP tools:
// - query_memories: Semantic search over memories
// - add_memory: Store new memories
// - search_project: Search indexed project files
// - index_project: Trigger project indexing
// - get_file_contents: Reconstruct files from index
```

## Features

| Feature | Description |
|---------|-------------|
| **Semantic Search** | Natural language memory queries using embeddings |
| **Project Indexing** | Automatic indexing of project code with semantic chunking |
| **Project Isolation** | Memory isolation via `BOOMERANG_PROJECT_ID` |
| **Tiered Search** | Fast Reply (`tiered`) or Archivist (`parallel`) modes |
| **HNSW Vector Search** | Sub-10ms query latency |
| **FP16 Support** | Reduce memory usage by 50% with floating-point precision |

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  SuperMemoryServer               │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │MCP Tools │  │ Memory   │  │ ProjectIndexer │ │
│  │          │  │ System   │  │                │ │
│  │query_    │  │  ┌─────┐ │  │FileWatcher    │ │
│  │memories  │──│  │Qdrant│ │  │FileChunker    │ │
│  │          │  │  └─────┘ │  │                │ │
│  └──────────┘  └──────────┘  └────────────────┘ │
└──────────────────────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────┐
│              ModelManager (Singleton)            │
│  ┌─────────────────┐    ┌─────────────────────┐ │
│  │  BGE-Large      │    │  MiniLM-L6-v2       │ │
│  │  (1024-dim)     │    │  (384-dim)         │ │
│  └─────────────────┘    └─────────────────────┘ │
└──────────────────────────────────────────────────┘
```

## Documentation

📖 **[Full documentation on GitHub](https://github.com/Veedubin/Super-Memory-TS)**

Includes:
- Detailed API reference
- Architecture deep-dive
- Development setup
- Performance benchmarks
- Contributing guide

## License

MIT License
