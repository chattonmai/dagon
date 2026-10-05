# Dagon for VS Code

Navigate and author Go DAG pipelines from VS Code. This directory is the whole extension, a single TypeScript file. It does not share code with `dagon.zed`.

## How to use

On a Go file in a DAG project:

- **Go to a node.** Put the cursor on a task call, a public-map entry, a lazy-node lookup, or a `[]string` dependency, then press `F12` (Go to Definition) or run "Go to Node Implementation" from the Command Palette.
- **See dependents.** Hovering over a node reference shows whether it's implemented and lists the factories that depend on it. `Shift+F12` (Find All References) lists the same dependents.
- **See the task.** A CodeLens above each factory shows its task assignment and dependent count; click either to jump there.
- **Diagnostics.** Problems panel reports same-task cycles, missing pipeline/task/node/factory/dependency references, late dependencies, unused nodes, and factory keys that don't match `newNode` — all re-checked on open/edit/save.

Open the Command Palette (`Cmd+Shift+P` on macOS, `Ctrl+Shift+P` on Windows/Linux) for the rest:

| Command | What it does |
| --- | --- |
| Go to Node Implementation | Jumps from a node reference to its factory (also bound to `Cmd+Alt+N` / `Ctrl+Alt+N`) |
| Find Node Usages | Lists dependents of the node under the cursor (also bound to `Cmd+Alt+U` / `Ctrl+Alt+U`) |
| Dagon: Reorganize nodes by task | Rewrites a node file's map and factory entries to match the task groups in the corresponding `_task.go` file |
| Dagon: Create New DAG | Prompts for a snake_case name and scaffolds the 4 DAG files from templates |
| Dagon: Create New DAG From Existing | Pick an existing DAG and clone its 4 files under a new prefix |
| Dagon: Search DAG | Pick a DAG and open all 4 of its related files at once |

## Requirements

- Node factories live under a `node/` directory, in a file matching the DAG prefix (e.g. `node/sfv_p7_node.go`).
- Node map entries follow the pattern `lazyNodes["key"]`.
