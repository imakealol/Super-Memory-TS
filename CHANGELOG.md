# Changelog

## [2.6.1] - 2026-05-06

### Added
- **GPU/CPU Auto-Fallback**: `ModelManager` now tries BGE-Large (GPU/1024-dim) first, automatically falling back to MiniLM (CPU/384-dim) if GPU is unavailable
- **Dynamic Dimension-Aware Collections**: Collections are automatically suffixed with dimension (`memories_384` or `memories_1024`) based on the active model
- **Query Cascading**: When querying, if the primary collection is empty or missing, automatically searches the fallback collection (opposite dimension)
- **Mixed-Dimension Text Fallback**: For multi-collection queries, dimension-mismatched collections use Qdrant scroll + Fuse.js text search instead of being skipped entirely
- **`scrollCollection()`**: New database method for paginated Qdrant scroll with project isolation
- **`textSearchCollection()`**: New search method that builds temporary Fuse.js index from scrolled data
- **`COLLECTION_NAME` env var**: Override base collection name at runtime

### Changed
- `validateModelDimensions()` now logs a warning instead of throwing an error, allowing the server to start with mismatched collections
- `getDimensions()` predicts actual model dimensions even before the model is loaded
- `loadModelWithFallback()` replaces direct model loading with intelligent GPU→CPU fallback
- Integration tests updated to use `COLLECTION_NAME` env var and dimension-suffixed collections

### Fixed
- **Linter errors** in `bin/super-memory-ts.cjs`: removed unused `os` import, added `process` global declaration
- **NPM postinstall script**: `scripts/postinstall.js` now properly included in published package

## [2.6.0] - 2026-05-05

### Added
- **Multi-collection search with RRF**: Search across multiple Qdrant collections using `QUERY_COLLECTIONS` env var. Results merged via Reciprocal Rank Fusion (k=60) for unified ranking across collections with different embedding dimensions.
- **Dimension validation**: Automatically skips collections with mismatched embedding dimensions during search, logging a warning.
- **Graceful degradation**: Failed collections (not found, wrong dimensions, network errors) are logged and skipped rather than crashing the query.
- **10 comprehensive tests** for multi-collection RRF search, deduplication, failure handling, and backward compatibility.

### Changed
- `MemorySystem.queryMemories()` now routes to multi-collection path when `queryCollections.length > 1`.
- `MemoryDatabase.queryMemories()` accepts optional `collectionName` parameter.
- `MemorySearch.vectorOnlySearch()` accepts optional `collectionName` parameter.
- `getMemorySystem()` accepts `queryCollections` in config.
- `SuperMemoryServer` passes `queryCollections` from config to `getMemorySystem()`.

### How to Use
```bash
export QUERY_COLLECTIONS="memories_bge_fp16,memories"
```
- `COLLECTION_NAME` (or default `memories`) controls **writes**.
- `QUERY_COLLECTIONS` controls **reads** (searches all listed collections).
- If `QUERY_COLLECTIONS` is not set, falls back to single collection (backward compatible).

## [2.5.1] - 2026-05-04

### Fixed
- **TIERED search bug**: Removed unused `QdrantMemoryResult` interface; `_similarity` field never populated by Qdrant — now correctly uses `score`
- **Debug logs in production**: Removed 11 `console.error('[DEBUG]...')` statements from `src/memory/index.ts`, `src/memory/database.ts`, and `src/server.ts`
- **Hardcoded version**: `src/server.ts` now reads version dynamically from `package.json` instead of hardcoded `'2.1.0'`
- **Snapshot ENOENT errors**: `SnapshotIndex.save()` now creates parent directory with `fs.mkdir(..., { recursive: true })` before writing temp file
- **Test cross-contamination**: Each project-index test now uses an isolated file tracker database instead of a shared global one
- **Integration test dimension mismatch**: Tests now use `ModelManager.getDimensions()` and unique test collection names with proper cleanup
- **Test imports**: Changed `../dist/` to `../src/` in `tests/project-index.test.ts` for actual source coverage

### Added
- **PARALLEL search strategy**: Implemented RRF (Reciprocal Rank Fusion) with `k=60` constant. Runs vector and text searches in parallel, fuses rankings for maximum recall. Added 10 comprehensive tests.
- **Model metadata refresh**: `database.ts` now refreshes stored model metadata when initializing an existing collection

## [2.5.0] - 2026-05-01

### Changed
- **Replaced `glob` with `node:fs/promises.glob`** — Node 22+ built-in, removes ~20KB dependency
- **Centralized ignore patterns** — New `src/project-index/constants.ts`
- **Node 22+ engine requirement** already enforced (was >=22.5.0)

### Fixed
- Fixed always-false condition in `indexer.ts` gitignore pattern parsing

