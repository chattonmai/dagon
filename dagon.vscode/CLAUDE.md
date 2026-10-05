# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

"Dagon" — a VS Code extension for navigating and authoring Go DAG (directed acyclic graph) pipelines. A DAG project follows a fixed file layout per pipeline prefix (e.g. `sfv_p7`):

- `<prefix>_dag.go` — top-level DAG definition
- `pipeline/<prefix>_pipeline.go` — pipeline wiring, references tasks
- `task/<prefix>_task.go` — task groups, each grouping node public keys
- `node/<prefix>_node.go` — node factories (`"snake_key": func() model.Node {...}`) and a public map (`init()`) that maps PascalCase keys to lazy-loaded snake_case node keys

The extension understands this convention well enough to navigate between the layers, show usages/hovers/CodeLenses, scaffold new DAGs, and flag inconsistencies as diagnostics — all without hardcoding a specific prefix (earlier versions hardcoded `LfvP1`; the current implementation derives the prefix from the filename and from `lazyNodes` variable names found in the file).

## Commands

```bash
npm run compile       # type-check + lint + build (dev)
npm run package       # type-check + lint + build (production, minified)
npm run watch         # parallel watch: esbuild + tsc type checking
npm run lint          # eslint on src/
npm run check-types   # tsc type check only
npm run test          # compile tests + compile + lint + run vscode-test
```

The extension entry point is `src/extension.ts` (single file, ~2150 lines). esbuild bundles it to `dist/extension.js` (referenced as `out/extension.js` in `package.json` — note the mismatch: `main` in package.json says `out/` but esbuild outputs to `dist/`). Tests compile to `out/test/`.

## Command Palette

| Command | Title | What it does |
|---|---|---|
| `dagon.navigateToNode` | Go to Node Implementation | Jumps from a node reference to its factory (`Cmd+Alt+N` / `Ctrl+Alt+N`) |
| `dagon.findUsages` | Find Node Usages | Lists dependents of the node under the cursor via Quick Pick (`Cmd+Alt+U` / `Ctrl+Alt+U`) |
| `dagon.findUsagesFor` | Find Node Usages For Key | Same as above, invoked from a CodeLens click with an explicit key instead of cursor position |
| `dagon.reorderByTask` | Dagon: Reorganize nodes by task | Rewrites a node file's `init()` map and factory map, grouping/ordering entries to match the task groups in the corresponding `_task.go` file |
| `dagon.createNewDag` | Dagon: Create New DAG | Prompts for a snake_case name, scaffolds the 4 files from templates, and registers a constant |
| `dagon.createDagFrom` | Dagon: Create New DAG From Existing | Quick Pick an existing DAG, clones its 4 files under a new prefix (rewrites Pascal/camel/snake naming throughout) |
| `dagon.searchDag` | Dagon: Search DAG | Quick Pick over all existing DAGs; opens all 4 related files for the selected one |

Internal-only commands invoked programmatically from CodeLens/hover (not in the palette): `dagon.openFileAtLine`, `dagon.showTaskNodes`, `dagon.openTaskFile`.

## Architecture

All logic lives in `src/extension.ts`.

**`activate`** registers:
- `NodeDefinitionProvider` (F12 / Go to Definition)
- `NodeHoverProvider` (shows whether a node is implemented + its dependents)
- `NodeReferenceProvider` (Find All References)
- `NodeCodeLensProvider` (shows task assignment + dependent count above each factory entry)
- The 10 commands above
- File watchers (`onDidSaveTextDocument`, `onDidCreateFiles`, `onDidDeleteFiles`, plus raw `FileSystemWatcher`s on `*_node.go`/`*_task.go` to catch external changes like `git checkout`) that invalidate `NodeNavigatorHelper`'s caches
- 8 live `DiagnosticCollection`s, re-run on open/edit/save (see below)

**`NodeNavigatorHelper`** — the shared engine. Key responsibilities:
- `getFilePrefixFromDocument` — derives the DAG prefix from the filename (`<prefix>_node.go` / `<prefix>_task.go`)
- `findNodeFiles` — globs `**/node/**/*<prefix>*node*.go` (excluding `vendor/`)
- `resolveNodeKey` — given a cursor position, figures out which node key (factory line, dependency string, lazy-node reference, or public map entry) is under it
- `findLazyKey` / `findFactory` — resolve a PascalCase public key to its snake_case factory, and vice versa
- `findUsages` / `findAllUsages` — scans `[]string{...}` dependency blocks (inline and multi-line) across node files to build a reverse dependency map
- `parseInitSection` / `parseFactorySection` / `parseTaskGroups` — parse the three structural blocks these commands operate on
- `buildNewDagTemplates` / `writeNewDagFiles` / `substitutePrefix` — used by `createNewDag` / `createDagFrom` to scaffold or clone DAGs
- Caches (`nodeFilesCache`, `allUsagesCache`, `taskGroupsCache`) invalidated per-file or globally by the watchers in `activate`

**`stripLineComments`** — strips `//` and `/* */` comments from a line while respecting `"..."` and `` `...` `` string literals, so a comment after a dependency string doesn't break parsing. Used throughout the scanners.

**Diagnostics** (all `source: 'dagon'`, re-run in `triggerDiagnostics` on open/edit/save):
| Collection | Flags |
|---|---|
| `dagon-same-task` | A node depends on another node in the same or a later task |
| `dagon-pipeline` | A task referenced in the pipeline file isn't assigned in the task file |
| `dagon-task-node-exist` | A node referenced in the task file has no `init()` declaration in the node file |
| `dagon-node-factory` | A node declared in `init()` has no matching factory entry |
| `dagon-node-dep-exist` | A dependency key doesn't match any node factory |
| `dagon-node-dep-task` | A dependency is in the same or a later task than the node that depends on it |
| `dagon-unused-node` | A node is declared in `init()` but referenced by no task |
| `dagon-node-name` | A factory's key doesn't match the first argument passed to `newNode(...)` |

## Conventions to preserve when editing

- The `model.Node` type and `LazyNodes[...]` / `lazyNodes` naming are load-bearing regex anchors throughout — changing the target project's conventions requires updating the patterns in `NodeNavigatorHelper` and the providers, not just one function.
- Prefix detection is filename- and content-derived (no more hardcoded prefix), but still assumes the `<prefix>_dag.go` / `pipeline/<prefix>_pipeline.go` / `task/<prefix>_task.go` / `node/<prefix>_node.go` layout.
- Diagnostic functions swallow errors silently (`catch { /* silently ignore */ }`) by design, to avoid disrupting the editor on malformed/partial files — don't add throws inside them without reason.
