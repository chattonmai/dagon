import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    DagonEngine,
    buildNewDagTemplates,
    constantInsert,
    definitionAt,
    detectNaming,
    diagnosticUpdates,
    filePrefix,
    goModulePath,
    hoverMarkdown,
    dagPrefixFromName,
    isSnakeName,
    memoryStore,
    normalizeDagName,
    parseFactorySection,
    parseInitSection,
    planReorder,
    referenceLocations,
    snakeToCamel,
    snakeToPascal,
    stripLineComments,
    substitutePrefix,
} from './engine';

const root = '/repo';
const nodePath = `${root}/internal/dag/node/shop_node.go`;
const taskPath = `${root}/internal/dag/task/shop_task.go`;
const pipelinePath = `${root}/internal/dag/pipeline/shop_pipeline.go`;
const dagPath = `${root}/internal/dag/shop_dag.go`;
const constPath = `${root}/internal/constant/names.go`;
const goModPath = `${root}/go.mod`;
const vendorNode = `${root}/vendor/oops/node/shop_node.go`;

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
    '\t\t"SaveUser": func() model.Node { return shopLazyNodes["save_user"].Get() },',
    '\t\t"OrphanNode": func() model.Node { return shopLazyNodes["orphan_node"].Get() },',
    '\t\t"MissingFactory": func() model.Node { return shopLazyNodes["missing_factory"].Get() },',
    '\t}',
    '}',
    '',
    'var shopNodeFactories = map[string]func() model.Node{',
    '\t"load_user": func() model.Node {',
    '\t\treturn newNode(',
    '\t\t\t"load_user",',
    '\t\t\t"",',
    '\t\t\t[]string{},',
    '\t\t\tLabel: []string{"load_user"},',
    '\t\t\tnil,',
    '\t\t)',
    '\t},',
    '\t"check_user": func() model.Node {',
    '\t\treturn newNode(',
    '\t\t\t"check_user",',
    '\t\t\t"",',
    '\t\t\t[]string{',
    '\t\t\t\t"load_user", // Task 1',
    '\t\t\t\t"save_user",',
    '\t\t\t},',
    '\t\t\tnil,',
    '\t\t)',
    '\t},',
    '\t"save_user": func() model.Node {',
    '\t\treturn newNode(',
    '\t\t\t"wrong_name",',
    '\t\t\t"",',
    '\t\t\t[]string{"no_such_node"},',
    '\t\t\tnil,',
    '\t\t)',
    '\t},',
    '\t"orphan_node": func() model.Node {',
    '\t\treturn newNode(',
    '\t\t\t"orphan_node",',
    '\t\t\t"",',
    '\t\t\t[]string{"load_user", "check_user"},',
    '\t\t\tnil,',
    '\t\t)',
    '\t},',
    '\t"inline_user": func() model.Node {',
    '\t\treturn newNode("inline_user", "", []string{"load_user"}, nil)',
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
    '\t\tnode.ShopNode["GhostNode"](),',
    '\t)',
    '\tShopTask2 = newTask(',
    '\t\tnode.ShopNode["SaveUser"](),',
    '\t)',
    '}',
    '',
].join('\n');

const pipelineText = [
    'package pipeline',
    '',
    'func init() {',
    '\tShopPipeline = newPipeline(',
    '\t\ttask.ShopTask1,',
    '\t\ttask.ShopTask9,',
    '\t)',
    '}',
    '',
].join('\n');

const constText = [
    'package constant',
    '',
    'const (',
    '\tSHOP_NAME = "shop"',
    ')',
    '',
].join('\n');

function lineOf(text: string, needle: string): number {
    const line = text.split('\n').findIndex(entry => entry.includes(needle));
    if (line < 0) { throw new Error(`missing ${needle}`); }
    return line;
}

function at(text: string, needle: string, columnNeedle = needle): { line: number; character: number } {
    const line = lineOf(text, needle);
    const character = text.split('\n')[line].indexOf(columnNeedle);
    return { line, character: character < 0 ? 0 : character };
}

function store() {
    return memoryStore({
        [nodePath]: nodeText,
        [taskPath]: taskText,
        [pipelinePath]: pipelineText,
        [dagPath]: 'package dag\n',
        [constPath]: constText,
        [goModPath]: 'module example.com/shop\n\ngo 1.22\n',
        [vendorNode]: nodeText,
    });
}

