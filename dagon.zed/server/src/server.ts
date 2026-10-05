import { mkdir, readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
    DagonEngine,
    type DagonDiagnostic,
    type DiagnosticUpdate,
    type FileStore,
    buildNewDagTemplates,
    constantInsert,
    dagFiles,
    definitionAt,
    detectNaming,
    diagnosticUpdates,
    factoryAnnotations,
    filePrefix,
    hoverMarkdown,
    isSnakeName,
    isVendorPath,
    matchGlob,
    normalizeDagName,
    parentDir,
    planReorder,
    referenceLocations,
    resolveNodeKey,
    substitutePrefix,
} from './engine';
import {
    CodeActionKind,
    CreateFile,
    DiagnosticSeverity,
    DidChangeWatchedFilesNotification,
    ProposedFeatures,
    TextDocumentEdit,
    TextDocumentSyncKind,
    TextDocuments,
    TextEdit,
    createConnection,
    type CodeAction,
    type CodeLens,
    type Diagnostic,
    type InitializeParams,
    type WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const DEBOUNCE_MS = 200;

let folders: string[] = [];
let fileList: string[] | undefined;
let watchDynamically = false;
const published = new Map<string, Map<string, Diagnostic[]>>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const files: FileStore = {
    async read(filePath: string) {
        const open = documents.get(toUri(filePath));
        if (open) { return open.getText(); }
        try {
            return await readFile(filePath, 'utf8');
        } catch {
            return undefined;
        }
    },
    async find(glob: string, maxResults?: number) {
        const disk = await allFiles();
        const open = documents.all().map(doc => toPath(doc.uri));
        const matched = [...new Set([...open, ...disk])].filter(filePath => !isVendorPath(filePath) && matchGlob(glob, filePath));
        return maxResults === undefined ? matched : matched.slice(0, maxResults);
    },
};

const engine = new DagonEngine(files);

function toPath(uri: string): string {
    return fileURLToPath(uri);
}

function toUri(filePath: string): string {
    return pathToFileURL(filePath).href;
}

async function walk(dir: string, out: string[]): Promise<void> {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (entry.name === 'vendor' || entry.name === 'node_modules' || entry.name === '.git') { continue; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(full, out);
        } else {
            out.push(full);
        }
    }
}

async function allFiles(): Promise<string[]> {
    if (fileList) { return fileList; }
    const out: string[] = [];
    for (const folder of folders) {
        await walk(folder, out);
    }
    fileList = out;
    return out;
}

function relative(filePath: string): string {
    for (const folder of folders) {
        if (filePath.startsWith(folder + path.sep) || filePath.startsWith(folder + '/')) {
            return filePath.slice(folder.length + 1);
        }
    }
    return filePath;
}

function toDiagnostic(code: string, item: DagonDiagnostic): Diagnostic {
    return {
        range: item.range,
        message: item.message,
        severity: item.severity === 'warning' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
        source: 'dagon',
        code,
    };
}

function applyUpdates(updates: DiagnosticUpdate[]) {
    const touched = new Set<string>();
    for (const update of updates) {
        let codes = published.get(update.path);
        if (!codes) {
            codes = new Map();
            published.set(update.path, codes);
        }
        codes.set(update.code, update.diagnostics.map(item => toDiagnostic(update.code, item)));
        touched.add(update.path);
    }
    for (const filePath of touched) {
        const flat = [...(published.get(filePath)?.values() ?? [])].flat();
        void connection.sendDiagnostics({ uri: toUri(filePath), diagnostics: flat });
    }
}

async function publishFor(uri: string) {
    const filePath = toPath(uri);
    if (!filePath.endsWith('_task.go') && !filePath.endsWith('_node.go') && !filePath.endsWith('_pipeline.go')) { return; }
    engine.invalidateForFile(filePath);
    try {
        applyUpdates(await diagnosticUpdates(engine, filePath));
    } catch {
        // A partial buffer must not take down the server.
    }
}

function schedule(uri: string) {
    const pending = timers.get(uri);
    if (pending) { clearTimeout(pending); }
    timers.set(uri, setTimeout(() => {
        timers.delete(uri);
        void publishFor(uri);
    }, DEBOUNCE_MS));
}

function publishNow(uri: string) {
    const pending = timers.get(uri);
    if (pending) { clearTimeout(pending); }
    timers.delete(uri);
    void publishFor(uri);
}

async function show(filePath: string, line = 0) {
    await connection.sendRequest('window/showDocument', {
        uri: toUri(filePath),
        external: false,
        takeFocus: true,
        selection: {
            start: { line, character: 0 },
            end: { line, character: 0 },
        },
    });
}

