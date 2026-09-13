import test from 'node:test';
import assert from 'node:assert/strict';
import { createSampleSource, SAMPLE_LANDING_PATH, SAMPLE_FILE_PATH } from '../public/sample-source.js';
import { buildSpaceWorld, buildPlanetWorld } from '../public/bodies.js';

function sample(t) {
  const source = createSampleSource();
  t.after(() => source.dispose());
  return source;
}

test('the permission-free sample discovers three fully surveyed repository planets and a loose-file belt', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('The sample must not request network access.'); });
  const source = sample(t);
  assert.equal(source.kind, 'sample');
  assert.equal(source.live, false);
  assert.equal(source.name, 'Kepler sample');
  const space = await source.readSpace();
  assert.deepEqual(space.bodies.map(body => [body.id, body.kind]), [
    ['__belt__', 'belt'], ['field-notes', 'planet'], ['observatory', 'planet'], ['orbital-engine', 'planet'],
  ]);
  assert.equal(space.root.name, source.name);
  assert.equal(space.discovery.planets, 3);
  assert.equal(space.discovery.truncated, false);
  assert.match(space.discovery.limitation, /Built-in sample files held in memory/);
  assert.ok(space.bodies.every(body => !body.survey.pending && !body.survey.partial && body.restMass > 0));
  assert.ok(space.bodies.every(body => !body.git.enabled && body.git.reason === 'sample'));
  assert.equal(space.bodies.reduce((count, body) => count + body.fileCount, 0), 39);
  const belt = await source.readPlanet('__belt__');
  assert.deepEqual(belt.atoms.map(atom => atom.id), ['field-guide.txt', 'flight-plan.md', 'mission.json']);
  assert.ok(!source.mappedAtoms().files.some(file => file.path.includes('.git')));
});

test('the tutorial constants resolve through real planet physics to a reachable README atom', async t => {
  const source = sample(t);
  const space = buildSpaceWorld(await source.readSpace());
  const payload = await source.readPlanet(SAMPLE_LANDING_PATH);
  assert.equal(payload.layer, 'planet');
  assert.equal(payload.id, SAMPLE_LANDING_PATH);
  assert.equal(payload.git.reason, 'sample');
  assert.equal(payload.atoms.length, 12);
  assert.deepEqual(payload.molecules.map(molecule => molecule.id), ['.', 'gallery', 'instruments', 'observations', 'signals']);
  const world = buildPlanetWorld(payload, space);
  assert.equal(world.landingTargetId, SAMPLE_FILE_PATH);
  const readme = world.atoms.find(atom => atom.id === SAMPLE_FILE_PATH);
  assert.equal(readme.path, 'README.md');
  assert.equal(readme.element, 'markup');
  assert.ok(readme.atomicMass > 0 && readme.radius > 0);
  assert.ok(Object.values(readme.position).every(Number.isFinite));
  assert.ok(Math.hypot(world.landing.x - readme.position.x, world.landing.y - readme.position.y, world.landing.z - readme.position.z) < 18);
  assert.ok(world.molecules.find(molecule => molecule.id === 'signals').atomIds.length >= 4);
});

test('search and getFile expose meaningful text, code, CSV, and safe SVG through the common viewer API', async t => {
  const source = sample(t);
  await assert.rejects(source.getFile(SAMPLE_FILE_PATH), { name: 'NotFoundError' });
  await source.readSpace();
  assert.ok(source.search('README').some(atom => atom.id === SAMPLE_FILE_PATH));
  assert.equal(source.search('SPECTRUM').length, 4);
  assert.equal(source.search('spectrum', 2).length, 2);
  for (const [filename, type, content] of [
    [SAMPLE_FILE_PATH, 'text/markdown', /You have opened your first file/],
    ['orbital-engine/src/vector.js', 'text/javascript', /export const length/],
    ['observatory/signals/spectrum-01.csv', 'text/csv', /wavelength_nm,synthetic_intensity/],
    ['observatory/gallery/blue-planet.svg', 'image/svg+xml', /<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/],
  ]) {
    const file = await source.getFile(filename);
    assert.ok(file instanceof File);
    assert.equal(file.name, filename.split('/').at(-1));
    assert.equal(file.type, type);
    const text = await file.text();
    assert.match(text, content);
    assert.equal(new TextEncoder().encode(text).byteLength, file.size);
    if (type === 'image/svg+xml') assert.doesNotMatch(text, /<script|foreignObject|(?:href|src)=|onload=/i);
  }
  for (const path of ['observatory/.git/config', '../README.md', '/observatory/README.md', 'observatory/missing.txt']) {
    await assert.rejects(source.getFile(path), { name: 'NotFoundError' });
  }
});