describe('stripLineComments', () => {
    const depRegex = /^\s*"([a-z][a-z0-9_]*)"\s*,?\s*$/;
    const closeRegex = /^\s*\}\s*,?\s*$/;

    it('keeps a dependency that has a trailing // comment', () => {
        const stripped = stripLineComments('\t\t\t\t"validate_user_feature_is_unknown", // Task 16');
        const match = stripped.match(depRegex);
        assert.ok(match);
        assert.equal(match[1], 'validate_user_feature_is_unknown');
    });

    it('does not treat a brace inside a comment as the end of an array', () => {
        const stripped = stripLineComments('\t\t\t\t"rerank_items", // returns map[string]any{}');
        assert.equal(depRegex.test(stripped), true);
        assert.equal(closeRegex.test(stripped), false);
    });

    it('drops a comment-only quoted word', () => {
        const stripped = stripLineComments('\t\t\t\t// see "old_node" for history');
        assert.equal([...stripped.matchAll(/"([a-z][a-z0-9_]*)"/g)].length, 0);
    });

    it('keeps // that sits inside a string', () => {
        const stripped = stripLineComments('\t\t\t\tUrl: "http://example.com/feed", // endpoint');
        assert.equal(stripped.includes('http://example.com/feed'), true);
        assert.equal(stripped.includes('endpoint'), false);
    });

    it('removes an inline block comment', () => {
        const stripped = stripLineComments('\t\t\t\t"final_result" /* keep last */ ,');
        assert.equal(depRegex.test(stripped), true);
    });

    it('leaves a comment-free line unchanged', () => {
        const line = '\t\t\t\t"candidate_pin_global",';
        assert.equal(stripLineComments(line), line);
    });
});

describe('names and discovery', () => {
    it('normalizes dag tokens out of a snake name', () => {
        assert.equal(normalizeDagName('afv_p4_dag'), 'afv_p4');
        assert.equal(normalizeDagName('dag_afv_p4'), 'afv_p4');
        assert.equal(normalizeDagName('afv_dag_p4'), 'afv_p4');
        assert.equal(normalizeDagName('my_dag_name'), 'my_name');
        assert.equal(isSnakeName('afv_p4'), true);
        assert.equal(isSnakeName('Afv'), false);
        assert.equal(dagPrefixFromName('dno-p5'), 'dno_p5');
        assert.equal(dagPrefixFromName('"dno-p5"'), 'dno_p5');
        assert.equal(dagPrefixFromName('DNO_P5_NAME'), 'dno_p5');
        assert.equal(dagPrefixFromName('DNO_P5'), 'dno_p5');
        assert.equal(dagPrefixFromName('dno_p5'), 'dno_p5');
        assert.equal(dagPrefixFromName('afv_p4_dag'), 'afv_p4');
        assert.equal(dagPrefixFromName('_NAME'), undefined);
        assert.equal(dagPrefixFromName(''), undefined);
    });

    it('reads the module path and the filename prefix', () => {
        assert.equal(goModulePath('module example.com/shop\n'), 'example.com/shop');
        assert.equal(goModulePath(undefined), 'your-module');
        assert.equal(filePrefix(nodePath), 'shop');
        assert.equal(snakeToPascal('my_shop'), 'MyShop');
        assert.equal(snakeToCamel('my_shop'), 'myShop');
    });

    it('finds dag files and skips vendor', async () => {
        const engine = new DagonEngine(store());
        assert.equal(await engine.findDagRoot(), `${root}/internal/dag`);
        assert.deepEqual(await engine.findExistingDags(), [{ prefix: 'shop', path: dagPath }]);
        assert.equal(await engine.findDagConstantsFile(), constPath);
        assert.equal(await engine.detectGoModule(), 'example.com/shop');
        const nodes = await engine.findNodeFiles('shop');
        assert.deepEqual(nodes, [nodePath]);
    });
});

