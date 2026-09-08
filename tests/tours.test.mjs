import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTour, resolveTour, generateOnboardingTour, createTourState, tourReducer, exportTour } from '../public/tours.js';
import { planRoute } from '../public/layers.js';

const bodies = [{ id: 'a', path: 'a', name: 'Alpha', fileCount: 6, restMass: 60, excitation: 20 }, { id: 'b', path: 'b', name: 'Beta', fileCount: 1, restMass: 100, excitation: 30 }];
const atoms = ['README.md', 'PROJECT.md', 'PLAN.md', 'package.json', 'src/main.js', 'tests/main.test.js'].map((path) => ({ id: `a/${path}`, path, atomicMass: 10, planetId: 'a' }));

test('tour validation rejects unsafe, unbounded and ambiguous definitions and converts legacy sectors', () => {
  for (const input of [null, {}, { id: '../bad', stops: [{}] }, { id: 'ok', stops: [{ planet: 'a', path: '../key' }] }, { id: 'ok', stops: [{ planet: 'a', path: '.git/config' }] }, { id: 'ok', stops: [{ planet: 'a', path: 'a', molecule: 'b' }] }, { id: 'ok', stops: [{ planet: 'a', dwellSeconds: 121 }] }]) assert.ok(validateTour(input).error);
  assert.equal(validateTour({ id: 'ok', stops: Array(65).fill({ planet: 'a' }) }).tour, null);
  const { tour } = validateTour({ id: 'ok', stops: [{ sector: 'src', open: false }] }, { defaultPlanet: 'a' });
  assert.equal(tour.stops[0].molecule, 'src'); assert.equal(tour.stops[0].planet, 'a');
});

test('tour resolution confines canonical file ids to their body and flags unmapped stops', () => {
  const { tour } = validateTour({ id: 'route', stops: [{ planet: 'a', path: 'README.md' }, { planet: 'b', path: 'README.md' }, { planet: 'a', molecule: 'src' }, { planet: 'gone' }] });
  const resolved = resolveTour(tour, bodies, atoms);
  assert.equal(resolved.stops[0].id, 'a/README.md'); assert.equal(resolved.stops[0].missing, false);
  assert.equal(resolved.stops[1].missing, true); assert.equal(resolved.stops[2].missing, false); assert.equal(resolved.stops[3].missing, true);
  const root = resolveTour(validateTour({ id: 'root', stops: [{ path: 'README.md' }] }).tour, [{ id: '.', path: '' }], [{ planetId: '.', id: 'README.md', path: 'README.md' }]);
  assert.equal(root.stops[0].id, 'README.md');
});

test('onboarding uses stable reading priority, includes five available files, and spans bodies', () => {
  const payload = { ...bodies[0], atoms, molecules: [{ id: '.', molecularMass: 60 }, { id: 'src', molecularMass: 10 }, { id: 'tests', molecularMass: 10 }] };
  const tour = generateOnboardingTour({ bodies }, [payload]);
  const files = tour.stops.filter((s) => s.kind === 'atom');
  assert.deepEqual(files.map((s) => s.path), ['README.md', 'PROJECT.md', 'PLAN.md', 'package.json', 'src/main.js']);
  assert.ok(tour.stops.some((s) => s.planet === 'b' && s.molecule === '.'));
  assert.ok(tour.stops.some((s) => s.molecule === 'tests'));
  assert.equal(tour.stops.length <= 12, true);
  assert.equal(generateOnboardingTour({ bodies: [] }), null);
  const route = planRoute({ layer: 'planet', planetId: 'a' }, { kind: 'molecule', planetId: 'b', id: '.' });
  assert.deepEqual(route.legs.map((l) => l.type), ['takeoff', 'fly', 'land', 'fly']);
});

