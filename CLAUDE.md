# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Dagon" is a tool for navigating and authoring Go DAG (directed acyclic graph) pipelines. A DAG project follows a fixed file layout per pipeline prefix (e.g. `sfv_p7`):

- `<prefix>_dag.go` — top-level DAG definition
- `pipeline/<prefix>_pipeline.go` — pipeline wiring, references tasks
- `task/<prefix>_task.go` — task groups, each grouping node public keys
- `node/<prefix>_node.go` — node factories (`"snake_key": func() model.Node {...}`) and a public map (`init()`) that maps PascalCase keys to lazy-loaded snake_case node keys

This repo contains two **independent, non-code-sharing** implementations of that same navigation/authoring logic, for two different editors:

- `dagon.vscode/` — a VS Code extension, single TypeScript file (`src/extension.ts`).
- `dagon.zed/` — a Zed extension: a thin Rust/wasm host (`src/lib.rs`) that bundles and launches a TypeScript LSP server (`server/src/`).

Both detect the DAG prefix from the filename and from `lazyNodes` variable names rather than hardcoding a prefix, and both provide equivalent features: go-to-node-implementation, find usages, hover info, dependent/task code lenses, scaffold-new-DAG, clone-DAG, and the same 8 structural diagnostics (same-task cycles, missing pipeline/task/node/factory/dependency references, late dependencies, unused nodes, factory/key mismatches).

When fixing a bug or adding a feature, check whether the equivalent logic needs to change in **both** extensions — they are maintained in parallel but have separate source trees.

## dagon.vscode (VS Code extension)

See `dagon.vscode/CLAUDE.md` for full detail. Quick reference:

```bash
cd dagon.vscode
npm run compile   # type-check + lint + build (dev)
npm run watch     # parallel watch: esbuild + tsc
npm run test      # compile tests + compile + lint + run vscode-test
```

All logic lives in `src/extension.ts` (~2150 lines): providers for definition/hover/references/code-lens, the 7 palette commands, file watchers, and 8 live `DiagnosticCollection`s, all backed by a shared `NodeNavigatorHelper` engine class.

## dagon.zed (Zed extension)

See `dagon.zed/README.md` for full detail. Quick reference:

```bash
cd dagon.zed/server
npm install
npm test          # tsc check + unit test (engine.test.ts) + build + LSP driver smoke test
npm run build      # bundles server/dist/server.js, which the Rust/wasm layer embeds via include_bytes!
```

Architecture: `server/src/engine.ts` (~1750 lines) is the pure DAG-parsing/navigation engine (parsing, diagnostics, scaffolding, renaming — no I/O or protocol). `server/src/server.ts` (~620 lines) wraps it as an `vscode-languageserver` LSP server (hover, definitions, references, code actions, code lenses, diagnostics, workspace edits). `src/lib.rs` is a minimal wasm extension that writes the pre-built `server/dist/server.js` into Zed's extension work directory at startup and spawns it with `node ... --stdio`.

Building requires rebuilding the server bundle (`npm run build` in `server/`) *before* Zed compiles the wasm extension, since the JS bundle is embedded into the Rust binary via `include_bytes!`. After any change to `server/src/`, re-run the build and reinstall the dev extension in Zed (Extensions → Install Dev Extension → select `dagon.zed/`).

Rust/wasm toolchain requirement: `rustup target add wasm32-wasip2`.

Dagon is designed to run alongside `gopls`, not replace it — Zed routes Go to Definition/Find All References to the first-registered Go language server, so `gopls` must stay first; Dagon's equivalent features are exposed as code actions/lenses instead.
