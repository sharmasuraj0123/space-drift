import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorldReader } from '../lib/scan.mjs';
import { FileAccessError, TEXT_PREVIEW_LIMIT, launchMappedFile, openMappedFile, parseByteRange, readFilePreview } from '../lib/files.mjs';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-drift-files-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('text files open as plain JSON strings, preserving markup without execution', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'notes'));
  const contents = '<script>alert("never execute")</script>\nHello 🚀';
  await writeFile(path.join(root, 'notes/story.html'), contents);
  const preview = await readFilePreview(root, 'notes/story.html', createWorldReader(root));
  assert.equal(preview.path, 'notes/story.html');
  assert.equal(preview.name, 'story.html');
  assert.equal(preview.kind, 'text');
  assert.equal(preview.mime, 'text/plain; charset=utf-8');
  assert.equal(preview.text, contents);
  assert.equal(preview.truncated, false);
  assert.equal(preview.contentUrl, undefined);
  assert.equal(preview.desktopAction, 'open');
  assert.equal(preview.size, Buffer.byteLength(contents));
  assert.ok(Number.isFinite(Date.parse(preview.modifiedAt)));
});

test('native open sends text to an editor, known documents to apps, and executable/unknown files to Finder', async (t) => {
  const root = await fixture(t);
  const names = ['code.sh', 'page.html', 'drawing.svg', 'report.docx', 'sheet.xlsx', 'picture.png', 'launch.command', 'archive.zip', '-odd;$(name).bin'];
  for (const name of names) await writeFile(path.join(root, name), 'test fixture');
  const calls = [];
  const execute = async (...args) => { calls.push(args); };
  const readWorld = createWorldReader(root);
  for (const name of names) {
    const result = await launchMappedFile(root, name, readWorld, { platform: 'darwin', execute });
    const reveal = ['launch.command', 'archive.zip', '-odd;$(name).bin'].includes(name);
    const text = ['code.sh', 'page.html', 'drawing.svg'].includes(name);
    assert.deepEqual(result, { ok: true, action: reveal ? 'revealed' : 'opened' });
    const [program, args, options] = calls.at(-1);
    assert.equal(program, '/usr/bin/open');
    assert.deepEqual(args, [...(reveal ? ['-R'] : text ? ['-t'] : []), path.join(root, name)]);
    assert.equal(options.timeout, 10000);
    assert.equal(options.shell, undefined);
    assert.equal((await readFilePreview(root, name, readWorld)).desktopAction, reveal ? 'reveal' : 'open');
  }
  const count = calls.length;
  await assert.rejects(launchMappedFile(root, '../escape', readWorld, { platform: 'darwin', execute }), (error) => error.status === 403);
  await assert.rejects(launchMappedFile(root, 'missing.txt', readWorld, { platform: 'darwin', execute }), (error) => error.status === 404);
  await assert.rejects(launchMappedFile(root, 'code.sh', readWorld, { platform: 'linux', execute }), (error) => error.status === 501);
  assert.equal(calls.length, count);
  await assert.rejects(launchMappedFile(root, 'code.sh', readWorld, { platform: 'darwin', execute: async () => { throw new Error('app unavailable'); } }), /app unavailable/);
});

test('native open API requires same-origin JSON POST with a bounded body and valid mapped path', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'note.md'), 'test fixture');
  const calls = [];
  const server = createServer({ root, nativePlatform: 'darwin', nativeExecutor: async (...args) => { calls.push(args); } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (body, headers = {}) => fetch(`${base}/api/open-file`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body,
  });
  assert.equal((await fetch(`${base}/api/open-file`)).status, 405);
  assert.equal((await request('{"path":"note.md"}', { Origin: '' })).status, 403);
  assert.equal((await request('{"path":"note.md"}', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await request('{"path":"note.md"}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request('{broken')).status, 400);
  assert.equal((await request('null')).status, 400);
  assert.equal((await request('["note.md"]')).status, 400);
  assert.equal((await request(JSON.stringify({ path: 'x'.repeat(4096) }))).status, 413);
  assert.equal((await request('{"path":"../note.md"}')).status, 403);
  assert.equal((await request('{"path":"missing.txt"}')).status, 404);
  assert.equal(calls.length, 0);
  const opened = await request('{"path":"note.md"}');
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true, action: 'opened' });
  assert.deepEqual(calls[0][1], ['-t', path.join(root, 'note.md')]);
});

test('preview limits large text and treats unknown or binary files as unsupported', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'large.md'), 'a'.repeat(TEXT_PREVIEW_LIMIT - 1) + '🚀' + 'b'.repeat(10));
  await writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(root, 'archive.zip'), 'unknown format');
  const readWorld = createWorldReader(root);
  const large = await readFilePreview(root, 'large.md', readWorld);
  assert.equal(large.text, 'a'.repeat(TEXT_PREVIEW_LIMIT - 1));
  assert.equal(large.truncated, true);
  for (const name of ['binary.txt', 'archive.zip']) {
    const preview = await readFilePreview(root, name, readWorld);
    assert.equal(preview.kind, 'unsupported');
    assert.equal(preview.text, undefined);
    assert.equal(preview.contentUrl, undefined);
  }
});

