# Troubleshooting

## Item 14: prebuild-install@7.1.3 Deprecation Warning

### What the Warning Is

During `npm install`, you may see:
```
npm warn deprecated prebuild-install@7.1.3: prebuild-install is deprecated.
```

### Why It Exists (Dependency Chain)

The deprecation warning comes from **two separate dependency chains**:

#### Super-Memory-TS
```
@veedubin/super-memory-ts
└── better-sqlite3@11.x
    └── prebuild-install@7.1.3
```

#### boomerang-v2
```
@veedubin/boomerang-v2
└── @xenova/transformers@2.0.1
    └── sharp@0.32.6
        └── prebuild-install@7.1.3
```

### Why It's Safe to Ignore

1. **Builds work fine** - The packages function correctly despite the deprecation warning
2. **prebuild-install is unmaintained** - See [prebuild/prebuild-install#287](https://github.com/prebuild/prebuild-install/issues/287)
3. **No security fix coming** - The maintainer has archived the project
4. **Runtime behavior unchanged** - The deprecation only affects the install-time build of native modules

### The sharp Override (Super-Memory-TS only)

A partial fix was applied in `Super-Memory-TS/package.json`:

```json
{
  "//": "KNOWN ISSUE: prebuild-install@7.1.3 deprecation warning from better-sqlite3@11.x and sharp@0.32.x. Cannot be resolved without breaking changes. sharp@0.33+ removed prebuild-install but @xenova/transformers@2.17.x requires sharp@0.32.x. See: https://github.com/prebuild/prebuild-install/issues/287",
  "overrides": {
    "sharp": "^0.33.0"
  }
}
```

This override forces `sharp@0.33+` which removed the `prebuild-install` dependency. However, it doesn't fully eliminate the warning because `better-sqlite3` also pulls in `prebuild-install`.

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
| Super-Memory-TS | better-sqlite3 | Cannot fix without better-sqlite3 update |
| boomerang-v2 | @xenova/transformers → sharp@0.32 | **Fix: Migrate to @huggingface/transformers@4.x** |
