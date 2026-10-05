// Pure DAG engine. No editor types. Hosts supply file reads and publish the results.

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    path: string;
    range: Range;
}

export interface FileStore {
    /** Text of an absolute path. Undefined when the file does not exist. Prefer an unsaved buffer. */
    read(path: string): Promise<string | undefined>;
    /** Workspace-relative glob. Implementations skip vendor directories. */
    find(glob: string, maxResults?: number): Promise<string[]>;
}

export interface Usage {
    location: Location;
    enclosingFactory: string;
}

export interface TaskGroup {
    taskNumber: number;
    publicKeys: string[];
}

export interface InitEntry {
    publicKey: string;
    snakeKey: string;
    line?: number;
}

export interface InitParseResult {
    mapStartLine: number;
    mapEndLine: number;
    entries: InitEntry[];
}

export interface TaskNodeLineInfo {
    taskNumber: number;
    line: number;
    publicKey: string;
}

export interface FactoryParseResult {
    mapStartLine: number;
    mapEndLine: number;
    factories: Map<string, string[]>;
}

export interface DagonDiagnostic {
    range: Range;
    message: string;
    severity: 'error' | 'warning';
}

export interface DiagnosticUpdate {
    code: string;
    path: string;
    diagnostics: DagonDiagnostic[];
}

export interface LineReplace {
    startLine: number;
    endLine: number;
    newText: string;
}

export interface ReorderPlan {
    init: LineReplace;
    factory?: LineReplace;
    nodeCount: number;
    taskCount: number;
}

export interface FactoryAnnotation {
    line: number;
    key: string;
    inInit: boolean;
    taskPath?: string;
    task?: { taskNumber: number; publicKeys: string[]; line: number };
    dependents: Usage[];
}

export interface DagFiles {
    dag: string;
    pipeline: string;
    task: string;
    node: string;
}

export function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Remove a trailing `//` line comment and any inline `/* */` comments from a single
// line, while respecting double-quoted ("...") and raw (`...`) string literals.
// Operates per line; multi-line /* */ blocks are not tracked across lines.
export function stripLineComments(line: string): string {
    let result = '';
    let inString = false;
    let inRawString = false;
    let inBlock = false;

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
        if (ch === '/' && next === '/') { break; }
        if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
        if (ch === '"') { inString = true; result += ch; continue; }
        if (ch === '`') { inRawString = true; result += ch; continue; }
        result += ch;
    }

    return result;
}

// A double-star slash is an optional directory prefix. A double star matches across
// slashes. A single star stays inside one path segment.
export function globToRegExp(glob: string): RegExp {
    let source = '';
    for (let i = 0; i < glob.length; i++) {
        const ch = glob[i];
        if (ch === '*') {
            if (glob[i + 1] === '*') {
                if (glob[i + 2] === '/') {
                    source += '(?:.*/)?';
                    i += 2;
                } else {
                    source += '.*';
                    i += 1;
                }
            } else {
                source += '[^/]*';
            }
            continue;
        }
        source += escapeRegex(ch);
    }
    return new RegExp(`^${source}$`);
}

export function matchGlob(glob: string, path: string): boolean {
    return globToRegExp(glob).test(path);
}

export function isVendorPath(path: string): boolean {
    return path.split('/').includes('vendor');
}

export function filePrefix(path: string): string {
    const fileName = path.split('/').pop() ?? '';
    const match = fileName.match(/^(.+?)(?:_node|_task)\./);
    return match ? match[1] : '';
}

export function parentDir(path: string): string {
    const i = path.lastIndexOf('/');
    return i >= 0 ? path.slice(0, i) : path;
}

export function fileNameOf(path: string): string {
    return path.split('/').pop() ?? '';
}

export function locationAt(path: string, line: number, character = 0): Location {
    return {
        path,
        range: {
            start: { line, character },
            end: { line, character },
        },
    };
}

export function normalizeDagName(raw: string): string {
    return raw
        .replace(/^dag_?/, '')
        .replace(/_?dag$/, '')
        .replace(/_dag_/g, '_')
        .replace(/^_+|_+$/g, '');
}

export function isSnakeName(name: string): boolean {
    return /^[a-z][a-z0-9_]*$/.test(name);
}

