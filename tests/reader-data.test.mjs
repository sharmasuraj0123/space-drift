import test from 'node:test';
import assert from 'node:assert/strict';
import { formatJSON } from '../public/readers/json.js';
import { parseData } from '../public/readers/data.worker.js';

test('JSON formatting preserves integer, exponent, decimal and duplicate-key lexemes', () => {
  const source = '{"id":900719925474099312345,"n":-0,"precise":1.2300e+99,"id":2,"text":"brace } \\" quote"}';
  const formatted = formatJSON(source);
  assert.match(formatted, /900719925474099312345/);
  assert.match(formatted, /1\.2300e\+99/);
  assert.match(formatted, /"n": -0/);
  assert.equal((formatted.match(/"id"/g) || []).length, 2);
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
  assert.match(parseData({ text: source, format: 'geojson' }).text, /900719925474099312345/);
});

test('JSON validator rejects malformed grammar and excessive nesting, keeping readable raw fallback', () => {
  for (const source of ['{"a":1,}', '[1,]', '01', '1e', 'false true', '{"a" 1}', '"bad\nstring"', '', '{a:1}']) {
    assert.throws(() => formatJSON(source), /Invalid JSON/);
    const result = parseData({ text: source, format: 'json' });
    assert.equal(result.text, source);
    assert.match(result.warning, /Showing original text/);
  }
  assert.throws(() => formatJSON('['.repeat(66) + '0' + ']'.repeat(66)), /nesting/);
});

test('JSONL preserves record values and reports the actual malformed line', () => {
  const source = '{"id":9007199254740993}\n\n{"v":1e400}\n';
  const result = parseData({ text: source, format: 'jsonl' });
  assert.match(result.text, /9007199254740993/);
  assert.match(result.text, /1e400/);
  const invalid = parseData({ text: '{"ok":1}\nno', format: 'ndjson' });
  assert.match(invalid.warning, /Line 2/);
  assert.equal(invalid.text, '{"ok":1}\nno');
  const truncated = parseData({ text: '{"id":', format: 'json', truncated: true });
  assert.match(truncated.warning, /truncated/);
  assert.equal(truncated.text, '{"id":');
});

test('CSV and TSV retain strings, quoted newlines, markup and spreadsheet-like formulas', () => {
  const csv = parseData({ format: 'csv', text: 'id,label,value\r\n00123,"hello,\nworld",=HYPERLINK(""x"")\r\n9007199254740993,<script>never</script>,1.2300' });
  assert.equal(csv.rows[1][0], '00123');
  assert.equal(csv.rows[1][1], 'hello,\nworld');
  assert.match(csv.rows[1][2], /^=HYPERLINK/);
  assert.equal(csv.rows[2][0], '9007199254740993');
  assert.equal(csv.rows[2][1], '<script>never</script>');
  assert.equal(csv.rows[2][2], '1.2300');
  const tsv = parseData({ format: 'tsv', text: 'first\tsecond\n001\t"a\tb"' });
  assert.deepEqual(tsv.rows[1], ['001', 'a\tb']);
});

test('CSV errors and table limits are explicit, without interpreting cells or headers', () => {
  assert.throws(() => parseData({ format: 'csv', text: 'a,b\n"unterminated,b' }), /Malformed/);
  const rows = parseData({ format: 'csv', text: Array.from({ length: 1005 }, (_, i) => `${i},item`).join('\n') });
  assert.equal(rows.rows.length, 1000);
  assert.match(rows.warning, /limited/);
  const wide = parseData({ format: 'tsv', text: Array.from({ length: 600 }, () => Array(110).fill('cell').join('\t')).join('\n') });
  assert.equal(wide.rows[0].length, 100);
  assert.equal(wide.rows.length, 500);
  assert.match(wide.warning, /50,000/);
  const partial = parseData({ format: 'csv', text: '1,2\n3,', truncated: true });
  assert.match(partial.warning, /final record may be incomplete/);
});
