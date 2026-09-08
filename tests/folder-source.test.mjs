import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorySource, createSnapshotSource } from '../public/folder-source.js';

function file(name, size = 10, lastModified = 1000, webkitRelativePath = '') {
  return { name, size, lastModified, webkitRelativePath,
    text() { throw new Error('Mapping must not read contents'); },
    arrayBuffer() { throw new Error('Mapping must not read contents'); },
  };
}

function fileHandle(value) { return { kind: 'file', name: value.name, async getFile() { return value; } }; }
function directory(name, initial = {}) {
  const children = new Map(Object.entries(initial));
  return {
    kind: 'directory', name, children,
    async *entries() { yield* children.entries(); },
    async getDirectoryHandle(key, options) {
      assert.deepEqual(options, { create: false });
      if (children.get(key)?.kind !== 'directory') throw Object.assign(new Error('Missing folder'), { name: 'NotFoundError' });
      return children.get(key);
    },
    async getFileHandle(key, options) {
      assert.deepEqual(options, { create: false });
      if (children.get(key)?.kind !== 'file') throw Object.assign(new Error('Missing file'), { name: 'NotFoundError' });
      return children.get(key);
    },
  };
}

const paths = (world) => world.files.map((entry) => entry.path);

test('directory source maps metadata only and resolves current File objects with read-only handles', async () => {
  const note = file('note.md');
  const nested = directory('notes', { 'note.md': fileHandle(note) });
  const root = directory('My folder', { notes: nested, 'root.txt': fileHandle(file('root.txt')) });
  const source = createDirectorySource(root);
  assert.equal(source.kind, 'directory');
  assert.equal(source.live, true);
  assert.equal(source.name, 'My folder');
  await assert.rejects(source.getFile('notes/note.md'), { name: 'NotFoundError' });
  const world = await source.readWorld();
  assert.deepEqual(world.root, { name: 'My folder', path: 'My folder' });
  assert.deepEqual(paths(world), ['notes/note.md', 'root.txt']);
  assert.deepEqual(world.files[0], { id: 'notes/note.md', path: 'notes/note.md', name: 'note.md', parent: 'notes', size: 10, modifiedAt: new Date(1000).toISOString(), extension: 'md' });
  assert.deepEqual(world.events, []);
  assert.equal(world.truncated, false);
  assert.equal(await source.getFile('notes/note.md'), note);
  const updated = file('note.md', 20, 2000);
  nested.children.set('note.md', fileHandle(updated));
  assert.equal(await source.getFile('notes/note.md'), updated);
  nested.children.delete('note.md');
  await assert.rejects(source.getFile('notes/note.md'), { name: 'NotFoundError' });
  source.dispose();
});

test('directory mapping excludes hidden, generated, secret, unsafe, and ambiguous paths', async () => {
  const root = directory('root', {
    '.env': fileHandle(file('.env')), 'private.KEY': fileHandle(file('private.KEY')),
    node_modules: directory('node_modules', { 'hidden.js': fileHandle(file('hidden.js')) }),
    '.private': directory('.private', { 'hidden.txt': fileHandle(file('hidden.txt')) }),
    '..': directory('..', { 'escape.txt': fileHandle(file('escape.txt')) }),
    'a/b.txt': fileHandle(file('b.txt')), 'C:evil.txt': fileHandle(file('C:evil.txt')),
    'valid.txt': fileHandle(file('valid.txt')),
  });
  const source = createDirectorySource(root);
  assert.deepEqual(paths(await source.readWorld()), ['valid.txt']);
  for (const requested of ['../valid.txt', '/valid.txt', '.env', 'node_modules/hidden.js', 'valid.txt\0', 'missing.txt']) {
    await assert.rejects(source.getFile(requested), { name: 'NotFoundError' });
  }
  const repeated = directory('duplicate');
  repeated.entries = async function* () { yield ['a.txt', fileHandle(file('a.txt'))]; yield ['a.txt', fileHandle(file('a.txt', 12))]; };
  assert.deepEqual(paths(await createDirectorySource(repeated).readWorld()), []);
});

test('directory refresh tracks add/edit/delete, retains 40 events, and does not fabricate deletions for partial maps', async () => {
  const root = directory('root', { 'first.txt': fileHandle(file('first.txt')) });
  const source = createDirectorySource(root, { maxFiles: 2 });
  await source.readWorld();
  root.children.set('first.txt', fileHandle(file('first.txt', 10, 2000)));
  root.children.set('second.txt', fileHandle(file('second.txt')));
  let world = await source.readWorld();
  assert.ok(world.events.some((event) => event.type === 'modified' && event.path === 'first.txt'));
  assert.ok(world.events.some((event) => event.type === 'created' && event.path === 'second.txt'));
  root.children.delete('first.txt');
  world = await source.readWorld();
  assert.ok(world.events.some((event) => event.type === 'deleted' && event.path === 'first.txt'));
  const beforeIds = new Set(world.events.map((event) => event.id));
  root.children.set('a.txt', fileHandle(file('a.txt')));
  root.children.set('b.txt', fileHandle(file('b.txt')));
  world = await source.readWorld();
  assert.equal(world.truncated, true);
  assert.equal(world.events.filter((event) => !beforeIds.has(event.id)).length, 0);
  await assert.rejects(source.getFile('second.txt'), { name: 'NotFoundError' });
  const many = createDirectorySource(root);
  await many.readWorld();
  for (let index = 0; index < 45; index += 1) root.children.set(`${index}.md`, fileHandle(file(`${index}.md`)));
  world = await many.readWorld();
  assert.equal(world.events.length, 40);
  assert.deepEqual((await many.readWorld()).events, world.events);
});