function replaceAll(text: string, newText: string): TextEdit {
    const lines = text.split('\n');
    const last = Math.max(0, lines.length - 1);
    return TextEdit.replace(
        { start: { line: 0, character: 0 }, end: { line: last, character: lines[last]?.length ?? 0 } },
        newText,
    );
}

async function writeMapped(contents: Record<string, string>) {
    const documentChanges: NonNullable<WorkspaceEdit['documentChanges']> = [];
    for (const [filePath, text] of Object.entries(contents)) {
        await mkdir(path.dirname(filePath), { recursive: true });
        const uri = toUri(filePath);
        const existing = await files.read(filePath);
        const doc = documents.get(uri);
        if (existing === undefined) {
            documentChanges.push(CreateFile.create(uri, { overwrite: true }));
            documentChanges.push(TextDocumentEdit.create({ uri, version: null }, [
                TextEdit.insert({ line: 0, character: 0 }, text),
            ]));
        } else {
            documentChanges.push(TextDocumentEdit.create({ uri, version: doc?.version ?? null }, [
                replaceAll(existing, text),
            ]));
        }
    }
    let applied = false;
    try {
        applied = (await connection.workspace.applyEdit({ documentChanges })).applied;
    } catch {
        applied = false;
    }
    if (!applied) {
        for (const [filePath, text] of Object.entries(contents)) {
            await mkdir(path.dirname(filePath), { recursive: true });
            await writeFile(filePath, text, 'utf8');
        }
    }
    fileList = undefined;
    engine.invalidateAll();
}

async function insertConstant(prefix: string) {
    const constFile = await engine.findDagConstantsFile();
    if (!constFile) {
        void connection.window.showWarningMessage('Constant file not found — add constant manually');
        return;
    }
    const content = await files.read(constFile) ?? '';
    const insert = constantInsert(content, prefix);
    if (!insert) { return; }
    const uri = toUri(constFile);
    const doc = documents.get(uri);
    const edit: WorkspaceEdit = {
        documentChanges: [
            TextDocumentEdit.create({ uri, version: doc?.version ?? null }, [
                TextEdit.insert({ line: insert.line, character: 0 }, insert.newText),
            ]),
        ],
    };
    try {
        const result = await connection.workspace.applyEdit(edit);
        if (!result.applied) {
            const lines = content.split('\n');
            lines.splice(insert.line, 0, insert.newText.replace(/\n$/, ''));
            await writeFile(constFile, lines.join('\n'), 'utf8');
        }
    } catch {
        const lines = content.split('\n');
        lines.splice(insert.line, 0, insert.newText.replace(/\n$/, ''));
        await writeFile(constFile, lines.join('\n'), 'utf8');
    }
}

async function createDag(name: string) {
    const dagRoot = await engine.findDagRoot();
    if (!dagRoot) {
        void connection.window.showWarningMessage('No dag/ directory found in workspace');
        return;
    }
    const modulePath = await engine.detectGoModule();
    const templates = buildNewDagTemplates(name, modulePath);
    const targets = dagFiles(dagRoot, name);
    await writeMapped({
        [targets.dag]: templates.dag,
        [targets.pipeline]: templates.pipeline,
        [targets.task]: templates.task,
        [targets.node]: templates.node,
    });
    await insertConstant(name);
    for (const filePath of [targets.dag, targets.pipeline, targets.task, targets.node]) {
        await show(filePath, 0);
    }
    void connection.window.showInformationMessage(`Created DAG "${name}" (4 files + constant)`);
}

async function cloneDag(oldPrefix: string, newName: string, sourceDagPath: string) {
    const dagRoot = parentDir(sourceDagPath);
    const sources = dagFiles(dagRoot, oldPrefix);
    const nodeRaw = await files.read(sources.node);
    const naming: { pascal?: string; camel?: string } = nodeRaw !== undefined ? detectNaming(nodeRaw) : {};
    const contents: Record<string, string> = {};
    for (const filePath of [sources.dag, sources.pipeline, sources.task, sources.node]) {
        const raw = await files.read(filePath);
        if (raw === undefined) {
            void connection.window.showWarningMessage(`Could not read ${filePath}`);
            return;
        }
        contents[filePath] = substitutePrefix(raw, oldPrefix, newName, naming.pascal, naming.camel);
    }
    const targets = dagFiles(dagRoot, newName);
    await writeMapped({
        [targets.dag]: contents[sources.dag],
        [targets.pipeline]: contents[sources.pipeline],
        [targets.task]: contents[sources.task],
        [targets.node]: contents[sources.node],
    });
    await insertConstant(newName);
    for (const filePath of [targets.dag, targets.pipeline, targets.task, targets.node]) {
        await show(filePath, 0);
    }
    void connection.window.showInformationMessage(`Created DAG "${newName}" from "${oldPrefix}" (4 files + constant)`);
}