test('tour progression waits for successful open and viewer close; pause survives layer travel', () => {
  const tour = resolveTour(validateTour({ id: 'r', stops: [{ planet: 'a', path: 'README.md' }, { planet: 'b', dwellSeconds: 2 }] }).tour, bodies, atoms);
  let state = createTourState(tour);
  state = tourReducer(state, { type: 'arrived' }); assert.equal(state.status, 'opening');
  state = tourReducer(state, { type: 'openFailed' }); assert.equal(state.status, 'paused'); assert.equal(state.opened.length, 0);
  state = tourReducer(state, { type: 'resume' }); assert.equal(state.status, 'travelling');
  state = tourReducer(state, { type: 'arrived' }); state = tourReducer(state, { type: 'opened' });
  assert.equal(state.status, 'reading');
  assert.equal(tourReducer(state, { type: 'tick', dt: 30 }).index, 0);
  state = tourReducer(state, { type: 'viewerClosed' }); assert.equal(state.index, 1);
  state = tourReducer(state, { type: 'steer' }); state = tourReducer(state, { type: 'tick', dt: 30 }); assert.equal(state.status, 'paused');
  state = tourReducer(state, { type: 'resume' }); state = tourReducer(state, { type: 'arrived' });
  state = tourReducer(state, { type: 'tick', dt: 1 }); assert.equal(state.status, 'dwelling');
  state = tourReducer(state, { type: 'tick', dt: 1 }); assert.equal(state.status, 'complete'); assert.equal(state.opened.length, 1);
  assert.equal(tourReducer(state, { type: 'exit' }), null);
});

test('missing stops skip, back/restart work, and clipboard export is valid authoring JSON', () => {
  const tour = resolveTour(validateTour({ id: 'r', stops: [{ planet: 'a', path: 'missing.md' }, { planet: 'b' }] }).tour, bodies, atoms);
  let state = createTourState(tour);
  state = tourReducer(state, { type: 'missing' }); assert.equal(state.index, 1); assert.deepEqual(state.skipped, [0]);
  state = tourReducer(state, { type: 'skip', direction: -1 }); assert.equal(state.index, 0);
  state = tourReducer(state, { type: 'distance', distance: 20 }); assert.equal(state.distance, 20);
  assert.equal(validateTour(JSON.parse(exportTour(state))).error, null);
  assert.equal(tourReducer(state, { type: 'restart' }).distance, 0);
});

test('seven-stop onboarding preserves an entry point after five root documents', () => {
  const paths = ['README.md', 'PROJECT.md', 'PLAN.md', 'AGENTS.md', 'package.json', 'src/custom.js', 'tests/main.test.js'];
  const payload = { id: '.', path: '', name: 'Root', restMass: 700, excitation: 0,
    atoms: paths.map((path) => ({ id: path, path, atomicMass: 100 })), entryPoints: ['src/custom.js'],
    molecules: [{ id: 'src', molecularMass: 100 }, { id: 'tests', molecularMass: 100 }] };
  const tour = generateOnboardingTour({ bodies: [payload] }, [payload]);
  assert.equal(tour.stops.length, 7);
  assert.deepEqual(tour.stops.slice(0, 6).map((s) => s.path), paths.slice(0, 6));
  assert.equal(tour.stops[6].molecule, 'src');
  assert(tour.stops.every((s) => !s.missing));
});

test('sparse onboarding retains five available files plus two molecule stops', () => {
  const paths = ['src/main.js', 'src/feature.js', 'src/util.js', 'tests/feature.js', 'tests/util.js'];
  const payload = { id: '.', path: '', name: 'Root', restMass: 500, excitation: 0,
    atoms: paths.map((path) => ({ id: path, path, atomicMass: 100 })),
    molecules: [{ id: 'src', molecularMass: 300 }, { id: 'tests', molecularMass: 200 }] };
  const tour = generateOnboardingTour({ bodies: [payload] }, [payload]);
  assert.equal(tour.stops.length, 7);
  assert.equal(tour.stops.filter((s) => s.kind === 'atom').length, 5);
  assert.equal(tour.stops.filter((s) => s.kind === 'molecule').length, 2);
});

test('a live tour refresh preserves the in-flight itinerary when rankings or definitions reorder', async () => {
  const { refreshTourState } = await import('../public/tours.js');
  const a = { planet: 'a', kind: 'atom', id: 'a/README.md', path: 'README.md', note: 'old', missing: false };
  const b = { planet: 'b', kind: 'atom', id: 'b/README.md', path: 'README.md', missing: true };
  const running = createTourState({ id: 'onboarding', key: 'generated:onboarding', stops: [a,b] });
  const updated = refreshTourState(running, { id: 'onboarding', key: 'generated:onboarding', stops: [{...b,missing:false},{...a,note:'new'}] });
  assert.equal(updated.index,0); assert.equal(updated.stops[0].id,a.id); assert.equal(updated.stops[0].note,'new'); assert.equal(updated.stops[1].missing,false);
  assert.deepEqual(running.stops,[a,b]);
});
