import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { stripLineComments } from '../extension';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});

suite('stripLineComments — dependency detection with comments', () => {
	// The dependency scanners match a dep line with this regex (anchored to EOL),
	// which is exactly why trailing comments used to break detection.
	const depRegex = /^\s*"([a-z][a-z0-9_]*)"\s*,?\s*$/;
	const closeRegex = /^\s*\}\s*,?\s*$/;

	test('reported case: trailing // comment on a dependency line is detected', () => {
		const line = '\t\t\t\t"validate_user_feature_is_unknown", // Task 16';
		const stripped = stripLineComments(line);
		const m = stripped.match(depRegex);
		assert.ok(m, 'dependency should match after stripping the trailing comment');
		assert.strictEqual(m![1], 'validate_user_feature_is_unknown');
	});

	test('a // comment containing a } does not look like a closing brace', () => {
		const line = '\t\t\t\t"rerank_items", // returns map[string]any{}';
		const stripped = stripLineComments(line);
		assert.ok(depRegex.test(stripped), 'the dep on this line is still detected');
		assert.ok(!closeRegex.test(stripped), 'the brace inside the comment must not close the array');
	});

	test('a // comment containing a quoted word produces no phantom dependency', () => {
		const line = '\t\t\t\t// see "old_node" for history';
		const stripped = stripLineComments(line);
		const matches = [...stripped.matchAll(/"([a-z][a-z0-9_]*)"/g)];
		assert.strictEqual(matches.length, 0, 'no quoted token should survive a comment-only line');
	});

	test('string literals containing // (e.g. URLs) are preserved', () => {
		const line = '\t\t\t\tUrl: "http://example.com/feed", // endpoint';
		const stripped = stripLineComments(line);
		assert.ok(stripped.includes('http://example.com/feed'), 'URL inside a string must be kept');
		assert.ok(!stripped.includes('endpoint'), 'the trailing comment must be removed');
	});

	test('inline /* */ block comments are removed', () => {
		const line = '\t\t\t\t"final_result" /* keep last */ ,';
		const stripped = stripLineComments(line);
		assert.ok(depRegex.test(stripped), 'dep detected with an inline block comment removed');
	});

	test('lines without comments are unchanged', () => {
		const line = '\t\t\t\t"candidate_pin_global",';
		assert.strictEqual(stripLineComments(line), line);
	});
});