function dagNameFromSelection(text: string): string | undefined {
    const trimmed = text.trim().replace(/^["'`]|["'`]$/g, '');
    if (!isSnakeName(trimmed)) { return undefined; }
    const name = normalizeDagName(trimmed);
    return isSnakeName(name) ? name : undefined;
}

connection.onInitialize((params: InitializeParams) => {
    folders = (params.workspaceFolders ?? []).map(folder => toPath(folder.uri));
    if (folders.length === 0 && params.rootUri) { folders = [toPath(params.rootUri)]; }
    watchDynamically = params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true,
            codeLensProvider: { resolveProvider: false },
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.Refactor, CodeActionKind.QuickFix],
            },
            executeCommandProvider: {
                commands: [
                    'dagon.showTask',
                    'dagon.openDependent',
                    'dagon.openTaskFile',
                    'dagon.openFiles',
                    'dagon.showDocument',
                    'dagon.createDag',
                    'dagon.cloneDag',
                ],
            },
        },
    };
});

connection.onInitialized(() => {
    if (!watchDynamically) { return; }
    void connection.client.register(DidChangeWatchedFilesNotification.type, {
        watchers: [
            { globPattern: '**/*_node.go' },
            { globPattern: '**/*_task.go' },
            { globPattern: '**/*_dag.go' },
        ],
    });
});

documents.onDidOpen(event => publishNow(event.document.uri));
documents.onDidChangeContent(event => {
    engine.invalidateForFile(toPath(event.document.uri));
    schedule(event.document.uri);
});
documents.onDidSave(event => {
    fileList = undefined;
    publishNow(event.document.uri);
});

connection.onDidChangeWatchedFiles(params => {
    fileList = undefined;
    for (const change of params.changes) {
        engine.invalidateForFile(toPath(change.uri));
    }
    for (const doc of documents.all()) {
        publishNow(doc.uri);
    }
});

connection.onDefinition(async params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return null; }
    const result = await definitionAt(engine, toPath(doc.uri), doc.getText(), params.position);
    if (result.warning) { void connection.window.showWarningMessage(result.warning); }
    if (!result.location) { return null; }
    return {
        uri: toUri(result.location.path),
        range: result.location.range,
    };
});

connection.onHover(async params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return null; }
    const markdown = await hoverMarkdown(engine, toPath(doc.uri), doc.getText(), params.position);
    if (!markdown) { return null; }
    return { contents: { kind: 'markdown', value: markdown } };
});

connection.onReferences(async params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return null; }
    const key = await resolveNodeKey(engine, toPath(doc.uri), doc.getText(), params.position);
    if (!key) { return null; }
    const locations = await referenceLocations(engine, toPath(doc.uri), doc.getText(), params.position);
    return locations.map(location => ({ uri: toUri(location.path), range: location.range }));
});

connection.onCodeLens(async params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return []; }
    const annotations = await factoryAnnotations(engine, toPath(doc.uri), doc.getText());
    const lenses: CodeLens[] = [];
    for (const annotation of annotations) {
        const range = {
            start: { line: annotation.line, character: 0 },
            end: { line: annotation.line, character: 0 },
        };
        if (annotation.task && annotation.taskPath) {
            lenses.push({
                range,
                command: {
                    title: `Task ${annotation.task.taskNumber}`,
                    command: 'dagon.showTask',
                    arguments: [annotation.taskPath, annotation.task.line],
                },
            });
        } else if (annotation.inInit && annotation.taskPath) {
            lenses.push({
                range,
                command: {
                    title: 'No task',
                    command: 'dagon.openTaskFile',
                    arguments: [annotation.taskPath],
                },
            });
        }
        if (annotation.dependents.length > 0) {
            const count = annotation.dependents.length;
            const first = annotation.dependents[0];
            lenses.push({
                range,
                command: {
                    title: `${count} dependent${count > 1 ? 's' : ''}`,
                    command: 'dagon.openDependent',
                    arguments: [first.location.path, first.location.range.start.line],
                },
            });
        }
    }
    return lenses;
});

