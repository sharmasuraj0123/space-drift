import test from 'node:test';
import assert from 'node:assert/strict';
import { languageFor, handleTextJob, highlightCode, renderMarkdown } from '../public/readers/text.worker.js';
import { localResourcePath, safeExternalURL, safeReaderClasses, renderHTML } from '../public/readers/html.js';

test('only explicit language imports can be requested by names or fence aliases', () => {
  assert.equal(languageFor('src/app.tsx'), 'tsx');
  assert.equal(languageFor('module.mjs'), 'javascript');
  assert.equal(languageFor('', 'py extra fence info'), 'python');
  for (const value of ['unknown', 'constructor', '__proto__', 'https://example.com/lang', '../javascript']) assert.equal(languageFor('', value), null);
});

test('syntax highlighting preserves literal source, escapes markup and uses fixed color classes', async () => {
  const text = 'const answer = "<script>alert(1)</script>";\n// a comment';
  const result = await highlightCode(text, 'javascript');
  assert.equal(result.highlighted, true);
  assert.match(result.html, /reader-token-keyword/);
  assert.match(result.html, /reader-token-comment/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script|style=/);
  assert.match(result.html, /data-line="2"/);
});

test('long lines, large files and unknown languages fall back to readable bounded source', async () => {
  const unknown = await handleTextJob({ kind: 'code', name: 'program.unlisted', text: '<img src=x onerror=alert(1)>' });
  assert.equal(unknown.highlighted, false);
  assert.doesNotMatch(unknown.html, /<img/);
  const huge = await highlightCode('x'.repeat(70000), 'javascript');
  assert.equal(huge.highlighted, false);
  const long = await highlightCode('x'.repeat(2100), 'javascript');
  assert.equal(long.highlighted, false);
  const manyLines = await highlightCode('a\n'.repeat(4000), null);
  assert.doesNotMatch(manyLines.html, /data-line=/);
  const capped = await handleTextJob({ kind: 'code', name: 'a.txt', text: 'a'.repeat(256 * 1024) + 'THE_END' });
  assert.doesNotMatch(capped.html, /THE_END/);
});

test('Markdown renders tables, readonly tasks, headings and syntax-highlighted fences', async () => {
  const result = await renderMarkdown('# Hello World\n\n[Jump](#hello-world)\n\n- [x] Done\n- [ ] Next\n\n| File | Count |\n| --- | --- |\n| README | 2 |\n\n```js\nconst count = 2;\n```');
  assert.match(result.html, /<h1 id="hello-world">/);
  assert.match(result.html, /<table>/);
  assert.match(result.html, /aria-label="Completed task"/);
  assert.match(result.html, /aria-label="Incomplete task"/);
  assert.match(result.html, /reader-token-keyword/);
  assert.doesNotMatch(result.html, /<input/);
});

test('Markdown keeps HTML as text and image references inert before sanitization', async () => {
  const result = await renderMarkdown('<script>alert(1)</script>\n\n![Private](https://tracker.invalid/pixel.png)\n\n![Local](./chart.png)\n\n[Run](javascript:alert(1))');
  assert.match(result.html, /&lt;script&gt;/);
  assert.doesNotMatch(result.html, /<script|<img src=|href="javascript:/);
  assert.match(result.html, /data-reader-src="https:\/\/tracker.invalid\/pixel.png"/);
  assert.match(result.html, /data-reader-src="\.\/chart.png"/);
});

test('complex Markdown avoids producing an unbounded document tree', async () => {
  const result = await renderMarkdown('- item\n'.repeat(5000));
  assert.equal(result.fallback, true);
  assert.match(result.html, /^<pre class="reader-source">/);
});

test('local resources resolve inside the selected folder and block active image formats', () => {
  assert.equal(localResourcePath('docs/README.md', '../images/plot.png', 'image'), 'images/plot.png');
  assert.equal(localResourcePath('docs/README.md', './guide%20one.md#part'), 'docs/guide one.md');
  for (const ref of ['../../outside.png', 'https://tracker.invalid/a.png', '//tracker.invalid/a.png', '/root/a.png', 'file:///secret.png', 'data:image/png;base64,AA', 'blob:https://a.test/id', '.env', '../.hidden/a.png', '%2fetc/a.png', 'a\\b.png', 'a%00.png', 'a%0a.png', '  a.png']) assert.equal(localResourcePath('docs/README.md', ref, 'image'), null, ref);
  assert.equal(localResourcePath('docs/README.md', 'diagram.svg', 'image'), null);
  assert.equal(localResourcePath('docs/README.md', 'diagram.html', 'image'), null);
});

test('only clean HTTPS anchors can open externally on a user click', () => {
  assert.equal(safeExternalURL('https://example.com/docs?x=1#next'), 'https://example.com/docs?x=1#next');
  for (const ref of ['http://example.com', '//example.com', 'javascript:alert(1)', 'data:text/html,hello', 'https://user:password@example.com', ' https://example.com', 'https://example.com\n']) assert.equal(safeExternalURL(ref), null);
});

test('documents cannot inject arbitrary application classes', () => {
  assert.equal(safeReaderClasses('modal reader-token-keyword hidden reader-source reader-unknown'), 'reader-token-keyword reader-source');
  assert.equal(safeReaderClasses('overlay welcome-shade'), '');
});

test('oversized generated HTML and aborted views stop before accessing the DOM', async () => {
  await assert.rejects(renderHTML({}, 'x'.repeat(2 * 1024 * 1024 + 1)), /HTML preview size limit/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(renderHTML({ signal: controller.signal }, '<h1>Late result</h1>'), { name: 'AbortError' });
});
