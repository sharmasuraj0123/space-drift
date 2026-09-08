import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverPlanets } from '../lib/discover.mjs';
import { createUniverseReader } from '../lib/universe.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function repo(root, relative, marker = 'dir') {
  await mkdir(path.join(root, relative), { recursive: true });
  if (marker === 'dir') await mkdir(path.join(root, relative, '.git'));
  else await writeFile(path.join(root, relative, '.git'), 'gitdir: /missing/fixture');
}

test('discovery sorts repositories, stops at markers, respects constellations and root fallback rules', async (t) => {
  const root = await fixture(t);
  await repo(root, ''); await repo(root, 'zeta'); await repo(root, 'groups/alpha', 'file');
  await repo(root, 'groups/alpha/inner'); await repo(root, '.hidden'); await repo(root, 'node_modules/dependency');
  await symlink(path.join(root, 'zeta'), path.join(root, 'linked'));
  const found = await discoverPlanets(root, { maxPlanets: 1 });
  assert.deepEqual(found.planets.map((p) => [p.id, p.marker, p.constellation]), [['groups/alpha', 'file', 'groups']]);
  assert.deepEqual(found.overflow.map((p) => p.id), ['zeta']);
  assert.deepEqual(found.bodies.map((p) => p.id), ['groups/alpha', '__overflow__', '__belt__']);
  assert.equal(found.rootIsRepo, true);
  const plain = await fixture(t);
  assert.deepEqual((await discoverPlanets(plain)).bodies.map((p) => [p.id, p.path, p.kind]), [['__belt__', '', 'belt']]);
  await repo(plain, '');
  assert.deepEqual((await discoverPlanets(plain)).bodies.map((p) => [p.id, p.path, p.kind]), [['.', '', 'planet']]);
});

test('depth cutoff retains deeper repositories as belt molecules and reserved repository names remain distinct', async (t) => {
  const root = await fixture(t);
  for (const relative of ['a/b/c/deep', '__belt__', '__overflow__', '~__belt__']) await repo(root, relative);
  await writeFile(path.join(root, 'a/b/c/deep/deep.txt'), 'deep');
  const found = await discoverPlanets(root);
  assert.deepEqual(found.planets.map((p) => p.id).sort(), ['~__belt__', '~__overflow__', '~~__belt__'].sort());
  assert.equal(found.truncated, true);
  const universe = createUniverseReader(root, { git: false }); t.after(() => universe.dispose());
  const belt = await universe.readPlanet('__belt__');
  assert.ok(belt.molecules.some((m) => m.id === 'a/b/c/deep' && m.repo));
  assert.deepEqual(belt.atoms.map((a) => a.id), ['a/b/c/deep/deep.txt']);
});

test('belt and overflow own disjoint represented mass; empty remainder disappears after survey', async (t) => {
  const root = await fixture(t);
  for (const relative of ['a', 'b', 'group/c']) { await repo(root, relative); await writeFile(path.join(root, relative, 'file.txt'), relative); }
  await writeFile(path.join(root, 'group/loose.txt'), 'loose');
  const universe = createUniverseReader(root, { git: false, discoveryOptions: { maxPlanets: 1 } }); t.after(() => universe.dispose());
  const initial = await universe.readSpace(); assert.ok(initial.bodies.every((b) => b.survey.pending && b.restMass === 0));
  const payloads = await Promise.all(initial.bodies.map((b) => universe.readPlanet(b.id)));
  const allIds = payloads.flatMap((p) => p.atoms.map((a) => a.id));
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(payloads.find((p) => p.id === '__overflow__').restMass, 8);
  assert.deepEqual(payloads.find((p) => p.id === '__belt__').atoms.map((a) => a.id), ['group/loose.txt']);
  assert.equal(payloads.reduce((n, p) => n + p.restMass, 0), 14);
  const empty = await fixture(t); await repo(empty, 'repo'); await writeFile(path.join(empty, 'repo/root.txt'), 'x');
  const one = createUniverseReader(empty, { git: false }); t.after(() => one.dispose());
  await one.readPlanet('__belt__'); assert.deepEqual(one.planets().map((p) => p.id), ['repo']);
});

test('root planet has bare IDs and body caps limit represented additive mass', async (t) => {
  const root = await fixture(t); await repo(root, '');
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(root, name), '1234');
  const universe = createUniverseReader(root, { git: false, scannerOptions: { maxFiles: 2 } }); t.after(() => universe.dispose());
  const body = await universe.readPlanet('.');
  assert.deepEqual(body.atoms.map((a) => a.id), ['a.txt', 'b.txt']);
  assert.equal(body.restMass, 8); assert.equal(body.molecules[0].molecularMass, 8);
  assert.equal(body.survey.partial, true); assert.equal(body.survey.omitted, 1);
});

test('fifty repositories plus grouping loose files become ready through the bounded background survey queue', async (t) => {
  const root = await fixture(t);
  for (let i = 0; i < 50; i += 1) {
    const relative = i % 2 ? `group/repo-${String(i).padStart(2, '0')}` : `repo-${String(i).padStart(2, '0')}`;
    await repo(root, relative, i % 7 === 0 ? 'file' : 'dir'); await writeFile(path.join(root, relative, 'README.md'), 'fixture');
  }
  await writeFile(path.join(root, 'group/loose.txt'), 'loose');
  const universe = createUniverseReader(root, { git: false }); t.after(() => universe.dispose());
  const started = performance.now(); const first = await universe.readSpace(); const discoveryMs = performance.now() - started;
  assert.equal(first.discovery.planets, 50); assert.equal(first.bodies.length, 51); assert.ok(first.bodies.every((body) => body.survey.pending));
  assert.ok(discoveryMs < 2000, `discovery took ${discoveryMs} ms`);
  let space;
  do { await new Promise((resolve) => setTimeout(resolve, 5)); space = await universe.readSpace(); } while (space.bodies.some((body) => body.survey.pending) && performance.now() - started < 5000);
  assert.ok(space.bodies.every((body) => !body.survey.pending)); assert.equal(space.bodies.reduce((total, body) => total + body.fileCount, 0), 51);
  t.diagnostic(`50 repositories + belt: discovery ${discoveryMs.toFixed(1)} ms, all metadata ready ${(performance.now() - started).toFixed(1)} ms; Git intentionally disabled for metadata-readiness timing.`);
});