connection.onCodeAction(async params => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) { return []; }
    const filePath = toPath(doc.uri);
    const text = doc.getText();
    const actions: CodeAction[] = [];

    const defined = await definitionAt(engine, filePath, text, params.range.start);
    if (defined.location) {
        actions.push({
            title: 'Go to node implementation',
            kind: CodeActionKind.QuickFix,
            command: {
                title: 'Go to node implementation',
                command: 'dagon.showDocument',
                arguments: [defined.location.path, defined.location.range.start.line],
            },
        });
    }

    const key = await resolveNodeKey(engine, filePath, text, params.range.start);
    if (key) {
        const locations = await referenceLocations(engine, filePath, text, params.range.start);
        const seen = new Set<string>();
        for (const location of locations) {
            const label = `${location.path}:${location.range.start.line}`;
            if (seen.has(label)) { continue; }
            seen.add(label);
            const factory = (await factoryNameAt(location.path, location.range.start.line)) ?? key;
            actions.push({
                title: `Open dependent: ${factory}`,
                kind: CodeActionKind.QuickFix,
                command: {
                    title: `Open dependent: ${factory}`,
                    command: 'dagon.showDocument',
                    arguments: [location.path, location.range.start.line],
                },
            });
        }
    }

    if (filePath.endsWith('_node.go')) {
        const taskFile = await engine.findTaskFile(filePath);
        const taskText = taskFile ? await files.read(taskFile) : undefined;
        if (taskText !== undefined) {
            const planned = planReorder(text, taskText, filePrefix(filePath));
            if (planned.ok) {
                const edits: TextEdit[] = [
                    TextEdit.replace(
                        {
                            start: { line: planned.plan.init.startLine, character: 0 },
                            end: { line: planned.plan.init.endLine, character: 0 },
                        },
                        planned.plan.init.newText,
                    ),
                ];
                if (planned.plan.factory) {
                    edits.push(TextEdit.replace(
                        {
                            start: { line: planned.plan.factory.startLine, character: 0 },
                            end: { line: planned.plan.factory.endLine, character: 0 },
                        },
                        planned.plan.factory.newText,
                    ));
                }
                actions.push({
                    title: 'Reorganize nodes by task',
                    kind: CodeActionKind.Refactor,
                    edit: { changes: { [doc.uri]: edits } },
                });
            }
        }
    }

    const dags = await engine.findExistingDags();
    for (const dag of dags) {
        const targets = dagFiles(parentDir(dag.path), dag.prefix);
        actions.push({
            title: `Open DAG: ${dag.prefix}`,
            kind: CodeActionKind.Refactor,
            command: {
                title: `Open DAG: ${dag.prefix}`,
                command: 'dagon.openFiles',
                arguments: [[targets.dag, targets.pipeline, targets.task, targets.node]],
            },
        });
    }

    const name = dagNameFromSelection(doc.getText(params.range));
    if (name) {
        actions.push({
            title: 'Create DAG from selection',
            kind: CodeActionKind.Refactor,
            command: {
                title: 'Create DAG from selection',
                command: 'dagon.createDag',
                arguments: [name],
            },
        });
        for (const dag of dags) {
            actions.push({
                title: `Create DAG from ${dag.prefix} using selection`,
                kind: CodeActionKind.Refactor,
                command: {
                    title: `Create DAG from ${dag.prefix} using selection`,
                    command: 'dagon.cloneDag',
                    arguments: [dag.prefix, name, dag.path],
                },
            });
        }
    }

    return actions;
});

async function factoryNameAt(filePath: string, line: number): Promise<string | undefined> {
    const text = await files.read(filePath);
    if (text === undefined) { return undefined; }
    const match = text.split('\n')[line]?.match(/"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/);
    return match?.[1];
}

connection.onExecuteCommand(async params => {
    const args = params.arguments ?? [];
    switch (params.command) {
        case 'dagon.showDocument':
        case 'dagon.showTask':
        case 'dagon.openDependent':
        case 'dagon.openTaskFile':
            await show(String(args[0] ?? ''), Number(args[1] ?? 0));
            return;
        case 'dagon.openFiles': {
            const paths = Array.isArray(args[0]) ? args[0].map(String) : [];
            let opened = 0;
            let prefix = '';
            for (const filePath of paths) {
                if (await files.read(filePath) === undefined) {
                    void connection.window.showWarningMessage(`File not found: ${relative(filePath)}`);
                    continue;
                }
                if (!prefix) {
                    const base = path.basename(filePath);
                    prefix = base.replace(/_(?:dag|pipeline|task|node)\.go$/, '');
                }
                await show(filePath, 0);
                opened++;
            }
            if (opened > 0) {
                void connection.window.showInformationMessage(`Opened ${opened} file(s) for DAG "${prefix}"`);
            }
            return;
        }
        case 'dagon.createDag':
            await createDag(String(args[0] ?? ''));
            return;
        case 'dagon.cloneDag':
            await cloneDag(String(args[0] ?? ''), String(args[1] ?? ''), String(args[2] ?? ''));
            return;
        default:
            return;
    }
});

documents.listen(connection);
connection.listen();
