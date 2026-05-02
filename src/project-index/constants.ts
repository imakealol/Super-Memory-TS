/**
 * Project indexing constants
 * Centralized configuration for file indexing and watching.
 */

// Patterns that are always excluded across all indexing operations
export const ALWAYS_EXCLUDED_PATTERNS = [
  // Existing patterns
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/.cache/**',
  '**/coverage/**',
  '**/*.log',
  '**/.DS_Store',
  '**/.bash_history',
  '**/.Xauthority',
  '**/.ICEauthority',
  '**/.viminfo',
  // Socket files
  '**/.socket',
  '**/*.sock',
  // Skip files starting with . and common system files
  '**/.*',
  // Python virtual environments and tooling
  '**/.venv/**',
  '**/venv/**',
  '**/.tox/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.nox/**',
  '**/.hypothesis/**',
  '**/.eggs/**',
  '**/.egg-info/**',
  '**/site-packages/**',
  '**/vendor/**',
  '**/bower_components/**',
  // JS/TS frameworks and build outputs
  '**/.next/**',
  '**/.nuxt/**',
  '**/out/**',
  '**/.svelte-kit/**',
  '**/.parcel-cache/**',
  // Rust build outputs
  '**/target/**',
  // Java/Android/IDE
  '**/.gradle/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.vs/**',
  '**/bin/**',
  '**/obj/**',
  // Python compiled/generated
  '**/__pycache__/**',
  '**/*.pyc',
  '**/*.pyo',
  '**/*.pyd',
  // Other compiled binaries
  '**/*.so',
  '**/*.dll',
  '**/*.dylib',
  '**/*.class',
  '**/*.o',
  '**/*.a',
];