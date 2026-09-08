import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { scanDirectory, diffSnapshots, createWorldReader } from '../lib/scan.mjs';
import { createServer } from '../server.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-drift-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('scanner maps relative metadata, ignores generated/hidden/secret files, never follows symlinks', async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, 'notes'));
  await mkdir(path.join(root, 'node_modules'));
  await mkdir(path.join(root, '.private'));
  await writeFile(path.join(root, 'notes/story.md'), 'small story');
  await writeFile(path.join(root, 'root.txt'), 'hi');
  await writeFile(path.join(root, 'node_modules/package.js'), 'ignored');
  await writeFile(path.join(root, '.private/data.txt'), 'ignored');
  await writeFile(path.join(root, '.env'), 'ignored');
  await writeFile(path.join(root, 'private.KEY'), 'ignored');
  await symlink(path.join(root, 'notes'), path.join(root, 'linked-notes'));
  await symlink(path.join(root, 'root.txt'), path.join(root, 'linked-file.txt'));
  const { world } = await scanDirectory(root);
  assert.deepEqual(world.files.map((file) => file.path), ['notes/story.md', 'root.txt']);
  assert.equal(world.files[0].parent, 'notes');
  assert.equal(world.files[0].extension, 'md');
  assert.equal(world.files[0].size, 11);
  assert.equal(world.files[1].parent, '.');
  assert.equal(world.truncated, false);
  assert.ok(Number.isFinite(Date.parse(world.scannedAt)));
  assert.deepEqual(Object.keys(world.files[0]).sort(), ['extension', 'id', 'modifiedAt', 'name', 'parent', 'path', 'size']);
});

test('scanner caps file count and avoids false deletions from incomplete maps', async (t) => {
  const root = await fixture(t);
  for (let index = 0; index < 5; index += 1) await writeFile(path.join(root, `${index}.txt`), 'test');
  const complete = await scanDirectory(root);
  const limited = await scanDirectory(root, { maxFiles: 2 });
  assert.equal(limited.world.files.length, 2);
  assert.equal(limited.world.truncated, true);
  assert.equal(limited.world.omittedIsLowerBound, false);
  assert.equal(limited.world.omitted, 3);
  assert.deepEqual(diffSnapshots(complete, limited), []);
});

test('a capped map samples neighboring top-level folders fairly', async (t) => {
  const root = await fixture(t);
  for (const name of ['huge', 'notes', 'photos']) await mkdir(path.join(root, name));
  for (let index = 0; index < 20; index += 1) await writeFile(path.join(root, `huge/${index}.txt`), 'large district');
  await writeFile(path.join(root, 'notes/story.md'), 'small district');
  await writeFile(path.join(root, 'photos/cover.jpg'), 'small district');
  await writeFile(path.join(root, 'root.txt'), 'root');
  const { world } = await scanDirectory(root, { maxFiles: 5 });
  assert.equal(world.files.length, 5);
  assert.ok(world.files.some((file) => file.path === 'notes/story.md'));
  assert.ok(world.files.some((file) => file.path === 'photos/cover.jpg'));
  assert.ok(world.files.some((file) => file.path === 'root.txt'));
  assert.equal(world.omitted, 18);
  assert.equal(world.truncated, true);
});

test('snapshot differences track creation, modification, deletion, and a verified move', async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, 'edit.txt'), 'before');
  await writeFile(path.join(root, 'remove.txt'), 'remove');
  await writeFile(path.join(root, 'move.txt'), 'move');
  const before = await scanDirectory(root);
  await writeFile(path.join(root, 'edit.txt'), 'after, more bytes');
  await utimes(path.join(root, 'edit.txt'), new Date(), new Date(Date.now() + 1000));
  await rename(path.join(root, 'move.txt'), path.join(root, 'moved.txt'));
  await rm(path.join(root, 'remove.txt'));
  await writeFile(path.join(root, 'created.txt'), 'created');
  const after = await scanDirectory(root);
  const changes = diffSnapshots(before, after);
  assert.ok(changes.some((event) => event.type === 'modified' && event.path === 'edit.txt'));
  assert.ok(changes.some((event) => event.type === 'created' && event.path === 'created.txt'));
  assert.ok(changes.some((event) => event.type === 'deleted' && event.path === 'remove.txt'));
  const hasIdentity = before.records.get('move.txt').identity;
  if (hasIdentity) assert.ok(changes.some((event) => event.type === 'moved' && event.previousPath === 'move.txt' && event.path === 'moved.txt'));
  assert.equal(new Set(changes.map((event) => event.id)).size, changes.length);
});

test('world reader retains recent events and shares concurrent scans', async (t) => {
  const root = await fixture(t);
  const readWorld = createWorldReader(root);
  assert.deepEqual((await readWorld()).events, []);
  for (let index = 0; index < 45; index += 1) await writeFile(path.join(root, `${index}.txt`), 'new');
  const first = readWorld();
  assert.equal(first, readWorld());
  const world = await first;
  assert.equal(world.events.length, 40);
  assert.equal(world.files.length, 45);
  assert.deepEqual((await readWorld()).events, world.events);
});

test('HTTP world map exposes only metadata and static routes stay restricted', async (t) => {
  const root = await fixture(t);
  const publicDirectory = path.join(root, 'public');
  const vendorDirectory = path.join(root, 'vendor');
  await mkdir(publicDirectory);
  await mkdir(vendorDirectory);
  await writeFile(path.join(publicDirectory, 'index.html'), '<h1>Space Drift</h1>');
  await writeFile(path.join(root, 'private.txt'), 'must never be served');
  await symlink(path.join(root, 'private.txt'), path.join(publicDirectory, 'escape.txt'));
  await symlink(path.join(root, 'private.txt'), path.join(vendorDirectory, 'three.module.js'));
  await writeFile(path.join(vendorDirectory, 'three.core.js'), 'export const trusted = true;');
  const server = createServer({ root, publicDirectory, vendorDirectory });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/api/health')).status, 200);
  assert.deepEqual(await (await fetch(base + '/runtime.json')).json(), { localServer: true });
  assert.match(await (await fetch(base + '/')).text(), /Space Drift/);
  const world = await (await fetch(base + '/api/world')).json();
  assert.ok(world.files.some((file) => file.path === 'private.txt'));
  assert.ok(!JSON.stringify(world).includes('must never be served'));
  assert.equal((await fetch(base + '/api/world', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/api/world', { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(base + '/private.txt')).status, 404);
  assert.equal((await fetch(base + '/escape.txt')).status, 403);
  assert.equal((await fetch(base + '/vendor/other.js')).status, 404);
  const escapedVendor = await fetch(base + '/vendor/three.module.js');
  assert.equal(escapedVendor.status, 403);
  assert.ok(!(await escapedVendor.text()).includes('must never be served'));
  assert.equal((await fetch(base + '/vendor/three.core.js')).status, 200);
  assert.equal((await fetch(base + '/.env')).status, 404);
  assert.equal((await fetch(base + '/api/files')).status, 404);
  const rawGet = (requestPath, headers = {}) => new Promise((resolve, reject) => {
    const request = http.get(base, { path: requestPath, headers }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
  });
  assert.equal((await rawGet('/%2e%2e/private.txt')).status, 403);
  const blockedHost = await rawGet('/api/world', { Host: 'attacker.example' });
  assert.equal(blockedHost.status, 403);
  assert.ok(!blockedHost.body.includes(root));
  assert.ok(!blockedHost.body.includes('private.txt'));
});