describe('parsing and navigation', () => {
    it('parses init entries and factory blocks', () => {
        const lines = nodeText.split('\n');
        const init = parseInitSection(lines);
        assert.deepEqual(init.entries.map(entry => entry.publicKey), [
            'LoadUser', 'CheckUser', 'SaveUser', 'OrphanNode', 'MissingFactory',
        ]);
        assert.equal(init.entries[0].snakeKey, 'load_user');
        const factories = parseFactorySection(lines);
        assert.deepEqual([...factories.factories.keys()], [
            'load_user', 'check_user', 'save_user', 'orphan_node', 'inline_user',
        ]);
    });

    it('jumps from a task call, a public map entry, and a dependency string', async () => {
        const engine = new DagonEngine(store());
        const factoryLine = lineOf(nodeText, '"load_user": func()');

        const fromTask = await definitionAt(engine, taskPath, taskText, at(taskText, '["LoadUser"]', 'LoadUser'));
        assert.equal(fromTask.location?.path, nodePath);
        assert.equal(fromTask.location?.range.start.line, factoryLine);

        const fromMap = await definitionAt(engine, nodePath, nodeText, at(nodeText, '"CheckUser":', 'CheckUser'));
        assert.equal(fromMap.location?.range.start.line, lineOf(nodeText, '"check_user": func()'));

        const fromDep = await definitionAt(engine, nodePath, nodeText, at(nodeText, '"save_user",', 'save_user'));
        assert.equal(fromDep.location?.range.start.line, lineOf(nodeText, '"save_user": func()'));

        const inlineLine = nodeText.split('\n')[lineOf(nodeText, '[]string{"load_user"}')];
        const fromInline = await definitionAt(
            engine,
            nodePath,
            nodeText,
            { line: lineOf(nodeText, '[]string{"load_user"}'), character: inlineLine.indexOf('load_user') },
        );
        assert.equal(fromInline.location?.range.start.line, factoryLine);

        const onFactory = await definitionAt(engine, nodePath, nodeText, at(nodeText, '"load_user": func()', 'load_user'));
        assert.equal(onFactory.location, undefined);
        assert.equal(onFactory.warning, undefined);
    });

    it('lists dependents and ignores a struct-field string array', async () => {
        const engine = new DagonEngine(store());
        const position = at(nodeText, '"load_user": func()', 'load_user');
        const refs = await referenceLocations(engine, nodePath, nodeText, position);
        assert.deepEqual(refs.map(ref => ref.range.start.line).sort((a, b) => a - b), [
            lineOf(nodeText, '"check_user": func()'),
            lineOf(nodeText, '"orphan_node": func()'),
            lineOf(nodeText, '"inline_user": func()'),
        ]);
        const hover = await hoverMarkdown(engine, nodePath, nodeText, position);
        assert.match(hover ?? '', /\*\*load_user\*\*/);
        assert.match(hover ?? '', /Dependents \(3\):/);
        assert.match(hover ?? '', /`check_user`/);
        assert.equal((hover ?? '').includes('save_user'), false);
    });
});

describe('reorder and templates', () => {
    it('groups the init map by task and appends factories that have no task', () => {
        const result = planReorder(nodeText, taskText, 'shop');
        assert.equal(result.ok, true);
        if (!result.ok) { return; }
        const init = result.plan.init.newText;
        assert.ok(init.indexOf('// (no task)') < init.indexOf('// Task 1'));
        assert.ok(init.indexOf('// Task 1') < init.indexOf('// Task 2'));
        assert.match(init, /shopLazyNodes\["orphan_node"\]/);
        const factory = result.plan.factory?.newText ?? '';
        const order = ['"load_user":', '"check_user":', '"save_user":', '"inline_user":'].map(token => factory.indexOf(token));
        assert.deepEqual(order, [...order].sort((a, b) => a - b));
        assert.equal(order.every(index => index >= 0), true);
    });

    it('falls back to the filename prefix when the file has no lazy variable', () => {
        const bare = [
            'func init() {',
            '\tShopNode = map[string]func() model.Node{',
            '\t\t"LoadUser": func() model.Node { return LazyNodes["load_user"].Get() },',
            '\t}',
            '}',
        ].join('\n');
        const tasks = 'func init() {\n\tShopTask1 = newTask(\n\t\tnode.ShopNode["LoadUser"](),\n\t)\n}\n';
        const result = planReorder(bare, tasks, 'my_dag');
        assert.equal(result.ok, true);
        if (!result.ok) { return; }
        assert.match(result.plan.init.newText, /myDagLazyNodes\["load_user"\]/);
    });

    it('rewrites Pascal, camel, upper, and raw forms, including a pp2 override', () => {
        const source = [
            'Pp2Node',
            'pp2LazyNodes',
            'pp2NodeFactories',
            'PP2_DAG_NAME',
            'PP2_NAME',
            '"pp2:seen"',
        ].join('\n');
        const rewritten = substitutePrefix(source, 'pp2', 'my_dag', 'Pp2', 'pp2');
        assert.equal(rewritten, [
            'MyDagNode',
            'myDagLazyNodes',
            'myDagNodeFactories',
            'MY_DAG_NAME',
            'MY_DAG_NAME',
            '"my_dag:seen"',
        ].join('\n'));

        const underscored = substitutePrefix('MyShop myShop MY_SHOP my-shop my_shop', 'my_shop', 'your_store');
        assert.equal(underscored, 'YourStore yourStore YOUR_STORE your-store your_store');
        assert.deepEqual(detectNaming('var pp2LazyNodes\nvar Pp2Node map[string]func() model.Node\n'), {
            pascal: 'Pp2',
            camel: 'pp2',
        });
    });

    it('builds the four files and an insertion line for the constant block', () => {
        const templates = buildNewDagTemplates('food_cart', 'example.com/shop');
        assert.match(templates.dag, /constant\.FOOD_CART_NAME/);
        assert.match(templates.node, /foodCartLazyNodes\["example_node"\]/);
        assert.match(templates.task, /node\.FoodCartNode\["ExampleNode"\]/);
        const insert = constantInsert(constText, 'food_cart');
        assert.equal(insert?.line, lineOf(constText, ')'));
        assert.equal(insert?.newText, '\tFOOD_CART_NAME = "food-cart"\n');
    });
});

