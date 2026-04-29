# Changelog

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