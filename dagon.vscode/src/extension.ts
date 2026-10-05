import * as vscode from 'vscode';

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove a trailing `//` line comment and any inline `/* */` comments from a single
// line, while respecting double-quoted ("...") and raw (`...`) string literals so that
// slashes, braces, or quotes inside a string are never mistaken for a comment.
// Used by the dependency scanners so that a comment on a dependency line — e.g.
//   "validate_user_feature_is_unknown", // Task 16
// — does not stop the dependency from being detected (the dep regexes anchor to end
// of line). Operates per line; multi-line /* */ blocks inside a []string{} are not
// expected and are not tracked across lines.
export function stripLineComments(line: string): string {
    let result = '';
    let inString = false;   // inside "..."
    let inRawString = false; // inside `...`
    let inBlock = false;     // inside /* ... */

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        const next = i + 1 < line.length ? line[i + 1] : '';

        if (inBlock) {
            if (ch === '*' && next === '/') { inBlock = false; i++; }
            continue;
        }
        if (inString) {
            result += ch;
            if (ch === '\\' && next) { result += next; i++; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (inRawString) {
            result += ch;
            if (ch === '`') { inRawString = false; }
            continue;
        }
        if (ch === '/' && next === '/') { break; } // rest of line is a comment
        if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
        if (ch === '"') { inString = true; result += ch; continue; }
        if (ch === '`') { inRawString = true; result += ch; continue; }
        result += ch;
    }

    return result;
}

interface UsageResult {
    location: vscode.Location;
    enclosingFactory: string;
}

interface TaskGroup {
    taskNumber: number;
    publicKeys: string[];
}

interface InitEntry {
    publicKey: string;
    snakeKey: string;
    line?: number;
}

interface InitParseResult {
    mapStartLine: number;
    mapEndLine: number;
    entries: InitEntry[];
}

interface TaskNodeLineInfo {
    taskNumber: number;
    line: number;
    publicKey: string;
}

interface FactoryParseResult {
    mapStartLine: number;
    mapEndLine: number;
    factories: Map<string, string[]>;
}

export function activate(context: vscode.ExtensionContext) {
    const helper = new NodeNavigatorHelper();

    const definitionProvider = vscode.languages.registerDefinitionProvider(
        { scheme: 'file', language: 'go' },
        new NodeDefinitionProvider(helper)
    );

    const hoverProvider = vscode.languages.registerHoverProvider(
        { scheme: 'file', language: 'go' },
        new NodeHoverProvider(helper)
    );

    const referenceProvider = vscode.languages.registerReferenceProvider(
        { scheme: 'file', language: 'go' },
        new NodeReferenceProvider(helper)
    );

    const codeLensProvider = vscode.languages.registerCodeLensProvider(
        { scheme: 'file', language: 'go' },
        new NodeCodeLensProvider(helper)
    );

    const navigateCommand = vscode.commands.registerCommand(
        'dagon.navigateToNode',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No active editor'); return; }

            const location = await new NodeDefinitionProvider(helper).provideDefinition(
                editor.document,
                editor.selection.active,
                new vscode.CancellationTokenSource().token
            );
            if (location && !Array.isArray(location)) {
                await vscode.window.showTextDocument(location.uri, { selection: location.range });
            } else {
                vscode.window.showWarningMessage('Node implementation not found');
            }
        }
    );

    const findUsagesCommand = vscode.commands.registerCommand(
        'dagon.findUsages',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showWarningMessage('No active editor'); return; }

            const lazyKey = await helper.resolveNodeKey(editor.document, editor.selection.active);
            if (!lazyKey) { vscode.window.showWarningMessage('No node identifier at cursor'); return; }

            await showUsagesQuickPick(helper, editor.document, lazyKey);
        }
    );

    // Used by CodeLens clicks — accepts lazyKey directly instead of reading from cursor
    const findUsagesForCommand = vscode.commands.registerCommand(
        'dagon.findUsagesFor',
        async (lazyKey: string, document: vscode.TextDocument) => {
            await showUsagesQuickPick(helper, document, lazyKey);
        }
    );

    const reorderByTaskCommand = vscode.commands.registerCommand(
        'dagon.reorderByTask',
        async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { return; }

            const filePrefix = helper.getFilePrefixFromDocument(editor.document);
            if (!filePrefix) {
                vscode.window.showWarningMessage('Not a node file (_node.go required)');
                return;
            }

            const taskUri = await helper.findTaskFile(editor.document);
            if (!taskUri) {
                vscode.window.showWarningMessage(`Task file not found for prefix: ${filePrefix}`);
                return;
            }

            const taskGroups = await helper.parseTaskGroups(taskUri);
            if (taskGroups.length === 0) {
                vscode.window.showWarningMessage('No task groups found in task file');
                return;
            }

            const lines = editor.document.getText().split('\n');
            const initResult = helper.parseInitSection(lines);
            const factoryResult = helper.parseFactorySection(lines);

            if (initResult.mapStartLine < 0) {
                vscode.window.showWarningMessage('Could not find public node map in init()');
                return;
            }

            // Read lazy prefix from the actual variable name in the file (e.g. pp2LazyNodes → pp2).
            // Falling back to filename-derived camelCase only when no existing entry is found.
            const lazyVarMatch = editor.document.getText().match(/\b([a-zA-Z][a-zA-Z0-9]*)[Ll]azyNodes\[/);
            const lazyPrefix = lazyVarMatch
                ? lazyVarMatch[1]
                : filePrefix.replace(/_([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());

            const newInitBody = helper.buildNewInitBody(taskGroups, initResult.entries, lazyPrefix);

            // Build ordered snake keys: uncovered first, then by task
            const entryByPublic = new Map(initResult.entries.map(e => [e.publicKey, e]));
            const coveredPublicKeys = new Set(taskGroups.flatMap(g => g.publicKeys));
            const orderedSnakeKeys: string[] = [];
            for (const entry of initResult.entries) {
                if (!coveredPublicKeys.has(entry.publicKey)) {
                    orderedSnakeKeys.push(entry.snakeKey);
                }
            }
            for (const group of taskGroups) {
                for (const pk of group.publicKeys) {
                    const entry = entryByPublic.get(pk);
                    if (entry) { orderedSnakeKeys.push(entry.snakeKey); }
                }
            }

            const newFactoryBody = helper.buildNewFactoryBody(orderedSnakeKeys, factoryResult.factories);

            const edit = new vscode.WorkspaceEdit();

            const initRange = new vscode.Range(
                initResult.mapStartLine + 1, 0,
                initResult.mapEndLine, 0
            );
            edit.replace(editor.document.uri, initRange, newInitBody + '\n');

            if (factoryResult.mapStartLine >= 0 && factoryResult.mapEndLine >= 0) {
                const factoryRange = new vscode.Range(
                    factoryResult.mapStartLine + 1, 0,
                    factoryResult.mapEndLine, 0
                );
                edit.replace(editor.document.uri, factoryRange, newFactoryBody + '\n');
            }

            await vscode.workspace.applyEdit(edit);
            helper.invalidateForFile(editor.document.uri.fsPath);
            await vscode.window.showTextDocument(editor.document);
            await vscode.commands.executeCommand('editor.action.formatDocument');

            const nodeCount = initResult.entries.length;
            const taskCount = taskGroups.length;
            vscode.window.showInformationMessage(
                `Reordered ${nodeCount} nodes across ${taskCount} tasks`
            );
        }
    );

    const createNewDagCommand = vscode.commands.registerCommand(
        'dagon.createNewDag',
        async () => {
            const raw = await vscode.window.showInputBox({
                prompt: 'New DAG name (snake_case, e.g. my_new_dag)',
                validateInput: v => /^[a-z][a-z0-9_]*$/.test(v) ? null : 'Use lowercase snake_case only',
            });
            if (!raw) { return; }
            // Strip all positions of "dag": afv_p4_dag / dag_afv_p4 / afv_dag_p4 → afv_p4
            const name = raw
                .replace(/^dag_?/, '')
                .replace(/_?dag$/, '')
                .replace(/_dag_/g, '_')
                .replace(/^_+|_+$/g, '');

            const dagRoot = await helper.findDagRoot();
            if (!dagRoot) { vscode.window.showWarningMessage('No dag/ directory found in workspace'); return; }

            const modulePath = await helper.detectGoModule();
            const contents = helper.buildNewDagTemplates(name, modulePath);
            const uris = await helper.writeNewDagFiles(dagRoot, name, contents);

            const constFile = await helper.findDagConstantsFile();
            if (constFile) { await helper.addDagConstant(constFile, name); }
            else { vscode.window.showWarningMessage('Constant file not found — add constant manually'); }

            for (const uri of uris) {
                await vscode.window.showTextDocument(uri, { preview: false });
            }
            vscode.window.showInformationMessage(`Created DAG "${name}" (4 files + constant)`);
        }
    );

    const createDagFromCommand = vscode.commands.registerCommand(
        'dagon.createDagFrom',
        async () => {
            const existing = await helper.findExistingDags();
            if (existing.length === 0) {
                vscode.window.showWarningMessage('No *_dag.go files found in workspace');
                return;
            }

            const picked = await vscode.window.showQuickPick(
                existing.map(d => ({
                    label: d.prefix,
                    description: vscode.workspace.asRelativePath(d.dagUri),
                    dag: d,
                })),
                { placeHolder: 'Select source DAG to copy from' }
            );
            if (!picked) { return; }

            const rawName = await vscode.window.showInputBox({
                prompt: `New DAG name (snake_case), copying from "${picked.label}"`,
                validateInput: v => /^[a-z][a-z0-9_]*$/.test(v) ? null : 'Use lowercase snake_case only',
            });
            if (!rawName) { return; }
            const newName = rawName
                .replace(/^dag_?/, '')
                .replace(/_?dag$/, '')
                .replace(/_dag_/g, '_')
                .replace(/^_+|_+$/g, '');

            const oldPrefix = picked.label;
            const dagRoot = vscode.Uri.joinPath(picked.dag.dagUri, '..');

            const srcPaths: Record<string, vscode.Uri> = {
                dag:      vscode.Uri.joinPath(dagRoot, `${oldPrefix}_dag.go`),
                pipeline: vscode.Uri.joinPath(dagRoot, 'pipeline', `${oldPrefix}_pipeline.go`),
                task:     vscode.Uri.joinPath(dagRoot, 'task', `${oldPrefix}_task.go`),
                node:     vscode.Uri.joinPath(dagRoot, 'node', `${oldPrefix}_node.go`),
            };

            // Detect actual Pascal/camel forms from the node file — the filename prefix
            // (e.g. p_p2) may not match the internal naming convention (e.g. Pp2/pp2).
            let overrideOldPascal: string | undefined;
            let overrideOldCamel: string | undefined;
            try {
                const nodeRaw = Buffer.from(await vscode.workspace.fs.readFile(srcPaths.node)).toString('utf8');
                overrideOldPascal = nodeRaw.match(/\b([A-Z][A-Za-z0-9]*)Node\b/)?.[1];
                overrideOldCamel  = nodeRaw.match(/\b([a-z][A-Za-z0-9]*)LazyNodes\b/)?.[1];
            } catch { /* keep undefined — substitutePrefix falls back to derived forms */ }

            const contents: Record<string, string> = {};
            for (const [key, uri] of Object.entries(srcPaths)) {
                try {
                    const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                    contents[key] = helper.substitutePrefix(raw, oldPrefix, newName, overrideOldPascal, overrideOldCamel);
                } catch {
                    vscode.window.showWarningMessage(`Could not read ${uri.fsPath}`);
                    return;
                }
            }

            const uris = await helper.writeNewDagFiles(dagRoot, newName, contents);

            const constFile = await helper.findDagConstantsFile();
            if (constFile) { await helper.addDagConstant(constFile, newName); }
            else { vscode.window.showWarningMessage('Constant file not found — add constant manually'); }

            for (const uri of uris) {
                await vscode.window.showTextDocument(uri, { preview: false });
            }
            vscode.window.showInformationMessage(`Created DAG "${newName}" from "${oldPrefix}" (4 files + constant)`);
        }
    );

    const searchDagCommand = vscode.commands.registerCommand(
        'dagon.searchDag',
        async () => {
            const existing = await helper.findExistingDags();
            if (existing.length === 0) {
                vscode.window.showWarningMessage('No *_dag.go files found in workspace');
                return;
            }

            const picked = await vscode.window.showQuickPick(
                existing.map(d => ({
                    label: d.prefix,
                    description: vscode.workspace.asRelativePath(d.dagUri),
                    dag: d,
                })),
                { placeHolder: 'Search DAG' }
            );
            if (!picked) { return; }

            const { prefix, dagUri } = picked.dag;
            const dagRoot = vscode.Uri.joinPath(dagUri, '..');

            const candidates: vscode.Uri[] = [
                dagUri,
                vscode.Uri.joinPath(dagRoot, 'pipeline', `${prefix}_pipeline.go`),
                vscode.Uri.joinPath(dagRoot, 'task',     `${prefix}_task.go`),
                vscode.Uri.joinPath(dagRoot, 'node',     `${prefix}_node.go`),
            ];

            let opened = 0;
            for (const uri of candidates) {
                try {
                    await vscode.window.showTextDocument(uri, { preview: false });
                    opened++;
                } catch {
                    vscode.window.showWarningMessage(`File not found: ${vscode.workspace.asRelativePath(uri)}`);
                }
            }
            if (opened > 0) {
                vscode.window.showInformationMessage(`Opened ${opened} file(s) for DAG "${prefix}"`);
            }
        }
    );

    const openFileAtLineCommand = vscode.commands.registerCommand(
        'dagon.openFileAtLine',
        async (uri: vscode.Uri, line: number) => {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(line, 0, line, 0),
            });
        }
    );

    const showTaskNodesCommand = vscode.commands.registerCommand(
        'dagon.showTaskNodes',
        async (taskNumber: number, publicKeys: string[], document: vscode.TextDocument) => {
            const filePrefix = helper.getFilePrefixFromDocument(document);
            const files = await helper.findNodeFiles(filePrefix);
            const docLines = document.getText().split('\n');
            const initResult = helper.parseInitSection(docLines);
            const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));

            const items = publicKeys
                .filter(pk => publicToSnake.has(pk))
                .map(pk => ({
                    label: pk,
                    description: publicToSnake.get(pk) ?? '',
                    snakeKey: publicToSnake.get(pk)!,
                }));

            const picked = await vscode.window.showQuickPick(items, {
                placeHolder: `Nodes in Task ${taskNumber} (${items.length} nodes)`,
            });
            if (!picked) { return; }

            const location = await helper.findFactory(files, picked.snakeKey);
            if (location) {
                await vscode.window.showTextDocument(location.uri, { selection: location.range });
            }
        }
    );

    const openTaskFileCommand = vscode.commands.registerCommand(
        'dagon.openTaskFile',
        async (document: vscode.TextDocument) => {
            const taskUri = await helper.findTaskFile(document);
            if (taskUri) {
                await vscode.window.showTextDocument(taskUri);
            } else {
                vscode.window.showWarningMessage('Task file not found');
            }
        }
    );

    // Invalidate caches on save (including autosave)
    const onSave = vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.uri.fsPath.endsWith('.go')) { helper.invalidateForFile(doc.uri.fsPath); }
    });
    const onCreate = vscode.workspace.onDidCreateFiles(e => {
        if (e.files.some(f => f.fsPath.endsWith('.go'))) { helper.invalidateAll(); }
    });
    const onDelete = vscode.workspace.onDidDeleteFiles(e => {
        if (e.files.some(f => f.fsPath.endsWith('.go'))) { helper.invalidateAll(); }
    });

    // Catch on-disk changes that bypass VS Code save (git discard, git checkout, external edits)
    const nodeWatcher = vscode.workspace.createFileSystemWatcher('**/*_node.go');
    nodeWatcher.onDidChange(uri => helper.invalidateForFile(uri.fsPath));
    const taskWatcher = vscode.workspace.createFileSystemWatcher('**/*_task.go');
    taskWatcher.onDidChange(uri => helper.invalidateForFile(uri.fsPath));

    // One DiagnosticCollection per check — prevents each check from overwriting another's results
    const diagSameTask      = vscode.languages.createDiagnosticCollection('dagon-same-task');
    const diagTaskNodeExist = vscode.languages.createDiagnosticCollection('dagon-task-node-exist');
    const diagUnusedNode    = vscode.languages.createDiagnosticCollection('dagon-unused-node');
    const diagNodeName      = vscode.languages.createDiagnosticCollection('dagon-node-name');
    const diagNodeFactory   = vscode.languages.createDiagnosticCollection('dagon-node-factory');
    const diagNodeDepExist  = vscode.languages.createDiagnosticCollection('dagon-node-dep-exist');
    const diagNodeDepTask   = vscode.languages.createDiagnosticCollection('dagon-node-dep-task');
    const diagPipeline      = vscode.languages.createDiagnosticCollection('dagon-pipeline');

    const triggerDiagnostics = (doc: vscode.TextDocument) => {
        if (doc.uri.scheme !== 'file') { return; }
        const name = doc.uri.fsPath;
        if (name.endsWith('_task.go') || name.endsWith('_node.go')) {
            updateSameTaskDiagnostics(helper, diagSameTask, doc);
            updateTaskNodeExistenceDiagnostics(helper, diagTaskNodeExist, doc);
            updateUnusedNodeDiagnostics(helper, diagUnusedNode, doc);
        }
        if (name.endsWith('_node.go')) {
            updateNodeNameDiagnostics(helper, diagNodeName, doc);
            updateNodeInitFactoryDiagnostics(helper, diagNodeFactory, doc);
            updateNodeDepExistenceDiagnostics(helper, diagNodeDepExist, doc);
            updateNodeDepTaskDiagnostics(helper, diagNodeDepTask, doc);
        }
        if (name.endsWith('_pipeline.go') || name.endsWith('_task.go')) {
            updatePipelineDiagnostics(helper, diagPipeline, doc);
        }
    };

    // Invalidate caches and re-run diagnostics on any edit (covers AI edits and unsaved changes)
    const onChange = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.scheme !== 'file') { return; }
        if (e.document.uri.fsPath.endsWith('.go') && e.contentChanges.length > 0) {
            helper.invalidateForFile(e.document.uri.fsPath);
            triggerDiagnostics(e.document);
        }
    });

    const onOpen = vscode.workspace.onDidOpenTextDocument(triggerDiagnostics);
    const onSaveForDiag = vscode.workspace.onDidSaveTextDocument(triggerDiagnostics);

    for (const editor of vscode.window.visibleTextEditors) {
        triggerDiagnostics(editor.document);
    }

    context.subscriptions.push(
        definitionProvider,
        hoverProvider,
        referenceProvider,
        codeLensProvider,
        navigateCommand,
        findUsagesCommand,
        findUsagesForCommand,
        reorderByTaskCommand,
        createNewDagCommand,
        createDagFromCommand,
        searchDagCommand,
        openFileAtLineCommand,
        showTaskNodesCommand,
        openTaskFileCommand,
        onSave,
        onChange,
        onCreate,
        onDelete,
        nodeWatcher,
        taskWatcher,
        diagSameTask,
        diagTaskNodeExist,
        diagUnusedNode,
        diagNodeName,
        diagNodeFactory,
        diagNodeDepExist,
        diagNodeDepTask,
        diagPipeline,
        onOpen,
        onSaveForDiag,
    );
}

