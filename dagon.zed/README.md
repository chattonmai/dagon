# Dagon for Zed

Navigate and author Go DAG pipelines from Zed. This directory is the whole extension: the wasm host, the language server, and the DAG engine. It does not share code with `dagon.vscode`.

## Build

The language server has to be bundled before Zed starts it.

```sh
cd dagon.zed/server
npm install
npm test
npm run build
```

`npm run build` writes `server/dist/server.js`. That file is compiled into the wasm extension. Zed does not mount this folder for the running extension. On startup the extension writes the bundle into Zed's extension work directory and Node runs it from there.

Install the extension from the Zed UI: Extensions → Install Dev Extension, and choose this `dagon.zed` directory. Zed compiles the wasm extension, so build the server bundle first. After a server change, run `npm run build` again and reinstall the dev extension. That compile needs Rust and the `wasm32-wasip2` target:

```sh
rustup target add wasm32-wasip2
```

## Code lenses

Zed hides code lenses until you turn them on. In Zed settings:

```json
{
  "code_lens": "on"
}
```

`"menu"` lists the same lenses in the code actions menu.

## How to use it

Dagon's commands are code actions, not palette commands. On a Go file in a DAG repo, put the cursor on the relevant line and press `Cmd+.` (macOS) / `Ctrl+.` (Windows/Linux) to open the code actions menu, then pick the action:

- **Go to a node.** Put the cursor on a task call, a public-map entry, a lazy-node lookup, or a `[]string` dependency. Run the code action "Go to node implementation".
- **See dependents.** Hover shows whether the node is implemented and lists the factories that depend on it. The code lens "N dependents" opens the first one. Each other dependent is a code action, "Open dependent: …".
- **See the task.** A code lens above each factory shows "Task N", or "No task". "Task N" opens that assignment in the task file. "No task" opens the task file.
- **Diagnostics.** Dagon reports same-task cycles, pipeline references, missing task nodes, missing factories, missing dependencies, dependencies that run too late, unused nodes, and factory keys that do not match `newNode`. The source is `dagon`.
- **Reorganize.** On a `*_node.go` file, run "Reorganize nodes by task".
- **Create a DAG.** Select the name in a Go buffer, then run "Create DAG from selection". `dno-p5`, `"dno-p5"`, and `DNO_P5_NAME` all mean the prefix `dno_p5`, which writes `DNO_P5_NAME = "dno-p5"`.

## gopls

Dagon runs beside gopls. It does not replace it.

Keep gopls as the first Go language server. Zed sends Go to Definition and Find All References to that first server, and an empty answer does not continue to Dagon. With gopls first, F12 stays Go's own jump. Use the "Go to node implementation" code action, or a code lens, to jump to a node.

Hover text and diagnostics from Dagon show up next to gopls without changing that order.