describe('diagnostics', () => {
    it('reports each rule and swallows a malformed file', async () => {
        const engine = new DagonEngine(store());
        const updates = [
            ...await diagnosticUpdates(engine, nodePath),
            ...await diagnosticUpdates(engine, pipelinePath),
        ];
        const byCode = new Map(updates.map(update => [update.code, update]));

        const same = byCode.get('dagon-same-task');
        assert.ok(same);
        assert.equal(same.path, taskPath);
        assert.equal(same.diagnostics.length, 2);
        assert.equal(
            same.diagnostics[0].message,
            "'CheckUser' depends on 'load_user' (LoadUser) which is in the same task (Task 1) — move one to a different task",
        );
        assert.match(same.diagnostics[1].message, /runs later in Task 2/);
        const checkLine = lineOf(taskText, '["CheckUser"]');
        const checkText = taskText.split('\n')[checkLine];
        const col = checkText.indexOf('["CheckUser"]');
        assert.equal(same.diagnostics[0].range.start.character, col);
        assert.equal(same.diagnostics[0].range.end.character, col + 'CheckUser'.length + 3);

        const pipeline = byCode.get('dagon-pipeline');
        assert.equal(pipeline?.diagnostics[0].message, "Task 'ShopTask9' is referenced in the pipeline but not assigned in the task file");

        const missingNode = byCode.get('dagon-task-node-exist');
        assert.match(missingNode?.diagnostics[0].message ?? '', /GhostNode/);

        const missingFactory = byCode.get('dagon-node-factory');
        assert.equal(missingFactory?.diagnostics[0].message, "Node 'missing_factory' is declared in init but has no factory entry");
        assert.equal(missingFactory?.diagnostics[0].range.end.character - (missingFactory?.diagnostics[0].range.start.character ?? 0), 'missing_factory'.length + 2);

        const missingDep = byCode.get('dagon-node-dep-exist');
        assert.equal(missingDep?.diagnostics[0].message, "Dependency 'no_such_node' does not exist as a node factory");

        const depTask = byCode.get('dagon-node-dep-task');
        assert.equal(depTask?.diagnostics.length, 2);
        assert.match(depTask?.diagnostics[0].message ?? '', /same task \(Task 1\)/);
        assert.match(depTask?.diagnostics[1].message ?? '', /runs after Task 1/);

        const unused = byCode.get('dagon-unused-node');
        assert.equal(unused?.diagnostics.length, 2);
        assert.equal(unused?.diagnostics[0].severity, 'warning');
        assert.match(unused?.diagnostics.map(item => item.message).join('\n') ?? '', /OrphanNode/);
        assert.match(unused?.diagnostics.map(item => item.message).join('\n') ?? '', /MissingFactory/);

        const name = byCode.get('dagon-node-name');
        assert.equal(
            name?.diagnostics[0].message,
            "Factory key 'save_user' does not match node name 'wrong_name' — first argument to newNode must equal the factory key",
        );

        const junk = new DagonEngine(memoryStore({ '/tmp/nope_node.go': 'this is not go {{{' }));
        const junkUpdates = await diagnosticUpdates(junk, '/tmp/nope_node.go');
        assert.ok(Array.isArray(junkUpdates));
    });
});
