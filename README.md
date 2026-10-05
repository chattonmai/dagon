# Dagon

Go DAG (directed acyclic graph) pipelines follow a strict, repetitive layout: a `_dag.go` file wires pipelines, pipelines wire tasks, tasks group node keys, and the actual logic sits in a `node/` factory map keyed by a snake_case string. Jumping from "this task references `LfvP1CandidateLatestUgcLfv`" to "here's what that node actually does" means a manual grep, every time — across potentially hundreds of nodes.

Dagon turns that grep into a jump. It understands the DAG → pipeline → task → node structure well enough to go straight from any reference to its implementation, show you who depends on a node, flag broken wiring before it ships, and scaffold a new DAG from a name instead of copy-pasting boilerplate.

It ships as two independent, non-code-sharing extensions with equivalent features, one per editor:

- [`dagon.vscode/`](dagon.vscode/README.md) — a VS Code extension.
- [`dagon.zed/`](dagon.zed/README.md) — a Zed extension.

Both detect the DAG prefix straight from the filename and `lazyNodes` variable names — no config, no hardcoded prefixes — and both provide go-to-node-implementation, find usages, hover info, dependent/task code lenses, scaffold-new-DAG, clone-DAG, and structural diagnostics (cycles, missing references, unused nodes, key mismatches).

Pick your editor's folder above for install and setup. See [CLAUDE.md](CLAUDE.md) for the full architecture notes.
