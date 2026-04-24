# AGENTS.md - Super-Memory-TS

**Role**: NPM-publishable MCP server with local embeddings and vector search  
**Package**: `@veedubin/super-memory-ts`  
**Repository**: https://github.com/Veedubin/Super-Memory-TS  
**License**: MIT

---

## Why This Exists

This project was previously an unpublished local directory with no Git repository. To publish to NPM, we created the GitHub repo, initialized git, and set up automated publishing via GitHub Actions.

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

## Review Notes

- **2025-04-23**: GitHub repo created, git initialized, workflow added
- **Build**: `tsc` compiles successfully
- **Quality**: All checks (typecheck, build) passing
- **Blocker resolved**: Was previously a local directory without any git repository

---

## Next Steps for Publishing

1. Ensure `NPM_PUBLISH_TOKEN` secret exists in https://github.com/Veedubin/Super-Memory-TS/settings/secrets/actions
2. Push a tag: `git tag v1.0.0 && git push origin v1.0.0`
3. Verify package appears at https://www.npmjs.com/package/@veedubin/super-memory-ts