async function showUsagesQuickPick(
    helper: NodeNavigatorHelper,
    document: vscode.TextDocument,
    lazyKey: string
) {
    const filePrefix = helper.getFilePrefixFromDocument(document);
    const files = await helper.findNodeFiles(filePrefix);
    const usages = await helper.findUsages(files, lazyKey);

    if (usages.length === 0) {
        vscode.window.showInformationMessage(`No dependents of "${lazyKey}" found`);
        return;
    }

    const items = usages.map(u => ({
        label: u.enclosingFactory,
        description: vscode.workspace.asRelativePath(u.location.uri),
        usage: u,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `Dependents of "${lazyKey}" (${usages.length} found)`,
    });

    if (picked) {
        await vscode.window.showTextDocument(picked.usage.location.uri, {
            selection: picked.usage.location.range,
        });
    }
}

async function updateSameTaskDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    try {
        const taskUri = document.uri.fsPath.endsWith('_task.go')
            ? document.uri
            : await helper.findTaskFile(document);
        if (!taskUri) { return; }

        const violations = await helper.findSameTaskViolations(taskUri);
        const taskDoc = await vscode.workspace.openTextDocument(taskUri);

        const diagnostics: vscode.Diagnostic[] = violations.map(v => {
            const lineText = taskDoc.lineAt(v.line).text;
            const col = lineText.indexOf(`["${v.nodePublicKey}"]`);
            const startCol = col >= 0 ? col : 0;
            const endCol = col >= 0 ? col + v.nodePublicKey.length + 3 : lineText.length;
            const range = new vscode.Range(v.line, startCol, v.line, endCol);
            const message = v.kind === 'same-task'
                ? `'${v.nodePublicKey}' depends on '${v.depSnakeKey}' (${v.depPublicKey}) which is in the same task (Task ${v.taskNumber}) — move one to a different task`
                : `'${v.nodePublicKey}' (Task ${v.taskNumber}) depends on '${v.depSnakeKey}' (${v.depPublicKey}) which runs later in Task ${v.depTaskNumber} — move '${v.nodePublicKey}' to a task after Task ${v.depTaskNumber}`;
            const diag = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
            diag.source = 'dagon';
            return diag;
        });

        collection.set(taskUri, diagnostics);
    } catch {
        // silently ignore errors to avoid disrupting the editor
    }
}

