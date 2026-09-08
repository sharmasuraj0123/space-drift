import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLocalFile, createLocalPreviewSession, TEXT_PREVIEW_LIMIT } from '../public/preview.js';

function session() {
  const created = [], revoked = [];
  const preview = createLocalPreviewSession({
    createObjectURL(blob) { const url = `blob:preview-${created.length}`; created.push({ url, blob }); return url; },
    revokeObjectURL(url) { revoked.push(url); },
  });
  return { preview, created, revoked };
}

test('HTML, SVG, and source markup stay plain text; MIME cannot enable active content', async () => {
  const { preview, created } = session();
  const contents = '<svg onload="alert(1)"><script>fetch("https://example.com")</script></svg>';
  for (const name of ['page.HTML', 'diagram.svg', 'main.js']) {
    const result = await preview.open(new File([contents], name, { type: 'text/html', lastModified: 1000 }), name);
    assert.equal(result.kind, 'text');
    assert.equal(result.mime, 'text/plain; charset=utf-8');
    assert.equal(result.text, contents);
    assert.equal(result.contentUrl, undefined);
  }
  assert.equal(created.length, 0);
});

test('text reads are capped by bytes without splitting a trailing UTF-8 character', async () => {
  const { preview } = session();
  const file = new File(['a'.repeat(TEXT_PREVIEW_LIMIT - 1), '🚀', 'tail'], 'large.md');
  const slices = [];
  const originalSlice = file.slice.bind(file);
  file.slice = (...args) => { slices.push(args); return originalSlice(...args); };
  const result = await preview.open(file, 'notes/large.md');
  assert.equal(result.text, 'a'.repeat(TEXT_PREVIEW_LIMIT - 1));
  assert.equal(result.truncated, true);
  assert.equal(result.path, 'notes/large.md');
  assert.deepEqual(slices, [[0, TEXT_PREVIEW_LIMIT]]);
});

test('unknown files and disguised binary text have no media URL', async () => {
  const { preview, created } = session();
  for (const file of [new File(['document'], 'report.docx', { type: 'text/html' }), new File([new Uint8Array([0, 1, 2])], 'binary.txt')]) {
    const result = await preview.open(file, file.name);
    assert.equal(result.kind, 'unsupported');
    assert.equal(result.contentUrl, undefined);
    assert.equal(result.text, undefined);
  }
  assert.equal(created.length, 0);
  assert.equal(classifyLocalFile('README').kind, 'text');
});

test('allowlisted media uses a forced MIME and only the active created URL is trusted', async () => {
  const { preview, created, revoked } = session();
  const first = await preview.open(new File(['image'], 'photo.png', { type: 'text/html' }), 'photo.png');
  assert.equal(created[0].blob.type, 'image/png');
  assert.equal(preview.owns(first.contentUrl), true);
  assert.equal(preview.owns('blob:foreign'), false);
  assert.equal(preview.owns('https://example.com/photo.png'), false);
  const second = await preview.open(new File(['video'], 'clip.mp4'), 'clip.mp4');
  assert.deepEqual(revoked, [first.contentUrl]);
  assert.equal(preview.owns(first.contentUrl), false);
  assert.equal(preview.owns(second.contentUrl), true);
  preview.clear(); preview.clear();
  assert.deepEqual(revoked, [first.contentUrl, second.contentUrl]);
  assert.equal(preview.owns(second.contentUrl), false);
});

test('abort revokes active media and stale asynchronous reads cannot replace newer previews', async () => {
  const { preview, revoked } = session();
  const controller = new AbortController();
  const result = await preview.open(new File(['audio'], 'recording.mp3'), 'recording.mp3', { signal: controller.signal });
  controller.abort();
  assert.deepEqual(revoked, [result.contentUrl]);
  assert.equal(preview.owns(result.contentUrl), false);

  let resolveRead;
  const pendingBytes = new Promise((resolve) => { resolveRead = resolve; });
  const pending = preview.open({ name: 'slow.txt', size: 3, lastModified: 1, slice: () => ({ arrayBuffer: () => pendingBytes }) }, 'slow.txt');
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  const next = await preview.open(new File(['pdf'], 'new.pdf'), 'new.pdf');
  resolveRead(new TextEncoder().encode('old').buffer);
  await rejection;
  assert.equal(preview.owns(next.contentUrl), true);
  assert.deepEqual(revoked, [result.contentUrl]);
  preview.clear();
});

test('an aborted text read stops waiting even when the underlying read never settles', async () => {
  const { preview } = session();
  const controller = new AbortController();
  const pending = preview.open({ name: 'slow.txt', size: 3, lastModified: 1, slice: () => ({ arrayBuffer: () => new Promise(() => {}) }) }, 'slow.txt', { signal: controller.signal });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejection;
});
