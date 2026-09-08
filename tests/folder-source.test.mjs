import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectorySource, createSnapshotSource } from '../public/folder-source.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPlanets } from '../lib/discover.mjs';

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

test('browser repository discovery matches the server and never opens Git marker bytes', async (t) => {
  let markerReads = 0;
  const marker = { kind: 'file', name: '.git', getFile() { markerReads += 1; throw new Error('Git marker bytes must stay unread'); } };
  const nested = directory('nested', { '.git': marker, 'inner.js': fileHandle(file('inner.js', 15)) });
  const repository = directory('repo', { '.git': marker, nested, 'README.md': fileHandle(file('README.md', 20)) });
  const root = directory('workspace', { '.git': marker, group: directory('group', { repo: repository, 'loose.md': fileHandle(file('loose.md', 10)) }), '.hidden': directory('.hidden', { '.git': marker }) });
  const local = await mkdtemp(path.join(os.tmpdir(), 'space-browser-parity-')); t.after(() => rm(local, { recursive: true, force: true }));
  await mkdir(path.join(local, 'group/repo/nested'), { recursive: true }); await mkdir(path.join(local, '.hidden'));
  for (const relative of ['.git', 'group/repo/.git', 'group/repo/nested/.git', '.hidden/.git']) await writeFile(path.join(local, relative), 'marker fixture');
  const source = createDirectorySource(root); t.after(() => source.dispose());
  const space = await source.readSpace();
  const canonical = (bodies) => bodies.map(({ id, path, kind }) => ({ id, path, kind }));
  assert.deepEqual(canonical(space.bodies), canonical((await discoverPlanets(local)).bodies).sort((a, b) => a.id.localeCompare(b.id)));
  assert.ok(space.bodies.every((b) => b.survey.pending)); assert.equal(markerReads, 0);
  const body = await source.readPlanet('group/repo');
  assert.equal(body.layer, 'planet'); assert.equal(body.restMass, 35); assert.equal(body.git.enabled, false);
  assert.deepEqual(body.atoms.map((a) => [a.id, a.path]), [['group/repo/nested/inner.js', 'nested/inner.js'], ['group/repo/README.md', 'README.md']].sort(([a], [b]) => a.localeCompare(b)));
  assert.ok(body.molecules.some((m) => m.id === 'nested' && m.repo && m.worktree));
  assert.equal((await source.getFile('group/repo/README.md')).size, 20);
  assert.equal(markerReads, 0); await assert.rejects(source.getFile('group/repo/.git'), { name: 'NotFoundError' });
  const belt = await source.readPlanet('__belt__'); assert.deepEqual(belt.atoms.map((a) => a.id), ['group/loose.md']);
  assert.deepEqual(source.search('README').map((a) => a.id), ['group/repo/README.md']);
});

test('snapshots discover raw Git paths before exclusions while preserving File identity and fallback limitations', async (t) => {
  const marker = file('config', 1, 1000, 'workspace/repo/.git/config');
  const readme = file('README.md', 100, 1000, 'workspace/repo/README.md');
  const loose = file('loose.txt', 20, 1000, 'workspace/loose.txt');
  const source = createSnapshotSource([marker, readme, loose]); t.after(() => source.dispose());
  assert.equal(source.live, false);
  const space = await source.readSpace(); assert.deepEqual(space.bodies.map((b) => b.id), ['__belt__', 'repo']);
  assert.match(space.discovery.limitation, /snapshot/i);
  const body = await source.readPlanet('repo'); assert.deepEqual(body.atoms.map((a) => a.id), ['repo/README.md']);
  assert.equal(await source.getFile('repo/README.md'), readme);
  await assert.rejects(source.getFile('repo/.git/config'), { name: 'NotFoundError' });
  const fallback = createSnapshotSource([readme]); t.after(() => fallback.dispose());
  assert.deepEqual((await fallback.readSpace()).bodies.map((b) => b.id), ['__belt__']);
  assert.equal((await fallback.readPlanet('__belt__')).restMass, 100);
});

test('live body edits brighten within one refresh while an incomplete refresh cannot manufacture deletion events', async (t) => {
  let now = 1000;
  const root = directory('workspace', { 'a.txt': fileHandle(file('a.txt', 100, now)) });
  const source = createDirectorySource(root, { maxFiles: 1, now: () => now, tickMs: 1e8 }); t.after(() => source.dispose());
  await source.readWorld();
  await source.readPlanet('__belt__');
  now += 6000; root.children.set('a.txt', fileHandle(file('a.txt', 100, now)));
  const changed = await source.readPlanet('__belt__');
  assert.equal(changed.atoms[0].rho, .05); assert.equal(changed.atoms[0].excitation, 5);
  assert.equal(changed.events[0].planetId, '__belt__');
  now += 6000; root.children.set('0.txt', fileHandle(file('0.txt', 200, now)));
  const partial = await source.readPlanet('__belt__');
  assert.equal(partial.survey.partial, true); assert.ok(!partial.events.some((e) => e.type === 'deleted'));
  await assert.rejects(source.getFile('a.txt'), { name: 'NotFoundError' });
});

test('explicit tour metadata is bounded and hidden definitions never become normal file targets', async (t) => {
  let contentReads = 0;
  const tourText = JSON.stringify({ id: 'onboarding', title: 'Fixture', stops: [{ path: 'README.md' }] });
  const tourFile = { ...file('guide.json', tourText.length), text: async () => { contentReads += 1; return tourText; } };
  const manifest = JSON.stringify({ main: 'src/start.js', scripts: { start: 'node src/start.js' } });
  const packageFile = { ...file('package.json', manifest.length), text: async () => { contentReads += 1; return manifest; } };
  const root = directory('workspace', { '.git': directory('.git'), '.space': directory('.space', { tours: directory('tours', { 'guide.json': fileHandle(tourFile) }) }), 'README.md': fileHandle(file('README.md')), 'package.json': fileHandle(packageFile), src: directory('src', { 'start.js': fileHandle(file('start.js')) }) });
  const source = createDirectorySource(root); t.after(() => source.dispose());
  const body = await source.readPlanet('.'); assert.equal(contentReads, 0); assert.ok(!body.atoms.some((a) => a.id.startsWith('.')));
  const tours = await source.tours(); assert.equal(contentReads, 2); assert.equal(tours.errors.length, 0);
  assert.equal(tours.tours[0].title, 'Fixture'); assert.equal(tours.tours[0].stops[0].id, 'README.md'); assert.equal(tours.tours[0].stops[0].missing, false);
  assert.deepEqual((await source.readPlanet('.')).entryPoints, ['src/start.js']);
  await assert.rejects(source.getFile('.space/tours/guide.json'), { name: 'NotFoundError' });
});