async function updatePipelineDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    try {
        let pipelineUri: vscode.Uri | undefined;
        if (document.uri.fsPath.endsWith('_pipeline.go')) {
            pipelineUri = document.uri;
        } else if (document.uri.fsPath.endsWith('_task.go')) {
            pipelineUri = await helper.findPipelineFile(document.uri);
        }
        if (!pipelineUri) { return; }

        const taskFilePath = pipelineUri.fsPath
            .replace(/\/pipeline\//, '/task/')
            .replace(/_pipeline\.go$/, '_task.go');
        const taskUri = vscode.Uri.file(taskFilePath);
        try { await vscode.workspace.fs.stat(taskUri); } catch { return; }

        const [refs, assigned] = await Promise.all([
            helper.parsePipelineTaskRefs(pipelineUri),
            helper.parseTaskAssignments(taskUri),
        ]);

        const pipelineDoc = await vscode.workspace.openTextDocument(pipelineUri);
        const diagnostics: vscode.Diagnostic[] = refs
            .filter(r => !assigned.has(r.taskVar))
            .map(r => {
                const lineText = pipelineDoc.lineAt(r.line).text;
                const col = lineText.indexOf(r.taskVar);
                const startCol = col >= 0 ? col : 0;
                const endCol = col >= 0 ? col + r.taskVar.length : lineText.length;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(r.line, startCol, r.line, endCol),
                    `Task '${r.taskVar}' is referenced in the pipeline but not assigned in the task file`,
                    vscode.DiagnosticSeverity.Error
                );
                diag.source = 'dagon';
                return diag;
            });

        collection.set(pipelineUri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateTaskNodeExistenceDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    try {
        let taskUri: vscode.Uri | undefined;
        let nodeDoc: vscode.TextDocument | undefined;

        if (document.uri.fsPath.endsWith('_task.go')) {
            taskUri = document.uri;
            const nodePath = document.uri.fsPath
                .replace(/\/task\//, '/node/')
                .replace(/_task\.go$/, '_node.go');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(nodePath));
                nodeDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(nodePath));
            } catch { return; }
        } else if (document.uri.fsPath.endsWith('_node.go')) {
            nodeDoc = document;
            const taskPath = document.uri.fsPath
                .replace(/\/node\//, '/task/')
                .replace(/_node\.go$/, '_task.go');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(taskPath));
                taskUri = vscode.Uri.file(taskPath);
            } catch { return; }
        }
        if (!taskUri || !nodeDoc) { return; }

        const taskRefs = await helper.parseTaskGroupsWithLines(taskUri);
        const initResult = helper.parseInitSection(nodeDoc.getText().split('\n'));
        const declaredKeys = new Set(initResult.entries.map(e => e.publicKey));

        const taskDoc = await vscode.workspace.openTextDocument(taskUri);
        const diagnostics: vscode.Diagnostic[] = taskRefs
            .filter(r => !declaredKeys.has(r.publicKey))
            .map(r => {
                const lineText = taskDoc.lineAt(r.line).text;
                const col = lineText.indexOf(`["${r.publicKey}"]`);
                const startCol = col >= 0 ? col : 0;
                const endCol = col >= 0 ? col + r.publicKey.length + 3 : lineText.length;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(r.line, startCol, r.line, endCol),
                    `Node '${r.publicKey}' is referenced in the task but not declared in the node file's init section`,
                    vscode.DiagnosticSeverity.Error
                );
                diag.source = 'dagon';
                return diag;
            });

        collection.set(taskUri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateNodeInitFactoryDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    if (!document.uri.fsPath.endsWith('_node.go')) { return; }
    try {
        const lines = document.getText().split('\n');
        const initResult = helper.parseInitSection(lines);
        const factoryResult = helper.parseFactorySection(lines);
        const factoryKeys = new Set(factoryResult.factories.keys());

        const diagnostics: vscode.Diagnostic[] = initResult.entries
            .filter(e => e.line !== undefined && !factoryKeys.has(e.snakeKey))
            .map(e => {
                const lineNum = e.line!;
                const lineText = document.lineAt(lineNum).text;
                const col = lineText.indexOf(`"${e.snakeKey}"`);
                const startCol = col >= 0 ? col : 0;
                const endCol = col >= 0 ? col + e.snakeKey.length + 2 : lineText.length;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(lineNum, startCol, lineNum, endCol),
                    `Node '${e.snakeKey}' is declared in init but has no factory entry`,
                    vscode.DiagnosticSeverity.Error
                );
                diag.source = 'dagon';
                return diag;
            });

        collection.set(document.uri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateNodeDepExistenceDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    if (!document.uri.fsPath.endsWith('_node.go')) { return; }
    try {
        const filePrefix = helper.getFilePrefixFromDocument(document);
        const files = await helper.findNodeFiles(filePrefix);
        const depsByFactory = await helper.parseDependenciesByFactory(files);
        const validKeys = new Set(depsByFactory.keys());

        const lines = document.getText().split('\n');
        const deps = helper.parseNodeDepsWithLines(lines);

        const diagnostics: vscode.Diagnostic[] = deps
            .filter(d => !validKeys.has(d.depKey))
            .map(d => {
                const lineText = document.lineAt(d.line).text;
                const col = lineText.indexOf(`"${d.depKey}"`);
                const startCol = col >= 0 ? col : 0;
                const endCol = col >= 0 ? col + d.depKey.length + 2 : lineText.length;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(d.line, startCol, d.line, endCol),
                    `Dependency '${d.depKey}' does not exist as a node factory`,
                    vscode.DiagnosticSeverity.Error
                );
                diag.source = 'dagon';
                return diag;
            });

        collection.set(document.uri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateNodeDepTaskDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    if (!document.uri.fsPath.endsWith('_node.go')) { return; }
    try {
        const taskPath = document.uri.fsPath
            .replace(/\/node\//, '/task/')
            .replace(/_node\.go$/, '_task.go');
        try { await vscode.workspace.fs.stat(vscode.Uri.file(taskPath)); } catch { return; }
        const taskUri = vscode.Uri.file(taskPath);

        const lines = document.getText().split('\n');
        const initResult = helper.parseInitSection(lines);
        const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));

        const filePrefix = helper.getFilePrefixFromDocument(document);
        const files = await helper.findNodeFiles(filePrefix);
        const depsByFactory = await helper.parseDependenciesByFactory(files);
        const factoryKeySet = new Set(depsByFactory.keys());

        const snakeToTask = await helper.buildSnakeToTaskMap(taskUri, publicToSnake, factoryKeySet);

        const deps = helper.parseNodeDepsWithLines(lines);
        const diagnostics: vscode.Diagnostic[] = [];

        for (const d of deps) {
            const factoryTask = snakeToTask.get(d.factoryKey);
            const depTask = snakeToTask.get(d.depKey);
            if (factoryTask === undefined || depTask === undefined) { continue; }

            let message: string | undefined;
            if (depTask === factoryTask) {
                message = `'${d.depKey}' is in the same task (Task ${factoryTask}) — deps must be from a previous task`;
            } else if (depTask > factoryTask) {
                message = `'${d.depKey}' is in Task ${depTask} which runs after Task ${factoryTask} — deps must be from a previous task`;
            }
            if (!message) { continue; }

            const lineText = document.lineAt(d.line).text;
            const col = lineText.indexOf(`"${d.depKey}"`);
            const startCol = col >= 0 ? col : 0;
            const endCol = col >= 0 ? col + d.depKey.length + 2 : lineText.length;
            const diag = new vscode.Diagnostic(
                new vscode.Range(d.line, startCol, d.line, endCol),
                message,
                vscode.DiagnosticSeverity.Error
            );
            diag.source = 'dagon';
            diagnostics.push(diag);
        }

        collection.set(document.uri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateUnusedNodeDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    try {
        let nodeDoc: vscode.TextDocument;
        let taskUri: vscode.Uri | undefined;

        if (document.uri.fsPath.endsWith('_node.go')) {
            nodeDoc = document;
            const taskPath = document.uri.fsPath
                .replace(/\/node\//, '/task/')
                .replace(/_node\.go$/, '_task.go');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(taskPath));
                taskUri = vscode.Uri.file(taskPath);
            } catch { return; }
        } else if (document.uri.fsPath.endsWith('_task.go')) {
            taskUri = document.uri;
            const nodePath = document.uri.fsPath
                .replace(/\/task\//, '/node/')
                .replace(/_task\.go$/, '_node.go');
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(nodePath));
                nodeDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(nodePath));
            } catch { return; }
        } else { return; }

        const initResult = helper.parseInitSection(nodeDoc!.getText().split('\n'));
        const taskRefs = await helper.parseTaskGroupsWithLines(taskUri!);
        const usedKeys = new Set(taskRefs.map(r => r.publicKey));

        const diagnostics: vscode.Diagnostic[] = initResult.entries
            .filter(e => e.line !== undefined && !usedKeys.has(e.publicKey))
            .map(e => {
                const lineNum = e.line!;
                const lineText = nodeDoc!.lineAt(lineNum).text;
                const col = lineText.indexOf(`"${e.publicKey}"`);
                const startCol = col >= 0 ? col : 0;
                const endCol = col >= 0 ? col + e.publicKey.length + 2 : lineText.length;
                const diag = new vscode.Diagnostic(
                    new vscode.Range(lineNum, startCol, lineNum, endCol),
                    `Node '${e.publicKey}' is declared but not used in any task`,
                    vscode.DiagnosticSeverity.Warning
                );
                diag.source = 'dagon';
                return diag;
            });

        collection.set(nodeDoc!.uri, diagnostics);
    } catch { /* silently ignore */ }
}