### Removed
- `glob` dependency
- `@types/bun` devDependency
- Various unused exports from hash.ts, embeddings.ts, memory/search.ts

## [2.4.3] - 2026-05-01

### Fixed
- **Critical crash loop fix**: `query_memories` tool handler now properly catches exceptions when the memory system is not ready, preventing unhandled promise rejections that caused `process.exit(1)` and rapid MCP server restarts

### Changed
- **Project indexer filtering overhaul**: Replaced deny-list with allowlist-based file filtering (`ALLOWED_EXTENSIONS`) to prevent scanning irrelevant directories (`.venv`, `node_modules`, `.tox`, etc.)
- Added `.gitignore` pattern support to snapshot and watcher for better exclusion behavior

## [2.4.2] - 2026-05-01

### Changed
- **Replaced `better-sqlite3` with `node:sqlite`**: Switched from third-party `better-sqlite3` package to Node.js built-in `node:sqlite` module (available since Node 22.5.0)
- Eliminates `prebuild-install@7.1.3` deprecation warning
- Eliminates native dependency compilation during `npm install`
- Updated Node.js engine requirement from `>=20.0.0` to `>=22.5.0`
- Updated `tsconfig.json` `moduleResolution` from `bundler` to `NodeNext` for built-in module type support

## [2.4.1] - 2026-05-01

### Fixed
- **Critical transport bug**: Removed `.on()` calls on `StdioServerTransport` which was throwing `TypeError: transportWithHandlers.on is not a function` and preventing MCP transport from connecting. This was the root cause of the 3000ms timeout — the server could never announce itself to the MCP client.

## [2.4.0] - 2026-05-01

### Changed
- **Lazy model loading by default**: Model now loads on first embedding request instead of at startup for faster npx/mCP client startup
- `SUPER_MEMORY_EAGER_LOAD=1` environment variable enables opt-in eager loading

### Added
- **Postinstall script** (`scripts/postinstall.js`): Pre-downloads the BGE-Large embedding model (~650MB) during `npm install` so subsequent startups are faster
- Model pre-download uses CPU by default to avoid GPU driver requirements during installation
- CI skip logic: Set `SUPER_MEMORY_POSTINSTALL=1` to force model download in CI environments

### Fixed
- **npx timeout issue**: Deferred model loading prevents MCP client timeout when using `npx -y @veedubin/super-memory-ts`

### Technical Details
- `src/server.ts`: Model loading now conditional on `SUPER_MEMORY_EAGER_LOAD` env var
- `scripts/postinstall.js`: New file that runs during `npm install` to pre-cache the model
- `src/config.ts`: Added `SUPER_MEMORY_EAGER_LOAD` to `ENV_VARS` constant
- `package.json`: Added `postinstall` script, bumped to v2.4.0, included `scripts/` in `files` array

## [2.3.6] - 2026-04-29

### Fixed
- Added prominent Requirements section with Qdrant setup instructions
- Qdrant is now clearly documented as a hard dependency with Docker one-liner

## [2.3.5] - 2026-04-29

### Fixed
- README test commands now correctly reference `vitest` instead of `bun test`
- Removed false "Python 3.10+" prerequisite (@xenova/transformers is pure JS/Node)
- Removed duplicated ASCII art diagram in Architecture section

### Added
- Companion package section linking to @veedubin/boomerang-v2
- NPM_README.md now also references companion package

## [2.3.4] - 2026-04-28

### Fixed
- Fixed stale LanceDB comments in codebase
- Updated version badge in documentation
- Created NPM_README.md for package landing page

### Changed
- Cleaned junk files and updated .gitignore
- Added Qdrant client cache cleanup on reconnection

## [2.3.3] - 2026-04-28

### Fixed
- Qdrant client connection stability issues
- Reduced timeout from 120s to 60s to fail faster on connection problems
- Added checkCompatibility: false to prevent version check hangs
- Added connection health validation with automatic client recreation
- Stale connections now detected and recreated instead of persisting

## [2.3.1] - 2026-04-27

### Fixed
- **MCP timeout on large projects**: `index_project` now runs in background mode by default to prevent MCP timeout errors
- Fixed async background indexing in `ProjectIndexer` to properly handle large directory indexing

### Added
- **index_project_status tool**: New MCP tool for polling indexing progress
- **Progress tracking callbacks**: Added callback support to indexer for tracking indexing progress

### Changed
- **index_project default**: Now defaults to `background=true` to prevent MCP timeout

## [2.3.0] - 2026-04-27

### Added
- Project isolation verification and end-to-end tests
- Custom path indexing support in `index_project` MCP tool
- Memory migration script (`scripts/migrate-memories.ts`) for tagging untagged memories
- Performance benchmark script (`scripts/benchmark.ts`)
- Comprehensive search strategy tests (44 tests covering TIERED, VECTOR_ONLY, TEXT_ONLY, PARALLEL)
- Edge case tests (36 tests for error handling and boundary conditions)
- Migration tests (19 tests)
- GitHub Actions CI workflow at root level
- SECURITY.md documenting vulnerability risk register
- TROUBLESHOOTING.md with deprecation notes and migration guide