test('sample metadata has varied ages and sizes without manufacturing live changes', async t => {
  const source = sample(t);
  const first = await source.readWorld();
  const second = await source.readWorld();
  assert.equal(first.files.length, 39);
  assert.equal(first.truncated, false);
  assert.equal(first.unreadable, 0);
  assert.deepEqual(second.files, first.files);
  assert.deepEqual(second.events, []);
  assert.ok(new Set(first.files.map(file => file.size)).size > 20);
  const times = first.files.map(file => Date.parse(file.modifiedAt));
  assert.ok(times.every(time => Number.isFinite(time) && time <= Date.now()));
  assert.ok(Math.max(...times) - Math.min(...times) > 7 * 24 * 3600000);
  const space = await source.readSpace();
  const after = await source.tick();
  assert.deepEqual(after.bodies.map(body => body.survey.revision), space.bodies.map(body => body.survey.revision));
  assert.deepEqual(after.events, []);
  assert.ok(after.bodies.every(body => body.excitation === 0));
  const tours = await source.tours();
  assert.deepEqual(tours.errors, []);
  assert.ok(tours.tours.length > 0);
});

test('cancellation and disposal reject pending sample operations without blocking a later fresh source', async t => {
  const source = sample(t);
  const controller = new AbortController();
  const pending = source.readSpace({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await source.readSpace();
  const openingController = new AbortController();
  const opening = source.getFile(SAMPLE_FILE_PATH, { signal: openingController.signal });
  openingController.abort();
  await assert.rejects(opening, { name: 'AbortError' });
  assert.match(await (await source.getFile(SAMPLE_FILE_PATH)).text(), /observatory/);

  const late = sample(t);
  const reading = late.readSpace();
  late.dispose();
  await assert.rejects(reading, { name: 'AbortError' });
  for (const operation of [() => late.readSpace(), () => late.readPlanet(SAMPLE_LANDING_PATH), () => late.readWorld(), () => late.getFile(SAMPLE_FILE_PATH), () => late.tours(), () => late.tick()]) {
    await assert.rejects(operation, { name: 'AbortError' });
  }
  for (const operation of [() => late.search('README'), () => late.planets(), () => late.mappedAtoms()]) assert.throws(operation, { name: 'AbortError' });
  late.dispose();
  const fresh = sample(t);
  assert.equal((await fresh.readSpace()).bodies.length, 4);
});

test('each sample owns independent File objects, survey state, and lifetime', async t => {
  const first = sample(t), second = sample(t);
  await Promise.all([first.readSpace(), second.readSpace()]);
  const one = await first.getFile(SAMPLE_FILE_PATH), two = await second.getFile(SAMPLE_FILE_PATH);
  assert.notEqual(one, two);
  assert.equal(await one.text(), await two.text());
  one.annotation = 'Only the first instance';
  assert.equal(two.annotation, undefined);
  const payload = await first.readPlanet(SAMPLE_LANDING_PATH);
  payload.atoms[0].name = 'Changed only in the first survey';
  assert.notEqual((await second.readPlanet(SAMPLE_LANDING_PATH)).atoms[0].name, payload.atoms[0].name);
  first.dispose();
  assert.ok(second.search('README').some(atom => atom.id === SAMPLE_FILE_PATH));
  assert.equal(await second.getFile(SAMPLE_FILE_PATH), two);
});