async function updateNodeNameDiagnostics(
    helper: NodeNavigatorHelper,
    collection: vscode.DiagnosticCollection,
    document: vscode.TextDocument
): Promise<void> {
    if (!document.uri.fsPath.endsWith('_node.go')) { return; }
    try {
        const mismatches = await helper.findNodeNameMismatches(document.uri);
        const diagnostics: vscode.Diagnostic[] = mismatches.map(m => {
            const lineText = document.lineAt(m.line).text;
            const col = lineText.indexOf(`"${m.firstParam}"`);
            const startCol = col >= 0 ? col : 0;
            const endCol = col >= 0 ? col + m.firstParam.length + 2 : lineText.length;
            const range = new vscode.Range(m.line, startCol, m.line, endCol);
            const diag = new vscode.Diagnostic(
                range,
                `Factory key '${m.factoryKey}' does not match node name '${m.firstParam}' — first argument to newNode must equal the factory key`,
                vscode.DiagnosticSeverity.Error
            );
            diag.source = 'dagon';
            return diag;
        });
        collection.set(document.uri, diagnostics);
    } catch {
        // silently ignore
    }
}

class NodeNavigatorHelper {
    // Caches — invalidated on save or file create/delete
    private nodeFilesCache = new Map<string, vscode.Uri[]>();
    private allUsagesCache = new Map<string, Map<string, UsageResult[]>>();
    private taskGroupsCache = new Map<string, TaskGroup[]>();

    invalidateForFile(fsPath: string) {
        if (fsPath.endsWith('_node.go')) {
            const name = fsPath.split('/').pop() ?? '';
            const m = name.match(/^(.+?)_node\.go$/);
            if (m) { this.nodeFilesCache.delete(m[1]); }
            this.nodeFilesCache.delete('');
            // allUsagesCache is keyed by sorted file paths, not prefix — clear all
            this.allUsagesCache.clear();
        } else if (fsPath.endsWith('_task.go')) {
            this.taskGroupsCache.delete(fsPath);
        } else if (fsPath.endsWith('.go')) {
            this.nodeFilesCache.clear();
        }
    }

    invalidateAll() {
        this.nodeFilesCache.clear();
        this.allUsagesCache.clear();
        this.taskGroupsCache.clear();
    }

    async resolveNodeKey(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<string | undefined> {
        const line = stripLineComments(document.lineAt(position).text);
        const filePrefix = this.getFilePrefixFromDocument(document);

        // Factory line: "final_result": func() model.Node {
        const factoryMatch = line.match(/"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/);
        if (factoryMatch) { return factoryMatch[1]; }

        // Dependency string(s) inside []string{}: "final_result", or "dep1", "dep2", — pick the one under the cursor
        if (this.isInsideStringArray(document, position)) {
            const col = position.character;
            for (const m of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                if (col >= m.index! && col <= m.index! + m[0].length) { return m[1]; }
            }
        }

        // Task call: node.SfvP7Node["FinalResult"]()
        const taskMatch = line.match(/node\.[A-Za-z0-9]+Node\["([^"]+)"\]/);
        if (taskMatch) {
            const files = await this.findNodeFiles(filePrefix);
            return this.findLazyKey(files, taskMatch[1]);
        }

        // Lazy node reference: sfvP7LazyNodes["candidate_pin_global"].Get()
        const lazyRefMatch = line.match(/[Ll]azyNodes\["([^"]+)"\]/);
        if (lazyRefMatch) { return lazyRefMatch[1]; }

        // Public map entry (fallback): "FinalResult": func() model.Node
        const mapMatch = line.match(/"([A-Z][A-Za-z0-9]*)":\s*func\(\)\s*model\.Node/);
        if (mapMatch) {
            const files = await this.findNodeFiles(filePrefix);
            return this.findLazyKey(files, mapMatch[1]);
        }

        return undefined;
    }

    // Find all nodes that list lazyKey in their []string{} dependency block.
    // Handles both inline []string{"dep1","dep2"} and multi-line formats.
    async findUsages(files: vscode.Uri[], lazyKey: string): Promise<UsageResult[]> {
        const allUsages = await this.findAllUsages(files);
        return allUsages.get(lazyKey) ?? [];
    }

    // Scan all files once and return a map of lazyKey → UsageResult[] for every dep found.
    async findAllUsages(files: vscode.Uri[]): Promise<Map<string, UsageResult[]>> {
        const cacheKey = files.map(f => f.fsPath).sort().join('\0');
        const cached = this.allUsagesCache.get(cacheKey);
        if (cached) { return cached; }

        const result = new Map<string, UsageResult[]>();
        const factoryStartPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;

        const addUsage = (key: string, usage: UsageResult) => {
            if (!result.has(key)) { result.set(key, []); }
            result.get(key)!.push(usage);
        };

        for (const file of files) {
            const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
            const lines = content.split('\n');

            let currentFactory = '';
            let currentFactoryLine = 0;
            let insideDepArray = false;

            for (let i = 0; i < lines.length; i++) {
                const text = stripLineComments(lines[i]);

                // Track enclosing factory
                const factoryMatch = text.match(factoryStartPattern);
                if (factoryMatch) {
                    currentFactory = factoryMatch[1];
                    currentFactoryLine = i;
                    insideDepArray = false;
                    continue;
                }

                // Handle []string{ opening — skip struct field assignments like DeleteField: []string{"items"} or "key": []string{...}
                if (/[\w"]\s*:\s*\[\]string\s*\{/.test(text)) { continue; }
                if (/\[\]string\s*\{/.test(text)) {
                    const inlineClose = text.match(/\[\]string\s*\{([^}]*)\}/);
                    if (inlineClose) {
                        // Inline format: []string{"dep1", "dep2"}
                        for (const m of inlineClose[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            const depKey = m[1];
                            addUsage(depKey, {
                                location: new vscode.Location(file, new vscode.Position(currentFactoryLine, 0)),
                                enclosingFactory: currentFactory,
                            });
                        }
                        // Array opened and closed on same line — stay out of multi-line mode
                    } else {
                        // Multi-line format: []string{ on its own, deps follow on next lines
                        insideDepArray = true;
                        // Also capture any dep that starts on the same opening line: []string{"dep1",
                        const afterBrace = text.slice(text.indexOf('{') + 1);
                        for (const m of afterBrace.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            addUsage(m[1], {
                                location: new vscode.Location(file, new vscode.Position(currentFactoryLine, 0)),
                                enclosingFactory: currentFactory,
                            });
                        }
                    }
                    continue;
                }

                // Close multi-line array on a bare } line
                if (insideDepArray && /^\s*\}\s*,?\s*$/.test(text)) {
                    insideDepArray = false;
                    continue;
                }

                // Dep(s) on their own line inside multi-line array — one or more per line
                if (insideDepArray) {
                    for (const m of text.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                        addUsage(m[1], {
                            location: new vscode.Location(file, new vscode.Position(currentFactoryLine, 0)),
                            enclosingFactory: currentFactory,
                        });
                    }
                }
            }
        }

        this.allUsagesCache.set(cacheKey, result);
        return result;
    }

    getFilePrefixFromDocument(document: vscode.TextDocument): string {
        const fileName = document.uri.fsPath.split('/').pop() ?? '';
        const match = fileName.match(/^(.+?)(?:_node|_task)\./);
        return match ? match[1] : '';
    }

    isInsideStringArray(document: vscode.TextDocument, position: vscode.Position): boolean {
        for (let i = position.line - 1; i >= Math.max(0, position.line - 20); i--) {
            const text = stripLineComments(document.lineAt(i).text);
            if (/\[\]string\s*\{/.test(text)) { return true; }
            if (/^\s*\}\s*[,);\s]*$/.test(text)) { return false; }
        }
        return false;
    }

    async findNodeFiles(filePrefix: string): Promise<vscode.Uri[]> {
        const cached = this.nodeFilesCache.get(filePrefix);
        if (cached) { return cached; }
        const glob = filePrefix
            ? `**/node/**/*${filePrefix}*node*.go`
            : '**/node/**/*.go';
        const result = await vscode.workspace.findFiles(glob, '**/vendor/**');
        this.nodeFilesCache.set(filePrefix, result);
        return result;
    }

    async findLazyKey(files: vscode.Uri[], mapKey: string): Promise<string | undefined> {
        const mapPattern = new RegExp(`"${escapeRegex(mapKey)}":\\s*func\\(\\)\\s*model\\.Node`);
        const lazyPattern = /[Ll]azyNodes\["([^"]+)"\]/;

        for (const file of files) {
            const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (mapPattern.test(lines[i])) {
                    for (let j = i; j < Math.min(i + 3, lines.length); j++) {
                        const match = lines[j].match(lazyPattern);
                        if (match) { return match[1]; }
                    }
                }
            }
        }
        return undefined;
    }

    async findFactory(files: vscode.Uri[], lazyKey: string, silent = false): Promise<vscode.Location | undefined> {
        const factoryPattern = new RegExp(`"${escapeRegex(lazyKey)}":\\s*func\\(\\)\\s*model\\.Node\\s*{`);

        for (const file of files) {
            const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (factoryPattern.test(lines[i])) {
                    return new vscode.Location(file, new vscode.Position(i, 0));
                }
            }
        }

        if (!silent) { vscode.window.showWarningMessage(`Node implementation not found for: ${lazyKey}`); }
        return undefined;
    }

