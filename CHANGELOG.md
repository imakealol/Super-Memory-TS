# Changelog

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