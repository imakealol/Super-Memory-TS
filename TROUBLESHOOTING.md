# Troubleshooting

## Item 14: prebuild-install@7.1.3 Deprecation Warning

### What the Warning Is

During `npm install`, you may see:
```
npm warn deprecated prebuild-install@7.1.3: prebuild-install is deprecated.
```

### Why It Exists (Dependency Chain)

The deprecation warning comes from **one dependency chain** in boomerang-v2:

#### boomerang-v2
```
@veedubin/boomerang-v2
└── @xenova/transformers@2.0.1
    └── sharp@0.32.6
        └── prebuild-install@7.1.3
```

**Super-Memory-TS** no longer uses `better-sqlite3` — it uses Node.js built-in `node:sqlite` module since v2.4.2.

### Why It's Safe to Ignore

1. **Builds work fine** - The packages function correctly despite the deprecation warning
2. **prebuild-install is unmaintained** - See [prebuild/prebuild-install#287](https://github.com/prebuild/prebuild-install/issues/287)
3. **No security fix coming** - The maintainer has archived the project
4. **Runtime behavior unchanged** - The deprecation only affects the install-time build of native modules

### The sharp Override (boomerang-v2 only)

In `Super-Memory-TS/package.json`, a partial fix was applied to force `sharp@0.33+` which removed the `prebuild-install` dependency. However, this doesn't fully eliminate the warning because `better-sqlite3` (which was used in older versions) also pulled in `prebuild-install`. Super-Memory-TS now uses `node:sqlite` and no longer needs this override.

### Future Migration: @xenova/transformers → @huggingface/transformers

#### Current State
| Package | Version | sharp Requirement |
|---------|---------|-------------------|
| `@xenova/transformers` | 2.17.2 (latest) | `sharp@0.32.x` |

#### Migration Target
| Package | Version | sharp Requirement |
|---------|---------|-------------------|
| `@huggingface/transformers` | 4.2.0 (latest) | `sharp@^0.34.5` |

The official successor to `@xenova/transformers` is `@huggingface/transformers` (v3+). It was renamed when the project moved under the Hugging Face organization.

#### Migration Steps

1. **Update dependency**:
   ```json
   "@huggingface/transformers": "^4.2.0"
   ```

2. **Update imports** (minimal if any):
   ```typescript
   // Before
   import { pipeline } from '@xenova/transformers';
   
   // After (same API)
   import { pipeline } from '@huggingface/transformers';
   ```

3. **Remove sharp override** from `package.json` (no longer needed)

4. **Test thoroughly**:
   ```bash
   npm run build && npm run typecheck && npm run test
   ```

#### Migration Feasibility: **Viable with testing**

- API is designed to be backward-compatible
- Import paths remain the same
- Models are cached in the same location
- v4.x includes WebGPU support (bonus)

#### Risks
- Test thoroughly in your target environment (Node 20+)
- Some edge case API differences may exist (check release notes)

### Status Summary

| Project | Warning Source | Status |
|---------|---------------|--------|
| Super-Memory-TS | node:sqlite (built-in) | ✅ Fixed (node:sqlite has no prebuild-install) |
| boomerang-v2 | @xenova/transformers → sharp@0.32 | **Fix: Migrate to @huggingface/transformers@4.x** |