test('file access rejects traversal, hidden paths, secrets, generated files and unscanned entries', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'valid.txt'), 'visible');
  await writeFile(path.join(root, '.env'), 'test fixture only');
  await writeFile(path.join(root, 'private.KEY'), 'test fixture only');
  await mkdir(path.join(root, 'node_modules'));
  await writeFile(path.join(root, 'node_modules/hidden.js'), 'ignored');
  const readWorld = createWorldReader(root);
  for (const requested of ['', null, '../valid.txt', '/valid.txt', 'C:/valid.txt', 'folder\\valid.txt', './valid.txt', 'x/../valid.txt', 'x//valid.txt', 'valid.txt\0', '.env', 'private.KEY', 'node_modules/hidden.js', 'missing.txt']) {
    await assert.rejects(readFilePreview(root, requested, readWorld), (error) => error instanceof FileAccessError && [403, 404].includes(error.status), requested);
  }
  const emptyMap = createWorldReader(root, { maxFiles: 0 });
  await assert.rejects(readFilePreview(root, 'valid.txt', emptyMap), (error) => error.status === 404);
  // Eligibility is checked before opening: omitted files are never read.
  assert.equal((await readFilePreview(root, 'valid.txt', readWorld)).text, 'visible');
});

test('symlinks cannot replace mapped files or an intermediate directory between scans', async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await mkdir(path.join(root, 'notes'));
  await writeFile(path.join(root, 'notes/file.txt'), 'mapped fixture');
  await writeFile(path.join(root, 'root.txt'), 'mapped fixture');
  await writeFile(path.join(outside, 'file.txt'), 'outside fixture');
  const snapshot = await createWorldReader(root)();
  const staleReader = async () => snapshot;
  await rm(path.join(root, 'root.txt'));
  await symlink(path.join(outside, 'file.txt'), path.join(root, 'root.txt'));
  await assert.rejects(openMappedFile(root, 'root.txt', staleReader), (error) => error.status === 403);
  await rename(path.join(root, 'notes'), path.join(root, 'saved-notes'));
  await symlink(outside, path.join(root, 'notes'));
  await assert.rejects(openMappedFile(root, 'notes/file.txt', staleReader), (error) => error.status === 403);
});

test('media byte ranges support explicit, open-ended and suffix requests', () => {
  assert.equal(parseByteRange(undefined, 20), null);
  assert.deepEqual(parseByteRange('bytes=2-5', 20), { start: 2, end: 5 });
  assert.deepEqual(parseByteRange('bytes=7-', 20), { start: 7, end: 19 });
  assert.deepEqual(parseByteRange('bytes=-4', 20), { start: 16, end: 19 });
  assert.deepEqual(parseByteRange('bytes=-50', 20), { start: 0, end: 19 });
  assert.deepEqual(parseByteRange('bytes=0-50', 20), { start: 0, end: 19 });
  for (const header of ['bytes=', 'bytes=-', 'bytes=-0', 'bytes=20-', 'bytes=4-2', 'bytes=0-2,4-8', 'items=1-2', 'bytes=9007199254740992-']) {
    assert.throws(() => parseByteRange(header, 20), (error) => error.status === 416);
  }
  assert.throws(() => parseByteRange('bytes=0-', 0), (error) => error.status === 416);
});

test('HTTP file preview provides text and seekable media while enforcing access boundaries', async (t) => {
  const root = await fixture(t);
  const html = '<h1>fixture only</h1><script>location="https://example.com"</script>';
  const media = Buffer.from('fixture media bytes');
  await writeFile(path.join(root, 'note.html'), html);
  await writeFile(path.join(root, 'a #&?.mp4'), media);
  await writeFile(path.join(root, 'picture.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(path.join(root, 'unknown.bin'), media);
  await writeFile(path.join(root, '.env'), 'test fixture only');
  await writeFile(path.join(root, 'private.pem'), 'test fixture only');
  const server = createServer({ root });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.name, 'Space Drift');
  assert.ok(health.capabilities.includes('file-preview'));
  const response = await fetch(`${base}/api/file?path=note.html`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await response.json()).text, html);
  assert.equal((await fetch(`${base}/api/file-content?path=note.html`)).status, 415);
  assert.equal((await fetch(`${base}/api/file-content?path=unknown.bin`)).status, 415);
  const preview = await (await fetch(`${base}/api/file?path=${encodeURIComponent('a #&?.mp4')}`)).json();
  assert.equal(preview.kind, 'video');
  assert.equal(preview.text, undefined);
  const whole = await fetch(base + preview.contentUrl);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/mp4');
  assert.equal(whole.headers.get('content-length'), String(media.length));
  assert.deepEqual(Buffer.from(await whole.arrayBuffer()), media);
  const partial = await fetch(base + preview.contentUrl, { headers: { Range: 'bytes=2-6' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 2-6/${media.length}`);
  assert.equal(partial.headers.get('content-length'), '5');
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), media.subarray(2, 7));
  const invalid = await fetch(base + preview.contentUrl, { headers: { Range: 'bytes=9999-' } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${media.length}`);
  const svg = await fetch(`${base}/api/file-content?path=picture.svg`);
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-security-policy'), /script-src 'none'; sandbox/);
  assert.equal(svg.headers.get('cross-origin-resource-policy'), 'same-origin');
  await svg.arrayBuffer();
  for (const route of ['/api/file', '/api/file-content']) {
    assert.equal((await fetch(`${base}${route}?path=note.html`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}${route}?path=note.html`, { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(`${base}${route}?path=..%2Fnote.html`)).status, 403);
    assert.equal((await fetch(`${base}${route}?path=.env`)).status, 403);
    assert.equal((await fetch(`${base}${route}?path=private.pem`)).status, 404);
    assert.equal((await fetch(`${base}${route}`)).status, 403);
  }
});