export function snakeToPascal(s: string): string {
    return s.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

export function snakeToCamel(s: string): string {
    const p = snakeToPascal(s);
    return p.charAt(0).toLowerCase() + p.slice(1);
}

export function snakeToUpper(s: string): string {
    return s.toUpperCase();
}

export function snakeToHyphen(s: string): string {
    return s.replace(/_/g, '-');
}

export function goModulePath(goModText: string | undefined): string {
    if (!goModText) { return 'your-module'; }
    const match = goModText.match(/^module\s+(\S+)/m);
    return match ? match[1] : 'your-module';
}

export function dagFiles(dagRoot: string, prefix: string): DagFiles {
    return {
        dag: `${dagRoot}/${prefix}_dag.go`,
        pipeline: `${dagRoot}/pipeline/${prefix}_pipeline.go`,
        task: `${dagRoot}/task/${prefix}_task.go`,
        node: `${dagRoot}/node/${prefix}_node.go`,
    };
}

export function detectNaming(nodeText: string): { pascal?: string; camel?: string } {
    return {
        pascal: nodeText.match(/\b([A-Z][A-Za-z0-9]*)Node\b/)?.[1],
        camel: nodeText.match(/\b([a-z][A-Za-z0-9]*)LazyNodes\b/)?.[1],
    };
}

export function memoryStore(files: Record<string, string>): FileStore {
    const entries = Object.entries(files);
    return {
        async read(path: string) {
            return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;
        },
        async find(glob: string, maxResults?: number) {
            const matched = entries
                .map(([p]) => p)
                .filter(p => !isVendorPath(p) && matchGlob(glob, p));
            return maxResults === undefined ? matched : matched.slice(0, maxResults);
        },
    };
}

export class DagonEngine {
    private nodeFilesCache = new Map<string, string[]>();
    private allUsagesCache = new Map<string, Map<string, Usage[]>>();

    constructor(readonly files: FileStore) {}

    invalidateForFile(fsPath: string) {
        if (fsPath.endsWith('_node.go')) {
            const name = fsPath.split('/').pop() ?? '';
            const m = name.match(/^(.+?)_node\.go$/);
            if (m) { this.nodeFilesCache.delete(m[1]); }
            this.nodeFilesCache.delete('');
            this.allUsagesCache.clear();
        } else if (fsPath.endsWith('.go')) {
            this.nodeFilesCache.clear();
        }
    }

    invalidateAll() {
        this.nodeFilesCache.clear();
        this.allUsagesCache.clear();
    }

    async findNodeFiles(filePrefixValue: string): Promise<string[]> {
        const cached = this.nodeFilesCache.get(filePrefixValue);
        if (cached) { return cached; }
        const glob = filePrefixValue
            ? `**/node/**/*${filePrefixValue}*node*.go`
            : '**/node/**/*.go';
        const result = (await this.files.find(glob)).filter(p => !isVendorPath(p));
        this.nodeFilesCache.set(filePrefixValue, result);
        return result;
    }

    async findLazyKey(paths: string[], mapKey: string): Promise<string | undefined> {
        const mapPattern = new RegExp(`"${escapeRegex(mapKey)}":\\s*func\\(\\)\\s*model\\.Node`);
        const lazyPattern = /[Ll]azyNodes\["([^"]+)"\]/;

        for (const file of paths) {
            const content = await this.files.read(file);
            if (content === undefined) { continue; }
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

    async findFactory(paths: string[], lazyKey: string): Promise<Location | undefined> {
        const factoryPattern = new RegExp(`"${escapeRegex(lazyKey)}":\\s*func\\(\\)\\s*model\\.Node\\s*{`);

        for (const file of paths) {
            const content = await this.files.read(file);
            if (content === undefined) { continue; }
            const lines = content.split('\n');
            for (let i = 0; i < lines.length; i++) {
                if (factoryPattern.test(lines[i])) {
                    return locationAt(file, i, 0);
                }
            }
        }
        return undefined;
    }

    async findUsages(paths: string[], lazyKey: string): Promise<Usage[]> {
        const allUsages = await this.findAllUsages(paths);
        return allUsages.get(lazyKey) ?? [];
    }

    async findAllUsages(paths: string[]): Promise<Map<string, Usage[]>> {
        const cacheKey = [...paths].sort().join('\0');
        const cached = this.allUsagesCache.get(cacheKey);
        if (cached) { return cached; }

        const result = new Map<string, Usage[]>();
        const factoryStartPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;

        const addUsage = (key: string, usage: Usage) => {
            if (!result.has(key)) { result.set(key, []); }
            result.get(key)!.push(usage);
        };

        for (const file of paths) {
            const content = await this.files.read(file);
            if (content === undefined) { continue; }
            const lines = content.split('\n');

            let currentFactory = '';
            let currentFactoryLine = 0;
            let insideDepArray = false;

            for (let i = 0; i < lines.length; i++) {
                const text = stripLineComments(lines[i]);

                const factoryMatch = text.match(factoryStartPattern);
                if (factoryMatch) {
                    currentFactory = factoryMatch[1];
                    currentFactoryLine = i;
                    insideDepArray = false;
                    continue;
                }

                if (/[\w"]\s*:\s*\[\]string\s*\{/.test(text)) { continue; }
                if (/\[\]string\s*\{/.test(text)) {
                    const inlineClose = text.match(/\[\]string\s*\{([^}]*)\}/);
                    if (inlineClose) {
                        for (const m of inlineClose[1].matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            addUsage(m[1], {
                                location: locationAt(file, currentFactoryLine, 0),
                                enclosingFactory: currentFactory,
                            });
                        }
                    } else {
                        insideDepArray = true;
                        const afterBrace = text.slice(text.indexOf('{') + 1);
                        for (const m of afterBrace.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
                            addUsage(m[1], {
                                location: locationAt(file, currentFactoryLine, 0),
                                enclosingFactory: currentFactory,
                            });
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
                        addUsage(m[1], {
                            location: locationAt(file, currentFactoryLine, 0),
                            enclosingFactory: currentFactory,
                        });
                    }
                }
            }
        }

        this.allUsagesCache.set(cacheKey, result);
        return result;
    }

    async findTaskFile(fsPath: string): Promise<string | undefined> {
        const taskPath = fsPath
            .replace(/\/node\//, '/task/')
            .replace(/_node\.go$/, '_task.go');
        if (taskPath !== fsPath) {
            if (await this.files.read(taskPath) !== undefined) { return taskPath; }
        }
        const prefix = filePrefix(fsPath);
        if (prefix) {
            const found = await this.files.find(`**/task/**/*${prefix}*task*.go`, 1);
            if (found.length > 0) { return found[0]; }
        }
        return undefined;
    }

    async findPipelineFile(taskPath: string): Promise<string | undefined> {
        const pipelinePath = taskPath
            .replace(/\/task\//, '/pipeline/')
            .replace(/_task\.go$/, '_pipeline.go');
        if (pipelinePath !== taskPath) {
            if (await this.files.read(pipelinePath) !== undefined) { return pipelinePath; }
        }
        const m = taskPath.match(/([^/]+)_task\.go$/);
        if (m) {
            const found = await this.files.find(`**/pipeline/**/*${m[1]}*pipeline*.go`, 1);
            if (found.length > 0) { return found[0]; }
        }
        return undefined;
    }

    async parseTaskGroups(taskPath: string): Promise<TaskGroup[]> {
        const text = await this.files.read(taskPath);
        if (text === undefined) { return []; }
        return parseTaskGroups(text.split('\n'));
    }

    async parseTaskGroupsWithLines(taskPath: string): Promise<TaskNodeLineInfo[]> {
        const text = await this.files.read(taskPath);
        if (text === undefined) { return []; }
        return parseTaskGroupsWithLines(text.split('\n'));
    }

    async parsePipelineTaskRefs(pipelinePath: string): Promise<Array<{ taskVar: string; line: number }>> {
        const text = await this.files.read(pipelinePath);
        if (text === undefined) { return []; }
        return parsePipelineTaskRefs(text.split('\n'));
    }

    async parseTaskAssignments(taskPath: string): Promise<Set<string>> {
        const text = await this.files.read(taskPath);
        if (text === undefined) { return new Set(); }
        return parseTaskAssignments(text.split('\n'));
    }

    async parseDependenciesByFactory(paths: string[]): Promise<Map<string, string[]>> {
        const result = new Map<string, string[]>();
        const factoryStartPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;

        for (const file of paths) {
            const content = await this.files.read(file);
            if (content === undefined) { continue; }
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

    async buildSnakeToTaskMap(
        taskPath: string,
        publicToSnake: Map<string, string>,
        factoryKeySet: Set<string>
    ): Promise<Map<string, number>> {
        const taskNodes = await this.parseTaskGroupsWithLines(taskPath);
        const snakeToTask = new Map<string, number>();
        for (const tn of taskNodes) {
            const snakeKey = snakeForPublicKey(tn.publicKey, publicToSnake, factoryKeySet);
            if (snakeKey) { snakeToTask.set(snakeKey, tn.taskNumber); }
        }
        return snakeToTask;
    }

    async findSameTaskViolations(taskPath: string): Promise<Array<{
        line: number;
        nodePublicKey: string;
        depSnakeKey: string;
        depPublicKey: string;
        taskNumber: number;
        depTaskNumber: number;
        kind: 'same-task' | 'out-of-order';
    }>> {
        const nodeFilePath = taskPath
            .replace(/\/task\//, '/node/')
            .replace(/_task\.go$/, '_node.go');
        if (await this.files.read(nodeFilePath) === undefined) { return []; }

        const nodeText = await this.files.read(nodeFilePath);
        if (nodeText === undefined) { return []; }
        const nodeLines = nodeText.split('\n');
        const initResult = parseInitSection(nodeLines);

        const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));
        const snakeToPublic = new Map(initResult.entries.map(e => [e.snakeKey, e.publicKey]));

        const nodeFiles = await this.findNodeFiles(filePrefix(nodeFilePath));
        const depsByFactory = await this.parseDependenciesByFactory(nodeFiles);
        const factoryKeySet = new Set(depsByFactory.keys());

        const snakeToTask = await this.buildSnakeToTaskMap(taskPath, publicToSnake, factoryKeySet);
        const taskNodes = await this.parseTaskGroupsWithLines(taskPath);

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
            const snakeKey = snakeForPublicKey(tn.publicKey, publicToSnake, factoryKeySet);
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

    async findNodeNameMismatches(nodePath: string): Promise<Array<{
        line: number;
        factoryKey: string;
        firstParam: string;
    }>> {
        const text = await this.files.read(nodePath);
        if (text === undefined) { return []; }
        return findNodeNameMismatches(text.split('\n'));
    }

    async findDagRoot(): Promise<string | undefined> {
        const found = await this.files.find('**/*_dag.go', 1);
        if (found.length === 0) { return undefined; }
        return parentDir(found[0]);
    }

    async findExistingDags(): Promise<{ prefix: string; path: string }[]> {
        const paths = await this.files.find('**/*_dag.go');
        return paths
            .map(p => {
                const name = fileNameOf(p);
                const prefix = name.replace(/_dag\.go$/, '');
                return { prefix, path: p };
            })
            .filter(d => d.prefix.length > 0);
    }

    async findDagConstantsFile(): Promise<string | undefined> {
        const paths = await this.files.find('**/constant/*.go');
        for (const p of paths) {
            const content = await this.files.read(p);
            if (content !== undefined && /_NAME\s*=\s*"/.test(content)) { return p; }
        }
        return undefined;
    }

    async detectGoModule(): Promise<string> {
        const mods = await this.files.find('**/go.mod', 1);
        if (mods.length === 0) { return 'your-module'; }
        return goModulePath(await this.files.read(mods[0]));
    }
}

export function parseInitSection(lines: string[]): InitParseResult {
    const entries: InitEntry[] = [];
    let mapStartLine = -1;
    let mapEndLine = -1;
    let inMap = false;
    let depth = 0;

    for (let i = 0; i < lines.length; i++) {
        const text = lines[i];

        if (!inMap) {
            if (/\w+Node\s*=\s*map\[string\]func\(\)\s*model\.Node\s*\{/.test(text)) {
                mapStartLine = i;
                inMap = true;
                depth = 1;
                continue;
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

export function parseFactorySection(lines: string[]): FactoryParseResult {
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
                for (const ch of text) {
                    if (ch === '{') { depth++; }
                    else if (ch === '}') { depth--; }
                }
                continue;
            }
        } else {
            if (currentKey === null) {
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

export function parseTaskGroups(lines: string[]): TaskGroup[] {
    const groups: TaskGroup[] = [];
    let currentGroup: TaskGroup | null = null;

    for (const line of lines) {
        const taskMatch = line.match(/\w+Task(\d+)\s*=\s*newTask\(/);
        if (taskMatch) {
            currentGroup = { taskNumber: parseInt(taskMatch[1], 10), publicKeys: [] };
            groups.push(currentGroup);
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
            if (/^\s*\)\s*$/.test(line)) {
                currentGroup = null;
            }
        }
    }

    groups.sort((a, b) => a.taskNumber - b.taskNumber);
    return groups;
}

export function parseTaskGroupsWithLines(lines: string[]): TaskNodeLineInfo[] {
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

export function parsePipelineTaskRefs(lines: string[]): Array<{ taskVar: string; line: number }> {
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

export function parseTaskAssignments(lines: string[]): Set<string> {
    const assigned = new Set<string>();
    for (const line of lines) {
        const m = line.match(/(\w+Task\d+)\s*=\s*newTask\(/);
        if (m) { assigned.add(m[1]); }
    }
    return assigned;
}

export function parseNodeDepsWithLines(lines: string[]): Array<{ depKey: string; line: number; factoryKey: string }> {
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

export function findNodeNameMismatches(lines: string[]): Array<{
    line: number;
    factoryKey: string;
    firstParam: string;
}> {
    const factoryPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;
    const mismatches: Array<{ line: number; factoryKey: string; firstParam: string }> = [];

    for (let i = 0; i < lines.length; i++) {
        const factoryMatch = lines[i].match(factoryPattern);
        if (!factoryMatch) { continue; }
        const factoryKey = factoryMatch[1];

        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
            if (!/\bnewNode\(/.test(lines[j])) { continue; }

            const afterOpen = lines[j].slice(lines[j].indexOf('newNode(') + 'newNode('.length);
            const sameLineStr = afterOpen.match(/"([a-z][a-z0-9_]*)"/);
            if (sameLineStr) {
                if (sameLineStr[1] !== factoryKey) {
                    mismatches.push({ line: j, factoryKey, firstParam: sameLineStr[1] });
                }
                break;
            }

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

export function isInsideStringArray(lines: string[], line: number): boolean {
    for (let i = line - 1; i >= Math.max(0, line - 20); i--) {
        const text = stripLineComments(lines[i]);
        if (/\[\]string\s*\{/.test(text)) { return true; }
        if (/^\s*\}\s*[,);\s]*$/.test(text)) { return false; }
    }
    return false;
}

export function buildNewInitBody(taskGroups: TaskGroup[], entries: InitEntry[], lazyPrefix: string): string {
    const entryMap = new Map<string, InitEntry>();
    for (const e of entries) { entryMap.set(e.publicKey, e); }

    const coveredPublicKeys = new Set(taskGroups.flatMap(g => g.publicKeys));
    const outputLines: string[] = [];

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
        const groupEntries = group.publicKeys
            .map(pk => entryMap.get(pk))
            .filter((e): e is InitEntry => e !== undefined);

        if (groupEntries.length === 0) { continue; }

        outputLines.push(`\t\t// Task ${group.taskNumber}`);
        const maxLen = Math.max(...groupEntries.map(e => e.publicKey.length));

        for (const entry of groupEntries) {
            const pad = ' '.repeat(maxLen - entry.publicKey.length + 1);
            outputLines.push(
                `\t\t"${entry.publicKey}":${pad}func() model.Node { return ${lazyPrefix}LazyNodes["${entry.snakeKey}"].Get() },`
            );
        }
    }

    return outputLines.join('\n');
}

export function buildNewFactoryBody(orderedSnakeKeys: string[], factories: Map<string, string[]>): string {
    const outputLines: string[] = [];
    const seen = new Set<string>();

    for (const key of orderedSnakeKeys) {
        const block = factories.get(key);
        if (block) {
            outputLines.push(...block);
            seen.add(key);
        }
    }

    for (const [key, block] of factories) {
        if (!seen.has(key)) {
            outputLines.push(...block);
        }
    }

    return outputLines.join('\n');
}

export function planReorder(
    nodeText: string,
    taskText: string,
    prefix = '',
): { ok: true; plan: ReorderPlan } | { ok: false; error: string } {
    const taskGroups = parseTaskGroups(taskText.split('\n'));
    if (taskGroups.length === 0) {
        return { ok: false, error: 'No task groups found in task file' };
    }

    const lines = nodeText.split('\n');
    const initResult = parseInitSection(lines);
    const factoryResult = parseFactorySection(lines);
    if (initResult.mapStartLine < 0) {
        return { ok: false, error: 'Could not find public node map in init()' };
    }

    const lazyVarMatch = nodeText.match(/\b([a-zA-Z][a-zA-Z0-9]*)[Ll]azyNodes\[/);
    const lazyPrefix = lazyVarMatch
        ? lazyVarMatch[1]
        : prefix.replace(/_([a-z0-9])/g, (_: string, c: string) => c.toUpperCase());

    const newInitBody = buildNewInitBody(taskGroups, initResult.entries, lazyPrefix);

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

    const plan: ReorderPlan = {
        init: {
            startLine: initResult.mapStartLine + 1,
            endLine: initResult.mapEndLine,
            newText: newInitBody + '\n',
        },
        nodeCount: initResult.entries.length,
        taskCount: taskGroups.length,
    };

    if (factoryResult.mapStartLine >= 0 && factoryResult.mapEndLine >= 0) {
        plan.factory = {
            startLine: factoryResult.mapStartLine + 1,
            endLine: factoryResult.mapEndLine,
            newText: buildNewFactoryBody(orderedSnakeKeys, factoryResult.factories) + '\n',
        };
    }

    return { ok: true, plan };
}

export function buildNewDagTemplates(prefix: string, modulePath: string): Record<keyof DagFiles, string> {
    const pascal = snakeToPascal(prefix);
    const camel = snakeToCamel(prefix);
    const upper = snakeToUpper(prefix);

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

export function substitutePrefix(
    content: string,
    oldPrefix: string,
    newPrefix: string,
    overrideOldPascal?: string,
    overrideOldCamel?: string,
): string {
    const oldPascal = overrideOldPascal ?? snakeToPascal(oldPrefix);
    const newPascal = snakeToPascal(newPrefix);
    const oldCamel = overrideOldCamel ?? snakeToCamel(oldPrefix);
    const newCamel = snakeToCamel(newPrefix);
    const oldUpper = snakeToUpper(oldPrefix);
    const newUpper = snakeToUpper(newPrefix);
    const oldHyphen = snakeToHyphen(oldPrefix);
    const newHyphen = snakeToHyphen(newPrefix);

    let result = content;

    result = result.replaceAll(oldPascal, newPascal);

    // UPPER_SNAKE. Normalize _DAG_NAME → _NAME when the source uses that form.
    result = result.replaceAll(`${oldUpper}_DAG_NAME`, `${newUpper}_NAME`);
    if (oldUpper !== oldPascal) {
        result = result.replaceAll(oldUpper, newUpper);
    }

    if (oldCamel === oldPrefix) {
        // camelCase is identical to the raw prefix (no underscores, e.g. "pp2").
        // camelCase usage is followed by an uppercase letter (pp2LazyNodes).
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

export function constantInsert(content: string, prefix: string): { line: number; newText: string } | undefined {
    const lines = content.split('\n');
    let insertLine = -1;
    let inConstBlock = false;
    for (let i = 0; i < lines.length; i++) {
        if (/^\s*const\s*\(/.test(lines[i])) { inConstBlock = true; }
        if (inConstBlock && /_NAME\s*=\s*"/.test(lines[i])) {
            for (let j = i + 1; j < lines.length; j++) {
                if (/^\s*\)\s*$/.test(lines[j])) {
                    insertLine = j;
                    break;
                }
            }
            break;
        }
    }
    if (insertLine < 0) { return undefined; }
    const upper = snakeToUpper(prefix);
    const hyphen = snakeToHyphen(prefix);
    return { line: insertLine, newText: `\t${upper}_NAME = "${hyphen}"\n` };
}

export async function resolveNodeKey(
    engine: DagonEngine,
    path: string,
    text: string,
    position: Position
): Promise<string | undefined> {
    const lines = text.split('\n');
    const line = stripLineComments(lines[position.line] ?? '');
    const prefix = filePrefix(path);

    const factoryMatch = line.match(/"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/);
    if (factoryMatch) { return factoryMatch[1]; }

    if (isInsideStringArray(lines, position.line)) {
        const col = position.character;
        for (const m of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
            if (col >= m.index! && col <= m.index! + m[0].length) { return m[1]; }
        }
    }

    const taskMatch = line.match(/node\.[A-Za-z0-9]+Node\["([^"]+)"\]/);
    if (taskMatch) {
        const files = await engine.findNodeFiles(prefix);
        return engine.findLazyKey(files, taskMatch[1]);
    }

    const lazyRefMatch = line.match(/[Ll]azyNodes\["([^"]+)"\]/);
    if (lazyRefMatch) { return lazyRefMatch[1]; }

    const mapMatch = line.match(/"([A-Z][A-Za-z0-9]*)":\s*func\(\)\s*model\.Node/);
    if (mapMatch) {
        const files = await engine.findNodeFiles(prefix);
        return engine.findLazyKey(files, mapMatch[1]);
    }

    return undefined;
}

export async function definitionAt(
    engine: DagonEngine,
    path: string,
    text: string,
    position: Position
): Promise<{ location?: Location; warning?: string }> {
    const lines = text.split('\n');
    const line = stripLineComments(lines[position.line] ?? '');
    const prefix = filePrefix(path);

    const taskMatch = line.match(/node\.[A-Za-z0-9]+Node\["([^"]+)"\]/);
    if (taskMatch) {
        const files = await engine.findNodeFiles(prefix);
        const lazyKey = await engine.findLazyKey(files, taskMatch[1]);
        if (!lazyKey) { return { warning: `Node map entry not found for: ${taskMatch[1]}` }; }
        const location = await engine.findFactory(files, lazyKey);
        if (!location) { return { warning: `Node implementation not found for: ${lazyKey}` }; }
        return { location };
    }

    if (/\[\]string\s*\{/.test(line)) {
        const col = position.character;
        for (const m of [...line.matchAll(/"([a-z][a-z0-9_]*)"/g)]) {
            if (col >= m.index! && col <= m.index! + m[0].length) {
                const files = await engine.findNodeFiles(prefix);
                const location = await engine.findFactory(files, m[1]);
                if (!location) { return { warning: `Node implementation not found for: ${m[1]}` }; }
                return { location };
            }
        }
    }

    if (isInsideStringArray(lines, position.line)) {
        const col = position.character;
        for (const m of line.matchAll(/"([a-z][a-z0-9_]*)"/g)) {
            if (col >= m.index! && col <= m.index! + m[0].length) {
                const files = await engine.findNodeFiles(prefix);
                const location = await engine.findFactory(files, m[1]);
                if (!location) { return { warning: `Node implementation not found for: ${m[1]}` }; }
                return { location };
            }
        }
    }

    const nodeMapMatch = line.match(/"([^"]+)":\s*func\(\)\s*model\.Node/);
    if (nodeMapMatch) {
        const mapKey = nodeMapMatch[1];
        if (/^[a-z]/.test(mapKey)) { return {}; }
        const files = await engine.findNodeFiles(prefix);
        const lazyKeyInLine = line.match(/[Ll]azyNodes\["([^"]+)"\]/);
        const lazyKey = lazyKeyInLine ? lazyKeyInLine[1] : await engine.findLazyKey(files, mapKey);
        if (!lazyKey) { return { warning: `Node map entry not found for: ${mapKey}` }; }
        const location = await engine.findFactory(files, lazyKey);
        if (!location) { return { warning: `Node implementation not found for: ${lazyKey}` }; }
        return { location };
    }

    return {};
}

export async function hoverMarkdown(
    engine: DagonEngine,
    path: string,
    text: string,
    position: Position
): Promise<string | undefined> {
    const lazyKey = await resolveNodeKey(engine, path, text, position);
    if (!lazyKey) { return undefined; }

    const files = await engine.findNodeFiles(filePrefix(path));
    const [factory, usages] = await Promise.all([
        engine.findFactory(files, lazyKey),
        engine.findUsages(files, lazyKey),
    ]);

    const lines: string[] = [`**${lazyKey}**`, '---'];
    lines.push(factory ? `Node implemented: \`${lazyKey}\`` : 'Node implementation not found');
    if (usages.length === 0) {
        lines.push('');
    } else {
        lines.push(`Dependents (${usages.length}):`);
        for (const u of usages) { lines.push(`- \`${u.enclosingFactory}\``); }
    }
    return lines.join('\n\n');
}

export async function referenceLocations(
    engine: DagonEngine,
    path: string,
    text: string,
    position: Position
): Promise<Location[]> {
    const lazyKey = await resolveNodeKey(engine, path, text, position);
    if (!lazyKey) { return []; }
    const files = await engine.findNodeFiles(filePrefix(path));
    const usages = await engine.findUsages(files, lazyKey);
    return usages.map(u => u.location);
}

export async function factoryAnnotations(
    engine: DagonEngine,
    path: string,
    text: string
): Promise<FactoryAnnotation[]> {
    const prefix = filePrefix(path);
    if (!prefix) { return []; }

    const lines = text.split('\n');
    const factories: { line: number; key: string }[] = [];
    const factoryPattern = /^\s*"([a-z][a-z0-9_]*)":\s*func\(\)\s*model\.Node/;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(factoryPattern);
        if (m) { factories.push({ line: i, key: m[1] }); }
    }
    if (factories.length === 0) { return []; }

    const initResult = parseInitSection(lines);
    const snakeKeysInInit = new Set(initResult.entries.map(e => e.snakeKey));

    const snakeToTask = new Map<string, { taskNumber: number; publicKeys: string[] }>();
    let taskPath: string | undefined;
    let taskText: string | undefined;
    try {
        taskPath = await engine.findTaskFile(path);
        if (taskPath) {
            taskText = await engine.files.read(taskPath);
            const taskGroups = taskText ? parseTaskGroups(taskText.split('\n')) : [];
            const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));
            const factoryKeySet = new Set(factories.map(f => f.key));
            for (const group of taskGroups) {
                for (const pk of group.publicKeys) {
                    const snakeKey = snakeForPublicKey(pk, publicToSnake, factoryKeySet);
                    if (snakeKey) {
                        snakeToTask.set(snakeKey, {
                            taskNumber: group.taskNumber,
                            publicKeys: group.publicKeys,
                        });
                    }
                }
            }
        }
    } catch { /* task file unavailable */ }

    const files = await engine.findNodeFiles(prefix);
    const allUsages = await engine.findAllUsages(files);

    const annotations: FactoryAnnotation[] = [];
    for (const f of factories) {
        const taskInfo = snakeToTask.get(f.key);
        const annotation: FactoryAnnotation = {
            line: f.line,
            key: f.key,
            inInit: snakeKeysInInit.has(f.key),
            taskPath,
            dependents: allUsages.get(f.key) ?? [],
        };
        if (taskInfo) {
            annotation.task = {
                taskNumber: taskInfo.taskNumber,
                publicKeys: taskInfo.publicKeys,
                line: taskText ? taskAssignmentLine(taskText, taskInfo.taskNumber) : 0,
            };
        }
        annotations.push(annotation);
    }
    return annotations;
}

export function taskAssignmentLine(taskText: string, taskNumber: number): number {
    const lines = taskText.split('\n');
    const re = new RegExp(`\\w+Task${taskNumber}\\s*=\\s*newTask\\(`);
    for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { return i; }
    }
    return 0;
}

export async function diagnosticUpdates(engine: DagonEngine, changedPath: string): Promise<DiagnosticUpdate[]> {
    const updates: DiagnosticUpdate[] = [];
    if (changedPath.endsWith('_task.go') || changedPath.endsWith('_node.go')) {
        await runCheck(() => pushSameTask(engine, changedPath, updates));
        await runCheck(() => pushTaskNodeExist(engine, changedPath, updates));
        await runCheck(() => pushUnused(engine, changedPath, updates));
    }
    if (changedPath.endsWith('_node.go')) {
        await runCheck(() => pushNodeName(engine, changedPath, updates));
        await runCheck(() => pushNodeFactory(engine, changedPath, updates));
        await runCheck(() => pushNodeDepExist(engine, changedPath, updates));
        await runCheck(() => pushNodeDepTask(engine, changedPath, updates));
    }
    if (changedPath.endsWith('_pipeline.go') || changedPath.endsWith('_task.go')) {
        await runCheck(() => pushPipeline(engine, changedPath, updates));
    }
    return updates;
}

function snakeForPublicKey(
    publicKey: string,
    publicToSnake: Map<string, string>,
    factoryKeySet: Set<string>
): string | undefined {
    const directSnake = publicKey.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    return factoryKeySet.has(directSnake) ? directSnake : publicToSnake.get(publicKey);
}

function quotedSpan(lineText: string, key: string, line: number, quoteExtra: number): Range {
    const needle = `"${key}"`;
    const col = lineText.indexOf(needle);
    const start = col >= 0 ? col : 0;
    const end = col >= 0 ? col + key.length + quoteExtra : lineText.length;
    return { start: { line, character: start }, end: { line, character: end } };
}

function bracketSpan(lineText: string, key: string, line: number): Range {
    const needle = `["${key}"]`;
    const col = lineText.indexOf(needle);
    const start = col >= 0 ? col : 0;
    const end = col >= 0 ? col + key.length + 3 : lineText.length;
    return { start: { line, character: start }, end: { line, character: end } };
}

function identSpan(lineText: string, ident: string, line: number): Range {
    const col = lineText.indexOf(ident);
    const start = col >= 0 ? col : 0;
    const end = col >= 0 ? col + ident.length : lineText.length;
    return { start: { line, character: start }, end: { line, character: end } };
}

async function runCheck(fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
    } catch {
        // Malformed or partial files must not break the editor.
    }
}

async function pushSameTask(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    const taskPath = changedPath.endsWith('_task.go')
        ? changedPath
        : await engine.findTaskFile(changedPath);
    if (!taskPath) { return; }

    const violations = await engine.findSameTaskViolations(taskPath);
    const taskText = await engine.files.read(taskPath);
    if (taskText === undefined) { return; }
    const taskLines = taskText.split('\n');

    const diagnostics: DagonDiagnostic[] = violations.map(v => {
        const lineText = taskLines[v.line] ?? '';
        const message = v.kind === 'same-task'
            ? `'${v.nodePublicKey}' depends on '${v.depSnakeKey}' (${v.depPublicKey}) which is in the same task (Task ${v.taskNumber}) — move one to a different task`
            : `'${v.nodePublicKey}' (Task ${v.taskNumber}) depends on '${v.depSnakeKey}' (${v.depPublicKey}) which runs later in Task ${v.depTaskNumber} — move '${v.nodePublicKey}' to a task after Task ${v.depTaskNumber}`;
        return { range: bracketSpan(lineText, v.nodePublicKey, v.line), message, severity: 'error' };
    });
    updates.push({ code: 'dagon-same-task', path: taskPath, diagnostics });
}

async function pushPipeline(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    let pipelinePath: string | undefined;
    if (changedPath.endsWith('_pipeline.go')) {
        pipelinePath = changedPath;
    } else if (changedPath.endsWith('_task.go')) {
        pipelinePath = await engine.findPipelineFile(changedPath);
    }
    if (!pipelinePath) { return; }

    const taskFilePath = pipelinePath
        .replace(/\/pipeline\//, '/task/')
        .replace(/_pipeline\.go$/, '_task.go');
    if (await engine.files.read(taskFilePath) === undefined) { return; }

    const [refs, assigned] = await Promise.all([
        engine.parsePipelineTaskRefs(pipelinePath),
        engine.parseTaskAssignments(taskFilePath),
    ]);
    const pipelineText = await engine.files.read(pipelinePath);
    if (pipelineText === undefined) { return; }
    const pipelineLines = pipelineText.split('\n');

    const diagnostics: DagonDiagnostic[] = refs
        .filter(r => !assigned.has(r.taskVar))
        .map(r => {
            const lineText = pipelineLines[r.line] ?? '';
            return {
                range: identSpan(lineText, r.taskVar, r.line),
                message: `Task '${r.taskVar}' is referenced in the pipeline but not assigned in the task file`,
                severity: 'error' as const,
            };
        });
    updates.push({ code: 'dagon-pipeline', path: pipelinePath, diagnostics });
}

async function pushTaskNodeExist(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    let taskPath: string | undefined;
    let nodeText: string | undefined;

    if (changedPath.endsWith('_task.go')) {
        taskPath = changedPath;
        const nodePath = changedPath
            .replace(/\/task\//, '/node/')
            .replace(/_task\.go$/, '_node.go');
        nodeText = await engine.files.read(nodePath);
        if (nodeText === undefined) { return; }
    } else if (changedPath.endsWith('_node.go')) {
        nodeText = await engine.files.read(changedPath);
        const taskCandidate = changedPath
            .replace(/\/node\//, '/task/')
            .replace(/_node\.go$/, '_task.go');
        if (await engine.files.read(taskCandidate) === undefined) { return; }
        taskPath = taskCandidate;
    }
    if (!taskPath || nodeText === undefined) { return; }

    const taskRefs = await engine.parseTaskGroupsWithLines(taskPath);
    const initResult = parseInitSection(nodeText.split('\n'));
    const declaredKeys = new Set(initResult.entries.map(e => e.publicKey));
    const taskText = await engine.files.read(taskPath);
    if (taskText === undefined) { return; }
    const taskLines = taskText.split('\n');

    const diagnostics: DagonDiagnostic[] = taskRefs
        .filter(r => !declaredKeys.has(r.publicKey))
        .map(r => {
            const lineText = taskLines[r.line] ?? '';
            return {
                range: bracketSpan(lineText, r.publicKey, r.line),
                message: `Node '${r.publicKey}' is referenced in the task but not declared in the node file's init section`,
                severity: 'error' as const,
            };
        });
    updates.push({ code: 'dagon-task-node-exist', path: taskPath, diagnostics });
}

async function pushNodeFactory(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    if (!changedPath.endsWith('_node.go')) { return; }
    const text = await engine.files.read(changedPath);
    if (text === undefined) { return; }
    const lines = text.split('\n');
    const initResult = parseInitSection(lines);
    const factoryResult = parseFactorySection(lines);
    const factoryKeys = new Set(factoryResult.factories.keys());

    const diagnostics: DagonDiagnostic[] = initResult.entries
        .filter(e => e.line !== undefined && !factoryKeys.has(e.snakeKey))
        .map(e => {
            const lineNum = e.line!;
            const lineText = lines[lineNum] ?? '';
            return {
                range: quotedSpan(lineText, e.snakeKey, lineNum, 2),
                message: `Node '${e.snakeKey}' is declared in init but has no factory entry`,
                severity: 'error' as const,
            };
        });
    updates.push({ code: 'dagon-node-factory', path: changedPath, diagnostics });
}

async function pushNodeDepExist(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    if (!changedPath.endsWith('_node.go')) { return; }
    const text = await engine.files.read(changedPath);
    if (text === undefined) { return; }
    const prefix = filePrefix(changedPath);
    const files = await engine.findNodeFiles(prefix);
    const depsByFactory = await engine.parseDependenciesByFactory(files);
    const validKeys = new Set(depsByFactory.keys());
    const lines = text.split('\n');
    const deps = parseNodeDepsWithLines(lines);

    const diagnostics: DagonDiagnostic[] = deps
        .filter(d => !validKeys.has(d.depKey))
        .map(d => {
            const lineText = lines[d.line] ?? '';
            return {
                range: quotedSpan(lineText, d.depKey, d.line, 2),
                message: `Dependency '${d.depKey}' does not exist as a node factory`,
                severity: 'error' as const,
            };
        });
    updates.push({ code: 'dagon-node-dep-exist', path: changedPath, diagnostics });
}

async function pushNodeDepTask(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    if (!changedPath.endsWith('_node.go')) { return; }
    const taskPath = changedPath
        .replace(/\/node\//, '/task/')
        .replace(/_node\.go$/, '_task.go');
    if (await engine.files.read(taskPath) === undefined) { return; }

    const text = await engine.files.read(changedPath);
    if (text === undefined) { return; }
    const lines = text.split('\n');
    const initResult = parseInitSection(lines);
    const publicToSnake = new Map(initResult.entries.map(e => [e.publicKey, e.snakeKey]));

    const files = await engine.findNodeFiles(filePrefix(changedPath));
    const depsByFactory = await engine.parseDependenciesByFactory(files);
    const factoryKeySet = new Set(depsByFactory.keys());
    const snakeToTask = await engine.buildSnakeToTaskMap(taskPath, publicToSnake, factoryKeySet);
    const deps = parseNodeDepsWithLines(lines);
    const diagnostics: DagonDiagnostic[] = [];

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

        const lineText = lines[d.line] ?? '';
        diagnostics.push({
            range: quotedSpan(lineText, d.depKey, d.line, 2),
            message,
            severity: 'error',
        });
    }

    updates.push({ code: 'dagon-node-dep-task', path: changedPath, diagnostics });
}

async function pushUnused(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    let nodePath: string | undefined;
    let nodeText: string | undefined;
    let taskPath: string | undefined;

    if (changedPath.endsWith('_node.go')) {
        nodePath = changedPath;
        nodeText = await engine.files.read(changedPath);
        const taskCandidate = changedPath
            .replace(/\/node\//, '/task/')
            .replace(/_node\.go$/, '_task.go');
        if (await engine.files.read(taskCandidate) === undefined) { return; }
        taskPath = taskCandidate;
    } else if (changedPath.endsWith('_task.go')) {
        taskPath = changedPath;
        const nodeCandidate = changedPath
            .replace(/\/task\//, '/node/')
            .replace(/_task\.go$/, '_node.go');
        nodeText = await engine.files.read(nodeCandidate);
        if (nodeText === undefined) { return; }
        nodePath = nodeCandidate;
    } else {
        return;
    }
    if (!nodePath || nodeText === undefined || !taskPath) { return; }

    const initResult = parseInitSection(nodeText.split('\n'));
    const taskRefs = await engine.parseTaskGroupsWithLines(taskPath);
    const usedKeys = new Set(taskRefs.map(r => r.publicKey));
    const nodeLines = nodeText.split('\n');

    const diagnostics: DagonDiagnostic[] = initResult.entries
        .filter(e => e.line !== undefined && !usedKeys.has(e.publicKey))
        .map(e => {
            const lineNum = e.line!;
            const lineText = nodeLines[lineNum] ?? '';
            return {
                range: quotedSpan(lineText, e.publicKey, lineNum, 2),
                message: `Node '${e.publicKey}' is declared but not used in any task`,
                severity: 'warning' as const,
            };
        });
    updates.push({ code: 'dagon-unused-node', path: nodePath, diagnostics });
}

async function pushNodeName(engine: DagonEngine, changedPath: string, updates: DiagnosticUpdate[]): Promise<void> {
    if (!changedPath.endsWith('_node.go')) { return; }
    const text = await engine.files.read(changedPath);
    if (text === undefined) { return; }
    const lines = text.split('\n');
    const mismatches = findNodeNameMismatches(lines);
    const diagnostics: DagonDiagnostic[] = mismatches.map(m => {
        const lineText = lines[m.line] ?? '';
        return {
            range: quotedSpan(lineText, m.firstParam, m.line, 2),
            message: `Factory key '${m.factoryKey}' does not match node name '${m.firstParam}' — first argument to newNode must equal the factory key`,
            severity: 'error' as const,
        };
    });
    updates.push({ code: 'dagon-node-name', path: changedPath, diagnostics });
}
