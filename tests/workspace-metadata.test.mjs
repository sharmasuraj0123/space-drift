import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { createUniverseReader } from '../lib/universe.mjs';
import { readWorkspaceMetadata } from '../public/workspace-metadata.js';

test('tour metadata has a global byte/definition budget and package tokens remain literal safe paths', async () => {
  const calls = [];
  const result = await readWorkspaceMetadata([{ id: '.', kind: 'planet', path: '' }], {
    list: async () => Array.from({ length: 100 }, (_, i) => `${String(i).padStart(3, '0')}.json`),
    read: async (file, limit) => {
      calls.push({ file, limit });
      return { size: 131072, text: JSON.stringify({ id: file, stops: [{ path: 'README.md' }] }) };
    },
  });
  assert.equal(calls.length, 8); assert.equal(result.definitions.length, 8); assert.ok(result.errors.some((error) => /limit/i.test(error.error)));
  assert.ok(calls.every((call) => call.limit <= 131072));
  const packageResult = await readWorkspaceMetadata([{ id: '.', kind: 'planet', path: '' }], {
    list: async () => [], read: async () => ({ size: 50, text: JSON.stringify({ main: '../../outside.js', scripts: { start: 'node src/main.js && node ../outside.js && $(evil)' } }) }),
  });
  assert.deepEqual(packageResult.entryPoints['.'], ['src/main.js']);
  let definitionsRead = 0;
  const bounded = await readWorkspaceMetadata([], { list: async () => Array.from({ length: 100 }, (_, i) => `${i}.json`), read: async () => { definitionsRead += 1; return { size: 1, text: '{}' }; } });
  assert.equal(definitionsRead, 32); assert.equal(bounded.definitions.length, 32);
});

test('Node metadata rejects symlinked scopes and nonregular package files without opening their contents', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'space-metadata-')); t.after(() => rm(fixture, { recursive: true, force: true }));
  const root = path.join(fixture, 'selected'); const outside = path.join(fixture, 'outside');
  await mkdir(path.join(root, '.git'), { recursive: true }); await mkdir(path.join(outside, 'tours'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), 'fixture');
  await writeFile(path.join(outside, 'tours/escape.json'), JSON.stringify({ id: 'escaped', stops: [{ path: 'README.md' }] }));
  await symlink(outside, path.join(root, '.space'));
  await promisify(execFile)('mkfifo', [path.join(root, 'package.json')]);
  const universe = createUniverseReader(root, { git: false }); t.after(() => universe.dispose());
  await universe.readPlanet('.');
  const started = Date.now(); const metadata = await universe.tours();
  assert.ok(Date.now() - started < 1000); assert.ok(!metadata.tours.some((tour) => tour.id === 'escaped'));
  assert.ok(metadata.errors.length > 0); assert.deepEqual((await universe.readPlanet('.')).entryPoints, []);
  assert.ok(!universe.mappedAtoms().files.some((file) => file.path.startsWith('.space/') || file.path === 'package.json'));
});

test('Node tour directory enumeration and oversized definitions have honest bounded failures', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-metadata-limits-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git')); await mkdir(path.join(root, '.space/tours'), { recursive: true }); await writeFile(path.join(root, 'README.md'), 'fixture');
  await writeFile(path.join(root, '.space/tours/000-large.json'), 'x'.repeat(131073));
  const universe = createUniverseReader(root, { git: false }); t.after(() => universe.dispose()); await universe.readPlanet('.');
  assert.ok((await universe.tours()).errors.some((error) => /too large/i.test(error.error)));
  for (let i = 0; i < 70; i += 1) await writeFile(path.join(root, `.space/tours/${String(i + 1).padStart(3, '0')}.JSON`), JSON.stringify({ id: `fixture-${i}`, stops: [{ path: 'README.md' }] }));
  const result = await universe.tours();
  assert.ok(result.tours.filter((tour) => !tour.generated).length <= 32);
  assert.ok(result.errors.some((error) => /listing limit/i.test(error.error)));
});
