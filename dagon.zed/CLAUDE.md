# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

The Zed extension for "Dagon" — navigating and authoring Go DAG (directed acyclic graph) pipelines, following the same fixed file layout per pipeline prefix described in the repo root `CLAUDE.md` (`<prefix>_dag.go`, `pipeline/<prefix>_pipeline.go`, `task/<prefix>_task.go`, `node/<prefix>_node.go`).

This directory is the whole extension and does not share code with `dagon.vscode`. It has two parts:

- `src/lib.rs` — a tiny Rust/wasm host. Zed only mounts an empty `extensions/work/<id>` directory for the running extension (the source tree is not available at runtime), so the LSP server bundle is embedded into the wasm binary via `include_bytes!` and written out to disk before Node starts it.
- `server/` — the actual language server, in TypeScript, bundled to `server/dist/server.js` by esbuild. This is what `lib.rs` embeds.

## Commands

```bash
cd dagon.zed/server
npm install
npm run check   # tsc --noEmit
npm run build   # esbuild -> server/dist/server.js (embedded into the wasm extension)
npm test        # tsc --noEmit + tsc + unit tests (engine.test.ts) + build + LSP driver smoke test (test/lsp-driver.mjs)
```

Building the Rust/wasm side requires the `wasm32-wasip2` target:

```bash
rustup target add wasm32-wasip2
```

Build order matters: `npm run build` in `server/` must happen *before* Zed compiles the wasm extension, since `server/dist/server.js` is compiled into the Rust binary at Rust build time, not loaded at runtime. After any change under `server/src/`, rebuild and reinstall the dev extension (Zed → Extensions → Install Dev Extension → select this `dagon.zed` directory).

## Architecture

**`server/src/engine.ts`** (~1750 lines) — the pure DAG engine. No editor types, no I/O: hosts supply file reads via the `FileStore` interface (`read`, `find`) and the engine returns data (locations, diagnostics, edits). Exports fall into a few groups:
- Pure string/naming helpers: `escapeRegex`, `stripLineComments`, `globToRegExp`, `matchGlob`, `isVendorPath`, `filePrefix`, `normalizeDagName`, `isSnakeName`, `snakeToPascal`/`snakeToCamel`/`snakeToUpper`/`snakeToHyphen`, `goModulePath`.
- Parsers over raw file lines: `parseInitSection`, `parseFactorySection`, `parseTaskGroups`/`parseTaskGroupsWithLines`, `parsePipelineTaskRefs`, `parseTaskAssignments`, `parseNodeDepsWithLines`, `findNodeNameMismatches`, `isInsideStringArray`.
- Scaffolding/rewriting: `buildNewInitBody`, `buildNewFactoryBody`, `planReorder`, `buildNewDagTemplates`, `substitutePrefix`, `constantInsert`, `dagFiles`.
- `DagonEngine` (class, starts at line 266) — the stateful engine: holds caches over a workspace's DAG files and exposes the operations the LSP server calls (definition/reference lookups, hover text, diagnostics, reorder plans, DAG creation/cloning). This is the Zed-side equivalent of `NodeNavigatorHelper` in `dagon.vscode/src/extension.ts` — same responsibilities, independent implementation.
- `memoryStore` — an in-memory `FileStore` implementation used by `engine.test.ts` to test the engine without a real filesystem.

**`server/src/server.ts`** (~620 lines) — wraps `DagonEngine` as an LSP server using `vscode-languageserver`. Registers hover, go-to-definition, find-references, code actions (go to node, create/clone DAG, reorganize by task, open dependent), code lenses (dependent count, task assignment), and diagnostics, with a 200ms debounce (`DEBOUNCE_MS`) on diagnostic recomputation. Implements the `FileStore` the engine needs on top of `TextDocuments` (prefers unsaved buffer content) plus real `fs` access and glob-based `find`.

**`src/lib.rs`** — `DagonExtension::language_server_command` writes the embedded `SERVER_JS` bytes out to `server/dist/server.js` under the current (per-extension) working directory, then returns a `Command` that runs `node <path> --stdio`.

## Conventions to preserve when editing

- Keep `engine.ts` free of editor/LSP types and direct file I/O — all such access goes through `FileStore` so the engine stays testable via `memoryStore` and shareable in spirit (if not in code) with the VS Code implementation's logic.
- Changes to the DAG file-layout conventions (`lazyNodes` naming, `model.Node`, the four-file-per-prefix layout) generally need a matching change in `dagon.vscode/src/extension.ts` — see the repo root `CLAUDE.md`.
- `gopls` must remain the first-registered Go language server in Zed; Dagon's navigation is exposed via code actions/lenses rather than overriding Go to Definition/Find All References, so it doesn't fight `gopls` for those.