test('directory file budget samples districts fairly and reports entry/depth/time limits', async () => {
  const huge = directory('huge');
  for (let index = 0; index < 20; index += 1) huge.children.set(`${index}.txt`, fileHandle(file(`${index}.txt`)));
  const root = directory('root', { huge, notes: directory('notes', { 'story.md': fileHandle(file('story.md')) }), 'root.txt': fileHandle(file('root.txt')) });
  const limited = createDirectorySource(root, { maxFiles: 3 });
  const world = await limited.readWorld();
  assert.equal(world.files.length, 3);
  assert.ok(paths(world).includes('root.txt'));
  assert.ok(paths(world).includes('notes/story.md'));
  assert.equal(world.omitted, 19);
  assert.equal(world.omittedIsLowerBound, false);
  assert.deepEqual(paths(await createDirectorySource(root, { maxDepth: 0 }).readWorld()), ['root.txt']);
  const entries = await createDirectorySource(root, { maxEntries: 1 }).readWorld();
  assert.equal(entries.truncated, true);
  assert.equal(entries.omittedIsLowerBound, true);
  assert.deepEqual(paths(await createDirectorySource(root, { maxFiles: 0 }).readWorld()), []);
  const stalled = directory('stalled');
  stalled.entries = () => ({ [Symbol.asyncIterator]() { return this; }, next() { return new Promise(() => {}); } });
  const timed = await createDirectorySource(stalled, { maxDurationMs: 10 }).readWorld();
  assert.equal(timed.truncated, true);
  assert.equal(timed.omittedIsLowerBound, true);
});

test('root permission failures reject without replacing the last map while nested failures stay partial', async () => {
  const original = file('note.md');
  const root = directory('root', { 'note.md': fileHandle(original) });
  const workingEntries = root.entries;
  const deniedEntries = async function* () { throw Object.assign(new Error('Folder permission revoked'), { name: 'NotAllowedError' }); };
  root.entries = deniedEntries;
  const source = createDirectorySource(root);
  await assert.rejects(source.readWorld(), { name: 'NotAllowedError' });
  await assert.rejects(source.getFile('note.md'), { name: 'NotFoundError' });
  root.entries = workingEntries;
  assert.deepEqual(paths(await source.readWorld()), ['note.md']);
  root.entries = deniedEntries;
  await assert.rejects(source.readWorld(), { name: 'NotAllowedError' });
  assert.equal(await source.getFile('note.md'), original);
  root.children.set('note.md', fileHandle(file('note.md', 10, 2000)));
  root.entries = workingEntries;
  const recovered = await source.readWorld();
  assert.ok(recovered.events.some((event) => event.type === 'modified' && event.path === 'note.md'));
  assert.ok(!recovered.events.some((event) => event.type === 'created' || event.type === 'deleted'));
  const nested = directory('blocked');
  nested.entries = deniedEntries;
  root.children.set('blocked', nested);
  const partial = await source.readWorld();
  assert.deepEqual(paths(partial), ['note.md']);
  assert.equal(partial.unreadable, 1);
  assert.equal(partial.omittedIsLowerBound, true);
});

test('snapshot strips exactly one shared selected-folder prefix and keeps original File objects', async () => {
  const note = file('note.md', 11, 1000, 'Chosen/notes/note.md');
  const top = file('root.txt', 12, 2000, 'Chosen/root.txt');
  const source = createSnapshotSource({ 0: note, 1: top, length: 2 });
  assert.equal(source.kind, 'snapshot');
  assert.equal(source.live, false);
  assert.equal(source.name, 'Chosen');
  const world = await source.readWorld();
  assert.deepEqual(paths(world), ['notes/note.md', 'root.txt']);
  assert.equal(await source.getFile('notes/note.md'), note);
  assert.deepEqual((await source.readWorld()).events, []);
  await assert.rejects(source.getFile('Chosen/notes/note.md'), { name: 'NotFoundError' });
  const mixed = createSnapshotSource([file('a.txt', 1, 1, 'One/a.txt'), file('b.txt', 1, 1, 'Two/b.txt')], { name: 'My selection' });
  assert.equal(mixed.name, 'My selection');
  assert.deepEqual(paths(await mixed.readWorld()), ['One/a.txt', 'Two/b.txt']);
  assert.deepEqual(paths(await createSnapshotSource([file('plain.txt')]).readWorld()), ['plain.txt']);
});

