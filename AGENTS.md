# AGENTS.md - Super-Memory-TS

**Role**: NPM-publishable MCP server with local embeddings and vector search  
**Package**: `@veedubin/super-memory-ts`  
**Repository**: https://github.com/Veedubin/Super-Memory-TS  
**License**: MIT  
**Current Version**: v2.2.2

---

## Why This Exists

This project provides a local-first semantic memory system with project isolation, tiered search strategies, and MCP protocol integration for AI assistants like Boomerang.

---

## Architecture (v2.2.2)

| Component | Technology | Notes |
|-----------|------------|-------|
| **Database** | Qdrant (v1.7+) | HNSW indexing, payload filtering |
| **Embeddings** | BGE-Large (1024-dim, GPU) / MiniLM-L6-v2 (384-dim, CPU) | fp16 precision by default |
| **Protocol** | MCP (Model Context Protocol) | stdio/HTTP modes |
| **Integration** | Built-in for Boomerang v2 | Zero-overhead direct imports |

### Key Features

- **Project Isolation**: Payload-based filtering via `BOOMERANG_PROJECT_ID`
- **Custom Path Indexing**: `index_project` tool accepts custom `path` parameter
- **Tiered Search**:
  - `tiered` (default): Fast Reply - MiniLM + BGE fallback
  - `parallel`: Archivist - Dual-tier RRF fusion for maximum recall

---

## Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `npm run prepublishOnly` | Runs `npm run build` before publish |
| `npm run dev` | Watch mode with `tsx` |
| `npm run test` | Run tests with `bun test` |
| `npm run lint` | ESLint on `src/` |

---

## Publishing

### Trigger
Pushing a semver tag triggers `.github/workflows/npm-publish.yml`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

### Workflow Details
- **Trigger**: `push` on tags matching `v*.*.*`
- **Node version**: 22
- **Scope**: `@veedubin`
- **Provenance**: Enabled (`id-token: write`)
- **Secret required**: `NPM_PUBLISH_TOKEN`

### Pre-Publish Checklist
1. `NPM_PUBLISH_TOKEN` secret is set in GitHub repo settings
2. `package.json` version bumped appropriately
3. `npm run typecheck` passes
4. `npm run build` succeeds and `dist/` is generated
5. Tag pushed in `vX.Y.Z` format

---

## Project Structure

```
Super-Memory-TS/
├── src/               # TypeScript source
├── dist/              # Compiled output (published)
├── tests/             # Test suite
├── .github/
│   └── workflows/
│       └── npm-publish.yml   # Publish on v*.*.* tags
├── package.json       # Scoped package, prepublishOnly hook
├── tsconfig.json
└── README.md
```

---

## Key Configurations

- **Package scope**: `@veedubin`
- **Files published**: `dist/`, `package.json`, `README.md`, `LICENSE`
- **Entry**: `dist/index.js` / `dist/index.d.ts`
- **Type**: ESM (`"type": "module"`)
- **Engines**: Node >= 20

---

## Database Backend

**v2.0.0+**: Qdrant (`@qdrant/js-client-rest`) with payload-based project isolation.

### Running Qdrant

```bash
docker run -p 6333:6333 -v $(pwd)/qdrant_storage:/qdrant/storage qdrant/qdrant
```

### Configuration

```bash
export QDRANT_URL=http://localhost:6333  # default
export BOOMERANG_PROJECT_ID=my-project   # optional, for project isolation
```

### MCP Server Config for Boomerang

```json
{
  "super-memory-ts": {
    "type": "local",
    "command": ["npx", "-y", "@veedubin/super-memory-ts"],
    "environment": {
      "QDRANT_URL": "http://localhost:6333",
      "BOOMERANG_PROJECT_ID": "my-project"
    },
    "enabled": true
  }
}
```

---

## Review Notes

| Version | Date | Changes |
|---------|------|---------|
| **v2.2.2** | 2026-04-27 | Custom path indexing via `index_project` tool, tiered search documentation |
| **v2.2.1** | 2026-04-26 | MCP connection fix, Qdrant filter bug fix |
| **v2.2.0** | 2026-04-25 | Per-project memory isolation via `BOOMERANG_PROJECT_ID` |
| **v2.0.0** | 2025-04-24 | Migrated from LanceDB to Qdrant |

### Migration Notes

- **v2.0.0**: `uri` parameter replaced with Qdrant URL (e.g., `http://localhost:6333`)
- **v2.0.0**: Global write queues removed (Qdrant handles concurrency natively)
