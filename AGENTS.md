# Flint — Agent Guide

Obsidian plugin that syncs vaults to Firebase Storage using Automerge CRDTs for conflict-free merging.

All source lives under `flint/`. Run every command from that directory.

---

## Common Commands

```bash
npm run build       # type-check (tsc) + esbuild production bundle → dist/main.js
npm run dev         # esbuild watch mode (no type-check)
npm run deploy      # build + copy dist/main.js, manifest.json, styles.css to Obsidian vault
npm test            # vitest run (all tests, single pass)
npm run test:watch  # vitest watch mode
```

Deploy requires `OBSIDIAN_PLUGIN_DIR` set in `flint/.env` (see `flint/.env.example`).

---

## Project Structure

```
flint/
├── main.ts              # Plugin entry point — ribbon/command wiring, onload/onunload
├── datatools.ts         # Core sync logic (FlintDataTransfer class)
├── crdt.ts              # Automerge wrapper (createDoc, loadDoc, saveDoc, updateDoc, mergeDocs, injectFlintId, extractFlintId)
├── firebase-tools.ts    # Firebase init — exports: storage, vaultRef, auth
├── flint-settings.ts    # Settings interface, defaults, UI tab; also exports FileSyncState, SyncState
├── esbuild.config.mjs   # Build config — .wasm files inlined as base64 dataurl
├── deploy.mjs           # Deploy script — reads OBSIDIAN_PLUGIN_DIR from .env
├── vitest.config.ts     # Test config — module aliases for obsidian, firebase-tools, crdt, etc.
├── __mocks__/
│   └── obsidian.ts      # Stub for the obsidian package (unavailable in Node)
├── __tests__/
│   └── sync-dispatch.test.ts  # Dispatch table unit tests (7 cases)
└── dist/                # Build output (gitignored) — main.js goes here
```

---

## Sync Architecture

**Entry point:** `FlintDataTransfer.syncAll(vault, settings)` in `datatools.ts`.

**Per-sync flow:**
1. `listAll` — one Firebase request, collects all remote paths into sets (`remoteAmSet`, `remoteMdSet`)
2. Download `flint-manifest.json` — maps `relPath → sha256(amBytes)` for change detection
3. Load local sync state from plugin data (`loadSyncState`)
4. Iterate union of local + remote paths → `processFile()` per file
5. Upload updated manifest
6. Persist updated sync state

**Dispatch table in `processFile()`:**

| Local exists | Remote exists | Local hash changed | Remote hash changed | Action            |
|:---:|:---:|:---:|:---:|---|
| ✓ | ✗ | — | — | `syncNewLocal` — upload .md + .am, write local .am |
| ✗ | ✓ | — | — | `syncNewRemote` — download .md + .am, write locally |
| ✓ | ✓ | ✗ | ✗ | skip |
| ✓ | ✓ | ✓ | ✗ | `syncLocalChanged` — update local doc, upload |
| ✓ | ✓ | ✗ | ✓ | `syncRemoteChanged` — fetch remote .am, apply locally |
| ✓ | ✓ | ✓ | ✓ | `syncBothChanged` — CRDT merge, upload merged result |

**Change detection:**
- Local change: `sha256(content) !== state.localHash`
- Remote change: `manifest[relPath] !== state.remoteAmHash`
- No state (first sync with existing file on both sides) → treated as both changed

**Local .am storage:** `.obsidian/plugins/flint/am/<relPath>.am` via `vault.adapter.readBinary/writeBinary`.

**Sync state** persisted in plugin data (separate from settings): `Record<relPath, { flintId, localHash, remoteAmHash }>`.

---

## Firebase Storage Layout

```
vaults/
  <vault-name>/
    path/to/note.md        ← markdown with _flint_id frontmatter
    path/to/note.md.am     ← Automerge binary (CRDT state)
    flint-manifest.json    ← relPath → sha256(amBytes) map
```

`vaultRef` in `firebase-tools.ts` already points to `gs://bucket/vaults/`, so paths passed to `sRef()` are always `<vault-name>/...` without a `vaults/` prefix.

---

## Key Conventions

- **No `vaults/` prefix in `sRef()` calls** — `vaultRef` already resolves to that level. Adding it creates double paths.
- **`_flint_id` frontmatter** — injected by `injectFlintId(content, uuid)` from `crdt.ts`. Obsidian hides frontmatter in reading mode. Do not remove or rename this field.
- **WASM initialization** — `initAutomerge()` from `crdt.ts` must be `await`ed before any Automerge calls. It's called at the top of `onload()` in `main.ts`.
- **TypeScript subpath imports** — `@automerge/automerge/slim` uses `// @ts-ignore` because `moduleResolution: node` doesn't understand package exports. esbuild resolves them correctly at bundle time.
- **Tests use `vi.spyOn` on private methods** — cast to `any` to access: `(dt as any).processFile(...)`.

---

## Dependencies

| Package | Purpose |
|---|---|
| `firebase ^11` | Storage, Auth |
| `@automerge/automerge ^2.0.0` | CRDT text merging; WASM bundled inline |
| `obsidian` (devDep) | Type definitions only — excluded from bundle |
| `vitest ^1.6.1` | Test runner (v1 required for Node 18 compatibility) |