test('snapshot rejects traversal, duplicates, hidden/generated files and enforces all mapping caps', async () => {
  const selected = [
    file('a.txt', 1, 1, 'Root/a.txt'), file('a.txt', 2, 2, 'Root/a.txt'),
    file('valid.txt', 3, 3, 'Root/valid.txt'), file('.env', 1, 1, 'Root/.env'),
    file('package.js', 1, 1, 'Root/node_modules/package.js'), file('secret.pem', 1, 1, 'Root/secret.pem'),
    file('escape.txt', 1, 1, 'Root/../escape.txt'), file('nested.md', 1, 1, 'Root/notes/nested.md'),
  ];
  const source = createSnapshotSource(selected);
  assert.deepEqual(paths(await source.readWorld()), ['notes/nested.md', 'valid.txt']);
  await assert.rejects(source.getFile('a.txt'), { name: 'NotFoundError' });
  assert.deepEqual(paths(await createSnapshotSource([file('bad.txt', 1, 1, '../bad.txt')]).readWorld()), []);
  assert.deepEqual(paths(await createSnapshotSource([file('bad.txt', 1, 1, 'C:/bad.txt')]).readWorld()), []);
  assert.deepEqual(paths(await createSnapshotSource(selected, { maxDepth: 0 }).readWorld()), ['valid.txt']);
  assert.equal((await createSnapshotSource(selected, { maxEntries: 1 }).readWorld()).truncated, true);
  assert.equal((await createSnapshotSource(selected, { maxFiles: 1 }).readWorld()).files.length, 1);
  assert.equal((await createSnapshotSource(selected, { maxDurationMs: 0 }).readWorld()).truncated, true);
});

test('intentionally hidden snapshot files stay excluded without marking an otherwise complete map unreadable', async () => {
  const selected = [
    file('README.md', 10, 1000, 'Chosen/README.md'),
    file('journey.md', 10, 1000, 'Chosen/notes/journey.md'),
    file('.env', 10, 1000, 'Chosen/.env'),
    file('secret.md', 10, 1000, 'Chosen/.private/secret.md'),
    file('package.js', 10, 1000, 'Chosen/node_modules/package.js'),
    file('secret.pem', 10, 1000, 'Chosen/secret.pem'),
  ];
  const snapshotSource = createSnapshotSource(selected);
  const snapshotWorld = await snapshotSource.readWorld();
  const root = directory('Chosen', {
    'README.md': fileHandle(file('README.md')),
    notes: directory('notes', { 'journey.md': fileHandle(file('journey.md')) }),
    '.env': fileHandle(file('.env')),
    '.private': directory('.private', { 'secret.md': fileHandle(file('secret.md')) }),
    node_modules: directory('node_modules', { 'package.js': fileHandle(file('package.js')) }),
    'secret.pem': fileHandle(file('secret.pem')),
  });
  const directoryWorld = await createDirectorySource(root).readWorld();
  assert.deepEqual(paths(snapshotWorld), paths(directoryWorld));
  for (const world of [snapshotWorld, directoryWorld]) {
    assert.equal(world.unreadable, 0);
    assert.equal(world.truncated, false);
    assert.equal(world.omitted, 0);
    assert.equal(world.omittedIsLowerBound, false);
  }
  for (const hidden of ['.env', '.private/secret.md']) {
    await assert.rejects(snapshotSource.getFile(hidden), { name: 'NotFoundError' });
  }
});

test('cancellation and disposal cannot publish a late scan or return a late file', async () => {
  let finish;
  const root = directory('root', { 'late.txt': { kind: 'file', name: 'late.txt', getFile: () => new Promise((resolve) => { finish = resolve; }) } });
  const source = createDirectorySource(root);
  const controller = new AbortController();
  const pending = source.readWorld({ signal: controller.signal });
  while (!finish) await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  finish(file('late.txt'));
  await assert.rejects(source.getFile('late.txt'), { name: 'NotFoundError' });
  root.children.set('late.txt', fileHandle(file('late.txt')));
  await source.readWorld();
  root.children.set('late.txt', { kind: 'file', name: 'late.txt', getFile: () => new Promise((resolve) => { finish = resolve; }) });
  finish = null;
  const opening = source.getFile('late.txt');
  while (!finish) await Promise.resolve();
  source.dispose();
  await assert.rejects(opening, { name: 'AbortError' });
  finish(file('late.txt'));
  await assert.rejects(source.readWorld(), { name: 'AbortError' });
  await assert.rejects(source.getFile('late.txt'), { name: 'AbortError' });
  source.dispose();
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(createSnapshotSource([file('a.txt')]).readWorld({ signal: alreadyAborted.signal }), { name: 'AbortError' });
});
