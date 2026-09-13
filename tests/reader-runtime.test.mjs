import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBounded, relativeFilePath, runWorker } from '../public/readers/runtime.js';
import { classifyFile, rendererFor } from '../public/file-types.js';

test('classification selects the same inert source/document family for every caller', () => {
  for (const name of ['page.html', 'diagram.svg', 'component.mdx']) {
    const file = { name, ...classifyFile(name) };
    assert.equal(file.kind, 'text'); assert.equal(rendererFor(file), 'code');
  }
  for (const name of ['letter.docx', 'sheet.xlsx', 'sheet.xls', 'sheet.ods']) {
    const file = { name, ...classifyFile(name) };
    assert.equal(file.kind, 'document'); assert.equal(rendererFor(file), 'documents');
  }
  assert.equal(rendererFor({ name: 'README.MD', ...classifyFile('README.MD') }), 'markdown');
  assert.equal(rendererFor({ name: 'map.geojson', ...classifyFile('map.geojson') }), 'data');
  assert.equal(rendererFor({ name: 'deck.pptx', ...classifyFile('deck.pptx') }), null);
});

test('relative resources stay inside a visible selected path', () => {
  assert.equal(relativeFilePath('project/docs/README.md', '../images/photo.png'), 'project/images/photo.png');
  assert.equal(relativeFilePath('project/README.md', './notes.md#chapter'), 'project/notes.md');
  assert.equal(relativeFilePath('README.md', 'notes%20one.md'), 'notes one.md');
  for (const ref of ['../../escape.png', 'https://example.com/a.png', '//example.com/a.png', '/etc/passwd', '.env', '../.git/config', '%2e%2e/%2e%2e/a.png', 'C:/data.png', 'folder\\data.png', 'folder/%00.png']) {
    assert.equal(relativeFilePath('project/README.md', ref), null, ref);
  }
});

test('bounded fetch rejects declared and actual overflow without retaining the stream', async t => {
  let cancelled = 0;
  const make = (length, chunks) => ({ ok: true, headers: new Headers({ 'content-length': length }), body: new ReadableStream({
    pull(controller) { if (chunks.length) controller.enqueue(new Uint8Array(chunks.shift())); else controller.close(); },
    cancel() { cancelled++; },
  }) });
  t.mock.method(globalThis, 'fetch', async () => make('100', [[1, 2]]));
  await assert.rejects(fetchBounded('/local', 4), /size limit/); assert.equal(cancelled, 1);
  globalThis.fetch = async () => make('2', [[1, 2, 3], [4, 5, 6], [7, 8]]);
  await assert.rejects(fetchBounded('/local', 4), /size limit/); assert.equal(cancelled, 2);
  globalThis.fetch = async () => make('4', [[1, 2], [3, 4]]);
  assert.deepEqual(new Uint8Array(await fetchBounded('/local', 4)), new Uint8Array([1, 2, 3, 4]));
});

test('worker lifetime terminates on completion, explicit abort, and deadline', async t => {
  const original = globalThis.Worker, workers = [];
  class Worker {
    constructor() { this.terminated = 0; workers.push(this); }
    postMessage(value) { this.input = value; }
    terminate() { this.terminated++; }
  }
  globalThis.Worker = Worker; t.after(() => { globalThis.Worker = original; });
  const completed = runWorker('/worker.js', { file: 'fixture' });
  workers[0].onmessage({ data: { result: 'read' } });
  assert.equal(await completed, 'read'); assert.equal(workers[0].terminated, 1);
  const controller = new AbortController();
  const pending = runWorker('/worker.js', {}, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(workers[1].terminated, 1);
  await assert.rejects(runWorker('/worker.js', {}, { timeout: 5 }), /time budget/); assert.equal(workers[2].terminated, 1);
  const before = workers.length;
  await assert.rejects(runWorker('/worker.js', {}, { signal: controller.signal }), { name: 'AbortError' }); assert.equal(workers.length, before);
});