### Fixed
- All ESLint errors and warnings (added proper TypeScript interfaces)
- npm audit vulnerabilities (uuid updated to 14.0.0, zero fixable vulnerabilities remaining)
- Agent permission configuration for /tmp and common operations
- boomerang-tester skill model reference (Gemini 3 Pro → MiniMax M2.7)

### Changed
- Updated AGENTS.md and README.md with v2.2.2/v2.3.0 architecture documentation
- Enhanced documentation for tiered memory architecture and search strategies

### Security
- Fixed uuid <14.0.0 moderate vulnerability (GHSA-w5hq-g745-h8pq)
- Documented accepted risks for @modelcontextprotocol/sdk and protobufjs upstream vulnerabilities

## [2.2.2] - 2026-04-27

### Fixed
- `index_project` MCP tool now correctly respects the `path` parameter
- Pre-existing lint error in `database.ts:189` unused variable

### Changed
- Added `sharp@0.33.0` override to reduce `prebuild-install` deprecation warnings

## [2.2.1] - 2026-04-27

### Fixed
- **MemorySystem projectId fix**: Fixed `projectId` being lost on re-initialization in `src/memory/index.ts`
- **Qdrant filter fix**: Fixed malformed Qdrant filters in `contentExists`, `queryMemories`, and `listMemories` in `src/memory/database.ts`

## [2.1.4] - 2026-04-25

### Fixed
- **Empty Float32Array bug**: Changed truthiness check to length check (`embedding.length === 0`) to catch empty arrays
- **Timeout increase**: Raised request timeout from 60s to 180s for slow model loading
- **Preload embedding model**: Model now loads at startup instead of lazy-loading on first request
- **QdrantClient timeout & retry**: Added 10s timeout and exponential backoff retry logic
- **Content null fix**: Fixed stored memories having `content` field set to `null`

### Technical Details
- `src/index.ts`: Empty array detection and timeout changes
- `src/model/index.ts`: Startup preloading of embedding model
- `src/memory/database.ts`: QdrantClient configuration with retry logic
- `src/memory/schema.ts`: Content field handling fix

## [1.0.11] - 2026-04-24

### Fixed
- **Connection closed errors**: Increased timeout for uncaught exceptions/unhandled rejections from 100ms to 5000ms to allow in-flight requests to complete
- **Request timeout handling**: Added 60-second timeout per request to prevent hanging requests from blocking shutdown
- **Graceful shutdown**: Server now properly drains in-flight requests before exiting

### Technical Details
- `src/index.ts`: Timeouts increased from 100ms to 5000ms for graceful error handling
- `src/server.ts`: Added `Promise.race()` with 60-second timeout for each tool handler

## [1.0.0] - 2026-04-23

### 🎉 First Stable Release

This is the first stable release of Super-Memory-TS with built-in Boomerang integration.

### Major Features
- Built-in semantic memory for Boomerang (no external dependencies)
- Automatic project indexing on Boomerang plugin load
- Background file watching with incremental updates
- Dual architecture: MCP server mode AND built-in module mode

### Migration
See Boomerang's [docs/MIGRATION-v0.5-to-v1.0.md](../../boomerang/docs/MIGRATION-v0.5-to-v1.0.md)

---

## [0.6.0] - 2026-04-23

### Added
- **Built-in integration support**: Core modules now importable directly into Boomerang
- **Automatic indexing**: Project indexing starts automatically on Boomerang plugin load
- **Background file watching**: Chokidar-based continuous monitoring for incremental updates
- **Dual architecture documentation**: Clarified MCP server vs built-in use cases

### Changed
- **Version alignment**: v0.6.0 to match Boomerang v0.6.0 for tandem development
- **Documentation**: Architecture section now explains both deployment modes

### Technical Details
- Core modules (`src/model/`, `src/memory/`, `src/project-index/`) exported for direct import
- No MCP protocol overhead when used as built-in module
- Automatic startup triggers project indexing on plugin initialization

## [0.2.0] - 2026-04-23

### Fixed
- **Watcher fixes**: Resolved critical issues with file watching functionality
- **Dimension handling**: Fixed embedding dimension mismatches
- **Chunking logic**: Corrected text chunking implementation

### Improved
- Test suite: 57/58 tests passing
- Previously broken features now working
- Overall stability improvements

## [0.1.0] - Initial Release

- Initial implementation of Super-Memory MCP server
- Local embeddings and vector search via LanceDB
- File watching with chokidar
- Fuse.js hybrid search capability