    // ── Reorder by Task helpers ──────────────────────────────────────────────

    async findTaskFile(document: vscode.TextDocument): Promise<vscode.Uri | undefined> {
        const fsPath = document.uri.fsPath;
        // Primary: sibling task directory — .../node/sfv_p7_node.go → .../task/sfv_p7_task.go
        const taskPath = fsPath
            .replace(/\/node\//, '/task/')
            .replace(/_node\.go$/, '_task.go');
        if (taskPath !== fsPath) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(taskPath));
                return vscode.Uri.file(taskPath);
            } catch { /* file not found — fall through */ }
        }
        // Fallback: workspace search
        const prefix = this.getFilePrefixFromDocument(document);
        if (prefix) {
            const found = await vscode.workspace.findFiles(
                `**/task/**/*${prefix}*task*.go`,
                '**/vendor/**',
                1
            );
            if (found.length > 0) { return found[0]; }
        }
        return undefined;
    }

    async findPipelineFile(taskUri: vscode.Uri): Promise<vscode.Uri | undefined> {
        const pipelinePath = taskUri.fsPath
            .replace(/\/task\//, '/pipeline/')
            .replace(/_task\.go$/, '_pipeline.go');
        if (pipelinePath !== taskUri.fsPath) {
            try {
                await vscode.workspace.fs.stat(vscode.Uri.file(pipelinePath));
                return vscode.Uri.file(pipelinePath);
            } catch { /* fall through */ }
        }
        const m = taskUri.fsPath.match(/([^/]+)_task\.go$/);
        if (m) {
            const found = await vscode.workspace.findFiles(
                `**/pipeline/**/*${m[1]}*pipeline*.go`,
                '**/vendor/**',
                1
            );
            if (found.length > 0) { return found[0]; }
        }
        return undefined;
    }

    async parsePipelineTaskRefs(pipelineUri: vscode.Uri): Promise<Array<{ taskVar: string; line: number }>> {
        const doc = await vscode.workspace.openTextDocument(pipelineUri);
        const lines = doc.getText().split('\n');
        const refs: Array<{ taskVar: string; line: number }> = [];
        let inPipeline = false;

        for (let i = 0; i < lines.length; i++) {
            if (/\bnewPipeline\(/.test(lines[i])) { inPipeline = true; }
            if (inPipeline) {
                for (const m of lines[i].matchAll(/task\.(\w+Task\d+)/g)) {
                    refs.push({ taskVar: m[1], line: i });
                }
                if (/^\s*\)\s*$/.test(lines[i])) { inPipeline = false; }
            }
        }

        return refs;
    }

    async parseTaskAssignments(taskUri: vscode.Uri): Promise<Set<string>> {
        const doc = await vscode.workspace.openTextDocument(taskUri);
        const assigned = new Set<string>();
        for (const line of doc.getText().split('\n')) {
            const m = line.match(/(\w+Task\d+)\s*=\s*newTask\(/);
            if (m) { assigned.add(m[1]); }
        }
        return assigned;
    }

    async parseTaskGroups(taskUri: vscode.Uri): Promise<TaskGroup[]> {
        const cacheKey = taskUri.fsPath;
        const cached = this.taskGroupsCache.get(cacheKey);
        if (cached) { return cached; }

        // openTextDocument returns the in-memory buffer when the file is open with unsaved changes
        const taskDoc = await vscode.workspace.openTextDocument(taskUri);
        const lines = taskDoc.getText().split('\n');

        const groups: TaskGroup[] = [];
        let currentGroup: TaskGroup | null = null;

        for (const line of lines) {
            // Task assignment start: SfvP7Task1 = newTask(
            const taskMatch = line.match(/\w+Task(\d+)\s*=\s*newTask\(/);
            if (taskMatch) {
                currentGroup = { taskNumber: parseInt(taskMatch[1], 10), publicKeys: [] };
                groups.push(currentGroup);
                // Capture any node refs on the same opening line
                for (const m of line.matchAll(/node\.\w+Node\["([^"]+)"\]\(\)/g)) {
                    currentGroup.publicKeys.push(m[1]);
                }
                continue;
            }
            if (currentGroup) {
                const nodeMatch = line.match(/node\.\w+Node\["([^"]+)"\]\(\)/);
                if (nodeMatch) {
                    currentGroup.publicKeys.push(nodeMatch[1]);
                }
                // End of newTask(...) call
                if (/^\s*\)\s*$/.test(line)) {
                    currentGroup = null;
                }
            }
        }

        groups.sort((a, b) => a.taskNumber - b.taskNumber);
        if (!taskDoc.isDirty) { this.taskGroupsCache.set(cacheKey, groups); }
        return groups;
    }

    parseInitSection(lines: string[]): InitParseResult {
        const entries: InitEntry[] = [];
        let mapStartLine = -1;
        let mapEndLine = -1;
        let inMap = false;
        let depth = 0;

        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];

            if (!inMap) {
                // Locate the public node map: SfvP7Node = map[string]func() model.Node{
                if (/\w+Node\s*=\s*map\[string\]func\(\)\s*model\.Node\s*\{/.test(text)) {
                    mapStartLine = i;
                    inMap = true;
                    depth = 1;
                    continue;
                }
            } else {
                // Track brace depth
                for (const ch of text) {
                    if (ch === '{') { depth++; }
                    else if (ch === '}') { depth--; }
                }
                if (depth <= 0) {
                    mapEndLine = i;
                    break;
                }
                // Parse entry — inline or multi-line
                const funcLineMatch = text.match(/"([A-Z][A-Za-z0-9]*)":\s*func\(\)\s*model\.Node\s*\{/);
                if (funcLineMatch) {
                    const publicKey = funcLineMatch[1];
                    const inlineLazy = text.match(/[Ll]azyNodes\["([^"]+)"\]/);
                    if (inlineLazy) {
                        entries.push({ publicKey, snakeKey: inlineLazy[1], line: i });
                    } else if (i + 1 < lines.length) {
                        const nextLazy = lines[i + 1].match(/[Ll]azyNodes\["([^"]+)"\]/);
                        if (nextLazy) {
                            entries.push({ publicKey, snakeKey: nextLazy[1], line: i + 1 });
                        }
                    }
                }
            }
        }

        return { mapStartLine, mapEndLine, entries };
    }

    parseFactorySection(lines: string[]): FactoryParseResult {
        const factories = new Map<string, string[]>();
        let mapStartLine = -1;
        let mapEndLine = -1;
        let inMap = false;
        let currentKey: string | null = null;
        let currentLines: string[] = [];
        let depth = 0;

        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];

            if (!inMap) {
                if (/var\s+\w+NodeFactories\s*=\s*map\[string\]/.test(text)) {
                    mapStartLine = i;
                    inMap = true;
                    // Count braces on the opening var line (ends with {)
                    for (const ch of text) {
                        if (ch === '{') { depth++; }
                        else if (ch === '}') { depth--; }
                    }
                    continue;
                }
            } else {
                if (currentKey === null) {
                    // At depth 1 (inside the map) — look for factory start or map end
                    const factoryMatch = text.match(
                        /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node\s*\{/
                    );
                    if (factoryMatch) {
                        currentKey = factoryMatch[1];
                        currentLines = [text];
                        for (const ch of text) {
                            if (ch === '{') { depth++; }
                            else if (ch === '}') { depth--; }
                        }
                    } else {
                        for (const ch of text) {
                            if (ch === '{') { depth++; }
                            else if (ch === '}') { depth--; }
                        }
                        if (depth <= 0) {
                            mapEndLine = i;
                            break;
                        }
                    }
                } else {
                    // Inside a factory block — accumulate lines until depth returns to 1
                    currentLines.push(text);
                    for (const ch of text) {
                        if (ch === '{') { depth++; }
                        else if (ch === '}') { depth--; }
                    }
                    if (depth <= 1) {
                        factories.set(currentKey, currentLines);
                        currentKey = null;
                        currentLines = [];
                    }
                }
            }
        }

        return { mapStartLine, mapEndLine, factories };
    }

    async parseTaskGroupsWithLines(taskUri: vscode.Uri): Promise<TaskNodeLineInfo[]> {
        const taskDoc = await vscode.workspace.openTextDocument(taskUri);
        const lines = taskDoc.getText().split('\n');
        const result: TaskNodeLineInfo[] = [];
        let currentTaskNumber = -1;
        let inTask = false;

        for (let i = 0; i < lines.length; i++) {
            const text = lines[i];
            const taskMatch = text.match(/\w+Task(\d+)\s*=\s*newTask\(/);
            if (taskMatch) {
                currentTaskNumber = parseInt(taskMatch[1], 10);
                inTask = true;
                for (const m of text.matchAll(/node\.\w+Node\["([^"]+)"\]\(\)/g)) {
                    result.push({ taskNumber: currentTaskNumber, line: i, publicKey: m[1] });
                }
                continue;
            }
            if (inTask) {
                const nodeMatch = text.match(/node\.\w+Node\["([^"]+)"\]\(\)/);
                if (nodeMatch) {
                    result.push({ taskNumber: currentTaskNumber, line: i, publicKey: nodeMatch[1] });
                }
                if (/^\s*\)\s*$/.test(text)) {
                    inTask = false;
                }
            }
        }

        return result;
    }

    async parseDependenciesByFactory(files: vscode.Uri[]): Promise<Map<string, string[]>> {
        const result = new Map<string, string[]>();
        const factoryStartPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;

        for (const file of files) {
            const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
            const lines = content.split('\n');
            let currentFactory = '';
            let insideDepArray = false;

            for (let i = 0; i < lines.length; i++) {
                const text = stripLineComments(lines[i]);
                const factoryMatch = text.match(factoryStartPattern);
                if (factoryMatch) {
                    currentFactory = factoryMatch[1];
                    if (!result.has(currentFactory)) { result.set(currentFactory, []); }
                    insideDepArray = false;
                    continue;
                }
                // Skip struct field assignments like: DeleteField: []string{"items"} or "key": []string{...}
                if (/[\w"]\s*:\s*\[\]string\s*\{/.test(text)) { continue; }
                if (/\[\]string\s*\{/.test(text)) {
                    const inlineClose = text.match(/\[\]string\s*\{([^}]*)\}/);
                    if (inlineClose) {
                        for (const m of inlineClose[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            result.get(currentFactory)?.push(m[1]);
                        }
                    } else {
                        insideDepArray = true;
                        const afterBrace = text.slice(text.indexOf('{') + 1);
                        for (const m of afterBrace.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            result.get(currentFactory)?.push(m[1]);
                        }
                    }
                    continue;
                }
                if (insideDepArray && /^\s*\}\s*,?\s*$/.test(text)) {
                    insideDepArray = false;
                    continue;
                }
                if (insideDepArray) {
                    for (const m of text.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                        result.get(currentFactory)?.push(m[1]);
                    }
                }
            }
        }

        return result;
    }

    parseNodeDepsWithLines(lines: string[]): Array<{ depKey: string; line: number; factoryKey: string }> {
        const result: Array<{ depKey: string; line: number; factoryKey: string }> = [];
        const factoryStartPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;
        let currentFactory = '';
        let insideDepArray = false;

        for (let i = 0; i < lines.length; i++) {
            const text = stripLineComments(lines[i]);
            const factoryMatch = text.match(factoryStartPattern);
            if (factoryMatch) {
                currentFactory = factoryMatch[1];
                insideDepArray = false;
                continue;
            }
            if (!currentFactory) { continue; }

            // Skip struct field assignments like: DeleteField: []string{"items"} or "key": []string{...}
            if (/[\w"]\s*:\s*\[\]string\s*\{/.test(text)) { continue; }

            if (/\[\]string\s*\{/.test(text)) {
                const inlineClose = text.match(/\[\]string\s*\{([^}]*)\}/);
                if (inlineClose) {
                    for (const m of inlineClose[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                        result.push({ depKey: m[1], line: i, factoryKey: currentFactory });
                    }
                } else {
                    insideDepArray = true;
                    const afterBrace = text.slice(text.indexOf('{') + 1);
                    for (const m of afterBrace.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                        result.push({ depKey: m[1], line: i, factoryKey: currentFactory });
                    }
                }
                continue;
            }
            if (insideDepArray && /^\s*\}\s*,?\s*$/.test(text)) {
                insideDepArray = false;
                continue;
            }
            if (insideDepArray) {
                for (const m of text.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                    result.push({ depKey: m[1], line: i, factoryKey: currentFactory });
                }
            }
        }

        return result;
    }

    async buildSnakeToTaskMap(
        taskUri: vscode.Uri,
        publicToSnake: Map<string, string>,
        factoryKeySet: Set<string>
    ): Promise<Map<string, number>> {
        const taskNodes = await this.parseTaskGroupsWithLines(taskUri);
        const snakeToTask = new Map<string, number>();
        for (const tn of taskNodes) {
            const directSnake = tn.publicKey.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
            const snakeKey = factoryKeySet.has(directSnake) ? directSnake : publicToSnake.get(tn.publicKey);
            if (snakeKey) { snakeToTask.set(snakeKey, tn.taskNumber); }
        }
        return snakeToTask;
    }

    async findSameTaskViolations(taskUri: vscode.Uri): Promise<Array<{
        line: number;
        nodePublicKey: string;
        depSnakeKey: string;
        depPublicKey: string;
        taskNumber: number;
        depTaskNumber: number;
        kind: 'same-task' | 'out-of-order';
    }>> {
        const nodeFilePath = taskUri.fsPath
            .replace(/\/task\//, '/node/')
            .replace(/_task\.go$/, '_node.go');
        const nodeUri = vscode.Uri.file(nodeFilePath);
        try { await vscode.workspace.fs.stat(nodeUri); } catch { return []; }

        const nodeDoc = await vscode.workspace.openTextDocument(nodeUri);
        const nodeLines = nodeDoc.getText().split('\n');
        const initResult = this.parseInitSection(nodeLines);

        const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));
        const snakeToPublic = new Map(initResult.entries.map(e => [e.snakeKey, e.publicKey]));

        const nodeFiles = await this.findNodeFiles(this.getFilePrefixFromDocument(nodeDoc));
        const depsByFactory = await this.parseDependenciesByFactory(nodeFiles);
        const factoryKeySet = new Set(depsByFactory.keys());

        const snakeToTask = await this.buildSnakeToTaskMap(taskUri, publicToSnake, factoryKeySet);
        const taskNodes = await this.parseTaskGroupsWithLines(taskUri);

        const violations: Array<{
            line: number;
            nodePublicKey: string;
            depSnakeKey: string;
            depPublicKey: string;
            taskNumber: number;
            depTaskNumber: number;
            kind: 'same-task' | 'out-of-order';
        }> = [];

        for (const tn of taskNodes) {
            const directSnake = tn.publicKey.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
            const snakeKey = factoryKeySet.has(directSnake) ? directSnake : publicToSnake.get(tn.publicKey);
            if (!snakeKey) { continue; }
            const deps = depsByFactory.get(snakeKey) ?? [];
            for (const dep of deps) {
                const depTask = snakeToTask.get(dep);
                if (depTask === undefined) { continue; }
                if (depTask === tn.taskNumber) {
                    violations.push({
                        line: tn.line,
                        nodePublicKey: tn.publicKey,
                        depSnakeKey: dep,
                        depPublicKey: snakeToPublic.get(dep) ?? dep,
                        taskNumber: tn.taskNumber,
                        depTaskNumber: depTask,
                        kind: 'same-task',
                    });
                } else if (depTask > tn.taskNumber) {
                    violations.push({
                        line: tn.line,
                        nodePublicKey: tn.publicKey,
                        depSnakeKey: dep,
                        depPublicKey: snakeToPublic.get(dep) ?? dep,
                        taskNumber: tn.taskNumber,
                        depTaskNumber: depTask,
                        kind: 'out-of-order',
                    });
                }
            }
        }

        return violations;
    }

    async findNodeNameMismatches(nodeUri: vscode.Uri): Promise<Array<{
        line: number;
        factoryKey: string;
        firstParam: string;
    }>> {
        const doc = await vscode.workspace.openTextDocument(nodeUri);
        const lines = doc.getText().split('\n');
        const factoryPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;
        const mismatches: Array<{ line: number; factoryKey: string; firstParam: string }> = [];

        for (let i = 0; i < lines.length; i++) {
            const factoryMatch = lines[i].match(factoryPattern);
            if (!factoryMatch) { continue; }
            const factoryKey = factoryMatch[1];

            // Find newNode( within the next ~10 lines
            for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
                if (!/\bnewNode\(/.test(lines[j])) { continue; }

                // Check rest of the newNode( line for first string arg
                const afterOpen = lines[j].slice(lines[j].indexOf('newNode(') + 'newNode('.length);
                const sameLineStr = afterOpen.match(/"([a-z][a-z0-9_]*)"/);
                if (sameLineStr) {
                    if (sameLineStr[1] !== factoryKey) {
                        mismatches.push({ line: j, factoryKey, firstParam: sameLineStr[1] });
                    }
                    break;
                }

                // First arg is on a subsequent line
                for (let k = j + 1; k <= Math.min(j + 3, lines.length - 1); k++) {
                    const nextStr = lines[k].match(/^\s*"([a-z][a-z0-9_]*)"/);
                    if (nextStr) {
                        if (nextStr[1] !== factoryKey) {
                            mismatches.push({ line: k, factoryKey, firstParam: nextStr[1] });
                        }
                        break;
                    }
                    if (/\bnewNode\(|func\(\)|return\b/.test(lines[k])) { break; }
                }
                break;
            }
        }

        return mismatches;
    }

    buildNewInitBody(taskGroups: TaskGroup[], entries: InitEntry[], lazyPrefix: string): string {
        const entryMap = new Map<string, InitEntry>();
        for (const e of entries) { entryMap.set(e.publicKey, e); }

        const coveredPublicKeys = new Set(taskGroups.flatMap(g => g.publicKeys));
        const coveredKeys = new Set<string>();
        const outputLines: string[] = [];

        // Nodes not assigned to any task — shown first
        const uncovered = entries.filter(e => !coveredPublicKeys.has(e.publicKey));
        if (uncovered.length > 0) {
            outputLines.push(`\t\t// (no task)`);
            const maxLen = Math.max(...uncovered.map(e => e.publicKey.length));
            for (const entry of uncovered) {
                const pad = ' '.repeat(maxLen - entry.publicKey.length + 1);
                outputLines.push(
                    `\t\t"${entry.publicKey}":${pad}func() model.Node { return ${lazyPrefix}LazyNodes["${entry.snakeKey}"].Get() },`
                );
            }
        }

        for (const group of taskGroups) {
            // Find entries for this task group that actually exist in the node file
            const groupEntries = group.publicKeys
                .map(pk => entryMap.get(pk))
                .filter((e): e is InitEntry => e !== undefined);

            if (groupEntries.length === 0) { continue; }

            outputLines.push(`\t\t// Task ${group.taskNumber}`);

            // Per-task column alignment
            const maxLen = Math.max(...groupEntries.map(e => e.publicKey.length));

            for (const entry of groupEntries) {
                coveredKeys.add(entry.publicKey);
                const pad = ' '.repeat(maxLen - entry.publicKey.length + 1);
                outputLines.push(
                    `\t\t"${entry.publicKey}":${pad}func() model.Node { return ${lazyPrefix}LazyNodes["${entry.snakeKey}"].Get() },`
                );
            }
        }

        return outputLines.join('\n');
    }

    buildNewFactoryBody(orderedSnakeKeys: string[], factories: Map<string, string[]>): string {
        const outputLines: string[] = [];
        const seen = new Set<string>();

        for (const key of orderedSnakeKeys) {
            const block = factories.get(key);
            if (block) {
                outputLines.push(...block);
                seen.add(key);
            }
        }

        // Append any factories not in the ordered list
        for (const [key, block] of factories) {
            if (!seen.has(key)) {
                outputLines.push(...block);
            }
        }

        return outputLines.join('\n');
    }

    // ── DAG creation helpers ─────────────────────────────────────────────────

    snakeToPascal(s: string): string {
        return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    }

    snakeToCamel(s: string): string {
        const p = this.snakeToPascal(s);
        return p.charAt(0).toLowerCase() + p.slice(1);
    }

    snakeToUpper(s: string): string {
        return s.toUpperCase();
    }

    snakeToHyphen(s: string): string {
        return s.replace(/_/g, '-');
    }

    async findDagRoot(): Promise<vscode.Uri | undefined> {
        const found = await vscode.workspace.findFiles('**/*_dag.go', '**/vendor/**', 1);
        if (found.length === 0) { return undefined; }
        return vscode.Uri.joinPath(found[0], '..');
    }

    async findExistingDags(): Promise<{ prefix: string; dagUri: vscode.Uri }[]> {
        const files = await vscode.workspace.findFiles('**/*_dag.go', '**/vendor/**');
        return files
            .map(f => {
                const name = f.fsPath.split('/').pop() ?? '';
                const prefix = name.replace(/_dag\.go$/, '');
                return { prefix, dagUri: f };
            })
            .filter(d => d.prefix.length > 0);
    }

    async findDagConstantsFile(): Promise<vscode.Uri | undefined> {
        const files = await vscode.workspace.findFiles('**/constant/*.go', '**/vendor/**');
        for (const f of files) {
            const content = Buffer.from(await vscode.workspace.fs.readFile(f)).toString('utf8');
            if (/_NAME\s*=\s*"/.test(content)) { return f; }
        }
        return undefined;
    }

    async addDagConstant(file: vscode.Uri, prefix: string): Promise<void> {
        const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');
        const lines = content.split('\n');

        // Find the last closing ) of a const block that contains _NAME constants
        let insertLine = -1;
        let inConstBlock = false;
        for (let i = 0; i < lines.length; i++) {
            if (/^\s*const\s*\(/.test(lines[i])) { inConstBlock = true; }
            if (inConstBlock && /_NAME\s*=\s*"/.test(lines[i])) {
                // Keep scanning to find the closing ) of this block
                for (let j = i + 1; j < lines.length; j++) {
                    if (/^\s*\)\s*$/.test(lines[j])) {
                        insertLine = j;
                        break;
                    }
                }
                break;
            }
        }

        if (insertLine < 0) { return; }

        const upper = this.snakeToUpper(prefix);
        const hyphen = this.snakeToHyphen(prefix);
        const newLine = `\t${upper}_NAME = "${hyphen}"`;

        const edit = new vscode.WorkspaceEdit();
        edit.insert(file, new vscode.Position(insertLine, 0), newLine + '\n');
        await vscode.workspace.applyEdit(edit);
    }

    async detectGoModule(): Promise<string> {
        const mods = await vscode.workspace.findFiles('**/go.mod', '**/vendor/**', 1);
        if (mods.length === 0) { return 'your-module'; }
        const content = Buffer.from(await vscode.workspace.fs.readFile(mods[0])).toString('utf8');
        const match = content.match(/^module\s+(\S+)/m);
        return match ? match[1] : 'your-module';
    }

    buildNewDagTemplates(prefix: string, modulePath: string): Record<string, string> {
        const pascal = this.snakeToPascal(prefix);
        const camel = this.snakeToCamel(prefix);
        const upper = this.snakeToUpper(prefix);

        return {
            dag: [
                'package dag',
                '',
                'import (',
                `\t"${modulePath}/internal/constant"`,
                `\t"${modulePath}/internal/dag/pipeline"`,
                `\t"${modulePath}/internal/model"`,
                ')',
                '',
                'func init() {',
                `\tdag := newDag(constant.${upper}_NAME, pipeline.${pascal}Pipeline, model.JsonSchemaValidation{`,
                '\t\tProperties: map[string]*model.SchemaProperty{},',
                '\t\tRequired:   []string{},',
                '\t})',
                '\taddDag(dag)',
                '}',
                '',
            ].join('\n'),

            pipeline: [
                'package pipeline',
                '',
                'import (',
                `\t"${modulePath}/internal/dag/task"`,
                `\t"${modulePath}/internal/model"`,
                ')',
                '',
                `var ${pascal}Pipeline model.Pipeline`,
                '',
                'func init() {',
                `\t${pascal}Pipeline = newPipeline(`,
                `\t\ttask.${pascal}Task1,`,
                '\t)',
                '}',
                '',
            ].join('\n'),

            task: [
                'package task',
                '',
                'import (',
                `\t"${modulePath}/internal/dag/node"`,
                `\t"${modulePath}/internal/model"`,
                ')',
                '',
                'var (',
                `\t${pascal}Task1 model.Task`,
                ')',
                '',
                'func init() {',
                `\t${pascal}Task1 = newTask(`,
                `\t\tnode.${pascal}Node["ExampleNode"](),`,
                '\t)',
                '}',
                '',
            ].join('\n'),

            node: [
                'package node',
                '',
                'import (',
                `\t"${modulePath}/internal/model"`,
                ')',
                '',
                'var (',
                `\t${camel}LazyNodes = make(map[string]*lazyNode)`,
                `\t${pascal}Node     map[string]func() model.Node`,
                ')',
                '',
                'func init() {',
                `\tfor name, function := range ${camel}NodeFactories {`,
                `\t\t${camel}LazyNodes[name] = newLazyNode(function)`,
                '\t}',
                `\t${pascal}Node = map[string]func() model.Node{`,
                `\t\t// Task 1`,
                `\t\t"ExampleNode": func() model.Node { return ${camel}LazyNodes["example_node"].Get() },`,
                '\t}',
                '}',
                '',
                '// Implement node here',
                `var ${camel}NodeFactories = map[string]func() model.Node{`,
                '\t"example_node": func() model.Node {',
                '\t\treturn newNode(',
                '\t\t\t"example_node",',
                '\t\t\t"",',
                '\t\t\t[]string{},',
                '\t\t\tnil,',
                '\t\t\t[]*model.FnDetail{},',
                '\t\t\tmodel.Cache{},',
                '\t\t\tmodel.ExprValidation{},',
                '\t\t)',
                '\t},',
                '}',
                '',
            ].join('\n'),
        };
    }

    substitutePrefix(
        content: string,
        oldPrefix: string,
        newPrefix: string,
        overrideOldPascal?: string,
        overrideOldCamel?: string,
    ): string {
        const oldPascal = overrideOldPascal ?? this.snakeToPascal(oldPrefix);
        const newPascal = this.snakeToPascal(newPrefix);
        const oldCamel  = overrideOldCamel  ?? this.snakeToCamel(oldPrefix);
        const newCamel  = this.snakeToCamel(newPrefix);
        const oldUpper  = this.snakeToUpper(oldPrefix);
        const newUpper  = this.snakeToUpper(newPrefix);
        const oldHyphen = this.snakeToHyphen(oldPrefix);
        const newHyphen = this.snakeToHyphen(newPrefix);

        let result = content;

        // PascalCase first (uses actual form detected from node file, e.g. Pp2 not PP2)
        result = result.replaceAll(oldPascal, newPascal);

        // UPPER_SNAKE: PP2 → MY_DAG
        // Normalize _DAG_NAME → _NAME when copying from a DAG that uses that convention.
        result = result.replaceAll(`${oldUpper}_DAG_NAME`, `${newUpper}_NAME`);
        if (oldUpper !== oldPascal) {
            result = result.replaceAll(oldUpper, newUpper);
        }

        if (oldCamel === oldPrefix) {
            // camelCase form is identical to raw prefix (no underscores, e.g. "pp2").
            // Use context to distinguish: camelCase usage is followed by an uppercase letter
            // (e.g. pp2LazyNodes, pp2NodeFactories) while raw/string usage is not
            // (e.g. "pp2:seen_item").
            result = result.replace(
                new RegExp(`${escapeRegex(oldCamel)}([A-Z])`, 'g'),
                `${newCamel}$1`
            );
            result = result.replaceAll(oldPrefix, newPrefix);
        } else {
            result = result.replaceAll(oldCamel, newCamel);
            if (oldHyphen !== oldCamel && oldHyphen !== oldPrefix) {
                result = result.replaceAll(oldHyphen, newHyphen);
            }
            result = result.replaceAll(oldPrefix, newPrefix);
        }

        return result;
    }

    async writeNewDagFiles(
        dagRoot: vscode.Uri,
        prefix: string,
        contents: Record<string, string>
    ): Promise<vscode.Uri[]> {
        const uris: vscode.Uri[] = [
            vscode.Uri.joinPath(dagRoot, `${prefix}_dag.go`),
            vscode.Uri.joinPath(dagRoot, 'pipeline', `${prefix}_pipeline.go`),
            vscode.Uri.joinPath(dagRoot, 'task', `${prefix}_task.go`),
            vscode.Uri.joinPath(dagRoot, 'node', `${prefix}_node.go`),
        ];
        const keys = ['dag', 'pipeline', 'task', 'node'];

        for (let i = 0; i < uris.length; i++) {
            await vscode.workspace.fs.writeFile(
                uris[i],
                Buffer.from(contents[keys[i]], 'utf8')
            );
        }
        return uris;
    }
}

class NodeDefinitionProvider implements vscode.DefinitionProvider {
    constructor(private helper: NodeNavigatorHelper) {}

    async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location | undefined> {
        const line = stripLineComments(document.lineAt(position).text);
        const filePrefix = this.helper.getFilePrefixFromDocument(document);

        const taskMatch = line.match(/node\.[A-Za-z0-9]+Node\["([^"]+)"\]/);
        if (taskMatch) {
            const files = await this.helper.findNodeFiles(filePrefix);
            const lazyKey = await this.helper.findLazyKey(files, taskMatch[1]);
            if (!lazyKey) { vscode.window.showWarningMessage(`Node map entry not found for: ${taskMatch[1]}`); return undefined; }
            return this.helper.findFactory(files, lazyKey);
        }

        // Inline deps: []string{"dep1", "dep2"} — navigate whichever string the cursor is on
        if (/\[\]string\s*\{/.test(line)) {
            const col = position.character;
            for (const m of [...line.matchAll(/"([a-z][a-z0-9_]*)"/g)]) {
                if (col >= m.index! && col <= m.index! + m[0].length) {
                    const files = await this.helper.findNodeFiles(filePrefix);
                    return this.helper.findFactory(files, m[1]);
                }
            }
        }

        // Multi-line dep — one or more strings on their own line(s) inside []string{ ... }
        if (this.helper.isInsideStringArray(document, position)) {
            const col = position.character;
            for (const m of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                if (col >= m.index! && col <= m.index! + m[0].length) {
                    const files = await this.helper.findNodeFiles(filePrefix);
                    return this.helper.findFactory(files, m[1]);
                }
            }
        }

        const nodeMapMatch = line.match(/"([^"]+)":\s*func\(\)\s*model\.Node/);
        if (nodeMapMatch) {
            const mapKey = nodeMapMatch[1];
            // Snake_case key = this IS the factory line — already here, do nothing
            if (/^[a-z]/.test(mapKey)) { return undefined; }
            // PascalCase key = public map entry → navigate to factory
            const files = await this.helper.findNodeFiles(filePrefix);
            const lazyKeyInLine = line.match(/[Ll]azyNodes\["([^"]+)"\]/);
            if (lazyKeyInLine) { return this.helper.findFactory(files, lazyKeyInLine[1]); }
            const lazyKey = await this.helper.findLazyKey(files, mapKey);
            if (!lazyKey) { vscode.window.showWarningMessage(`Node map entry not found for: ${mapKey}`); return undefined; }
            return this.helper.findFactory(files, lazyKey);
        }

        return undefined;
    }
}

class NodeHoverProvider implements vscode.HoverProvider {
    constructor(private helper: NodeNavigatorHelper) {}

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        _token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const lazyKey = await this.helper.resolveNodeKey(document, position);
        if (!lazyKey) { return undefined; }

        const filePrefix = this.helper.getFilePrefixFromDocument(document);
        const files = await this.helper.findNodeFiles(filePrefix);
        const [factory, usages] = await Promise.all([
            this.helper.findFactory(files, lazyKey, true),
            this.helper.findUsages(files, lazyKey),
        ]);

        const lines: string[] = [`**${lazyKey}**`, '---'];
        lines.push(factory ? `Node implemented: \`${lazyKey}\`` : 'Node implementation not found');
        if (usages.length === 0) {
            lines.push('');
        } else {
            lines.push(`Dependents (${usages.length}):`);
            for (const u of usages) { lines.push(`- \`${u.enclosingFactory}\``); }
        }

        return new vscode.Hover(new vscode.MarkdownString(lines.join('\n\n')));
    }
}

class NodeReferenceProvider implements vscode.ReferenceProvider {
    constructor(private helper: NodeNavigatorHelper) {}

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        _context: vscode.ReferenceContext,
        _token: vscode.CancellationToken
    ): Promise<vscode.Location[]> {
        const lazyKey = await this.helper.resolveNodeKey(document, position);
        if (!lazyKey) { return []; }

        const filePrefix = this.helper.getFilePrefixFromDocument(document);
        const files = await this.helper.findNodeFiles(filePrefix);
        const usages = await this.helper.findUsages(files, lazyKey);
        return usages.map(u => u.location);
    }
}

// Shows task assignment and dependent count above each factory entry.
class NodeCodeLensProvider implements vscode.CodeLensProvider {
    constructor(private helper: NodeNavigatorHelper) {}

    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const filePrefix = this.helper.getFilePrefixFromDocument(document);
        if (!filePrefix) { return []; }

        // Collect all factory entries in this document
        const factories: { line: number; key: string }[] = [];
        const factoryPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;
        for (let i = 0; i < document.lineCount; i++) {
            const m = document.lineAt(i).text.match(factoryPattern);
            if (m) { factories.push({ line: i, key: m[1] }); }
        }
        if (factories.length === 0) { return []; }

        // Parse init section to know which factory keys are registered in the public map
        const docLines = document.getText().split('\n');
        const initResult = this.helper.parseInitSection(docLines);
        const snakeKeysInInit = new Set(initResult.entries.map(e => e.snakeKey));

        // Build snakeKey → {taskNumber, publicKeys} map from task file
        const snakeToTask = new Map<string, { taskNumber: number; publicKeys: string[] }>();
        try {
            const taskUri = await this.helper.findTaskFile(document);
            if (taskUri) {
                const taskGroups = await this.helper.parseTaskGroups(taskUri);
                const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));
                const factoryKeySet = new Set(factories.map(f => f.key));

                for (const group of taskGroups) {
                    for (const pk of group.publicKeys) {
                        const directSnake = pk.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
                        const snakeKey = factoryKeySet.has(directSnake) ? directSnake : publicToSnake.get(pk);
                        if (snakeKey) {
                            snakeToTask.set(snakeKey, {
                                taskNumber: group.taskNumber,
                                publicKeys: group.publicKeys,
                            });
                        }
                    }
                }
            }
        } catch { /* task file unavailable — skip task CodeLens */ }

        // One scan for all dependent usages
        const files = await this.helper.findNodeFiles(filePrefix);
        const allUsages = await this.helper.findAllUsages(files);

        const lenses: vscode.CodeLens[] = [];
        for (const f of factories) {
            const range = new vscode.Range(f.line, 0, f.line, 0);

            // Task CodeLens
            const taskInfo = snakeToTask.get(f.key);
            if (taskInfo) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(list-tree) Task ${taskInfo.taskNumber}`,
                    command: 'dagon.showTaskNodes',
                    arguments: [taskInfo.taskNumber, taskInfo.publicKeys, document],
                    tooltip: `Task ${taskInfo.taskNumber}: ${taskInfo.publicKeys.join(', ')}`,
                }));
            } else if (snakeKeysInInit.has(f.key)) {
                lenses.push(new vscode.CodeLens(range, {
                    title: `$(list-tree) No task`,
                    command: 'dagon.openTaskFile',
                    arguments: [document],
                    tooltip: 'Not assigned to any task — click to open task file',
                }));
            }

            // Dependents CodeLens
            const usages = allUsages.get(f.key) ?? [];
            if (usages.length > 0) {
                lenses.push(
                  new vscode.CodeLens(range, {
                    title: `$(type-hierarchy) ${usages.length} dependent${usages.length > 1 ? "s" : ""}`,
                    command: "dagon.findUsagesFor",
                    arguments: [f.key, document],
                    tooltip: usages.map((u) => u.enclosingFactory).join(", "),
                  }),
                );
            }
        }

        return lenses;
    }
}

export function deactivate() {}
