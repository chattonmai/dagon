import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(here, '../dist/server.js');

const nodeText = [
    'package node',
    '',
    'var shopLazyNodes = make(map[string]*lazyNode)',
    'var ShopNode map[string]func() model.Node',
    '',
    'func init() {',
    '\tShopNode = map[string]func() model.Node{',
    '\t\t"LoadUser": func() model.Node { return shopLazyNodes["load_user"].Get() },',
    '\t\t"CheckUser": func() model.Node { return shopLazyNodes["check_user"].Get() },',
    '\t}',
    '}',
    '',
    'var shopNodeFactories = map[string]func() model.Node{',
    '\t"load_user": func() model.Node {',
    '\t\treturn newNode("load_user", "", []string{}, nil)',
    '\t},',
    '\t"check_user": func() model.Node {',
    '\t\treturn newNode(',
    '\t\t\t"check_user",',
    '\t\t\t"",',
    '\t\t\t[]string{',
    '\t\t\t\t"load_user",',
    '\t\t\t},',
    '\t\t\tnil,',
    '\t\t)',
    '\t},',
    '}',
    '',
].join('\n');

const taskText = [
    'package task',
    '',
    'func init() {',
    '\tShopTask1 = newTask(',
    '\t\tnode.ShopNode["LoadUser"](),',
    '\t\tnode.ShopNode["CheckUser"](),',
    '\t)',
    '}',
    '',
].join('\n');

function lineOf(text, needle) {
    const line = text.split('\n').findIndex(entry => entry.includes(needle));
    if (line < 0) { throw new Error(`missing ${needle}`); }
    return line;
}

class Rpc {
    constructor(child) {
        this.child = child;
        this.buf = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();
        this.notes = [];
        child.stdout.on('data', chunk => this.onData(chunk));
        child.stderr.on('data', chunk => process.stderr.write(chunk));
    }

    onData(chunk) {
        this.buf = Buffer.concat([this.buf, chunk]);
        for (;;) {
            const headerEnd = this.buf.indexOf('\r\n\r\n');
            if (headerEnd < 0) { return; }
            const header = this.buf.slice(0, headerEnd).toString('utf8');
            const match = header.match(/Content-Length: (\d+)/i);
            if (!match) { throw new Error(`bad header: ${header}`); }
            const length = Number(match[1]);
            const start = headerEnd + 4;
            if (this.buf.length < start + length) { return; }
            const body = JSON.parse(this.buf.slice(start, start + length).toString('utf8'));
            this.buf = this.buf.slice(start + length);
            this.onMessage(body);
        }
    }

    onMessage(message) {
        if (message.id !== undefined && message.method) {
            this.send({ jsonrpc: '2.0', id: message.id, result: null });
            return;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
            this.pending.get(message.id)(message);
            this.pending.delete(message.id);
            return;
        }
        if (message.method) { this.notes.push(message); }
    }

    send(obj) {
        const json = JSON.stringify(obj);
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 8000);
            this.pending.set(id, message => {
                clearTimeout(timer);
                if (message.error) { reject(new Error(JSON.stringify(message.error))); return; }
                resolve(message.result);
            });
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method, params) {
        this.send({ jsonrpc: '2.0', method, params });
    }

    async waitFor(predicate) {
        const start = Date.now();
        while (Date.now() - start < 8000) {
            const found = this.notes.find(predicate);
            if (found) { return found; }
            await new Promise(resolve => setTimeout(resolve, 30));
        }
        throw new Error(`timed out. notes: ${this.notes.map(note => note.method).join(', ')}`);
    }
}

function assert(condition, message) {
    if (!condition) { throw new Error(message); }
}

const root = await mkdtemp(path.join(tmpdir(), 'dagon-ls-'));
const nodePath = path.join(root, 'internal/dag/node/shop_node.go');
const taskPath = path.join(root, 'internal/dag/task/shop_task.go');
const dagPath = path.join(root, 'internal/dag/shop_dag.go');
await mkdir(path.dirname(nodePath), { recursive: true });
await mkdir(path.dirname(taskPath), { recursive: true });
await writeFile(nodePath, nodeText);
await writeFile(taskPath, taskText);
await writeFile(dagPath, 'package dag\n');
await writeFile(path.join(root, 'go.mod'), 'module example.com/shop\n\ngo 1.22\n');

const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
const rpc = new Rpc(child);
const rootUri = pathToFileURL(root).href;

try {
    const init = await rpc.request('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
            window: { showDocument: { support: true } },
            workspace: {
                applyEdit: true,
                workspaceFolders: true,
                didChangeWatchedFiles: { dynamicRegistration: true },
            },
            textDocument: {
                definition: {},
                hover: {},
                references: {},
                codeAction: {},
                codeLens: {},
                synchronization: {},
            },
        },
        workspaceFolders: [{ uri: rootUri, name: 'fixture' }],
    });
    assert(init.capabilities.definitionProvider === true, 'definition provider missing');
    rpc.notify('initialized', {});

    const nodeUri = pathToFileURL(nodePath).href;
    const taskUri = pathToFileURL(taskPath).href;
    rpc.notify('textDocument/didOpen', {
        textDocument: { uri: nodeUri, languageId: 'go', version: 1, text: nodeText },
    });
    rpc.notify('textDocument/didOpen', {
        textDocument: { uri: taskUri, languageId: 'go', version: 1, text: taskText },
    });

    const published = await rpc.waitFor(note =>
        note.method === 'textDocument/publishDiagnostics'
        && note.params.diagnostics.some(item => /same task/.test(item.message)),
    );
    assert(published.params.diagnostics[0].source === 'dagon', 'diagnostic source');

    const taskLine = taskText.split('\n')[lineOf(taskText, '["LoadUser"]')];
    const definition = await rpc.request('textDocument/definition', {
        textDocument: { uri: taskUri },
        position: { line: lineOf(taskText, '["LoadUser"]'), character: taskLine.indexOf('LoadUser') },
    });
    assert(definition && definition.uri === nodeUri, `definition uri ${definition && definition.uri}`);
    assert(definition.range.start.line === lineOf(nodeText, '"load_user": func()'), 'definition line');

    const ordinary = await rpc.request('textDocument/definition', {
        textDocument: { uri: taskUri },
        position: { line: 0, character: 0 },
    });
    assert(ordinary === null, 'ordinary Go identifier must not get a fake location');

    const actions = await rpc.request('textDocument/codeAction', {
        textDocument: { uri: nodeUri },
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        context: { diagnostics: [] },
    });
    const reorder = actions.find(action => action.title === 'Reorganize nodes by task');
    assert(reorder, 'reorder code action missing');
    const edits = Object.values(reorder.edit.changes).flat();
    assert(edits.some(edit => edit.newText.includes('// Task 1')), 'reorder edit missing task group');
    assert(edits.some(edit => edit.newText.includes('shopLazyNodes["load_user"]')), 'reorder edit missing factory link');

    console.log('lsp-driver: ok');
} finally {
    child.kill();
    await rm(root, { recursive: true, force: true });
}
