import test from 'node:test';
import assert from 'node:assert/strict';
import { readInstruments, flightState, environmentalNotices } from '../public/instruments.js';
import { buildSpaceWorld, buildPlanetWorld, refreshWorldPhysics } from '../public/bodies.js';
import { HALF_LIFE_MS } from '../public/constants.js';
const now = Date.parse('2026-09-08T12:00:00Z');
const position = (x = 0, y = 12, z = 0) => ({ x, y, z });
function fixtures() {
  const atoms = ['README.md', 'src/a.js', 'src/b.js'].map((path) => ({ id: path, path, atomicMass: 10000, excitation: 4200, excitationAt: now, element: 'source' }));
  const payload = { id: '.', path: '', name: 'Alpha', restMass: 30000, excitation: 12600, excitationAt: now, atoms };
  const spaceWorld = buildSpaceWorld({ root: { name: 'Workspace' }, bodies: [{ ...payload, kind: 'planet', survey: { pending: false, scannedAt: new Date(now).toISOString() } }] }, now);
  const planetWorld = buildPlanetWorld(payload, spaceWorld, now);
  return { launched: true, fieldEnabled: true, paused: false, holding: false, input: {}, spaceWorld, planetWorld, layer: { name: 'planet', capture: { held: false } }, ship: { position: { ...planetWorld.landing }, velocity: position(0, 0), simulationTime: 0 } };
}
function data() {
  return { speed: 0, space: { nearest: null }, planet: null, field: { acceleration: position(0, 0) } };
}

test('the complete flight-state catalog is reachable with explicit priority', () => {
  const base = { launched: true, fieldEnabled: true, layer: { name: 'space', capture: { held: false } }, input: {}, ship: { velocity: position(0, 0) } };
  const near = { name: 'Alpha', distance: 500, landingRadius: 100, skimming: false };
  const cases = [
    [{ launched: false }, {}, 'AWAITING PILOT'],
    [{ paused: true }, {}, 'FLIGHT PAUSED'],
    [{ dialogOpen: true }, {}, 'FLIGHT PAUSED'],
    [{ layer: { name: 'descending' } }, {}, 'LANDING'],
    [{ layer: { name: 'ascending' } }, {}, 'TAKING OFF'],
    [{ layer: { name: 'space', capture: { held: true } } }, { space: { nearest: near } }, 'CAPTURED BY Alpha'],
    [{ route: { legs: [] } }, {}, 'FOLLOWING COURSE'],
    [{ holding: true }, {}, 'HOLDING POSITION'],
    [{}, {}, 'DRIFTING'],
    [{}, { speed: 20 }, 'CRUISING'],
    [{}, { speed: 80 }, 'BOOST ENGAGED'],
    [{}, { space: { nearest: near }, field: { acceleration: position(7, 0) } }, 'FALLING'],
    [{}, { space: { nearest: { ...near, distance: 180 } } }, 'APPROACHING Alpha'],
    [{}, { space: { nearest: { ...near, distance: 80, skimming: true } } }, 'SKIMMING Alpha'],
    [{ layer: { name: 'planet' } }, { planet: { altitude: 61 } }, 'CLIMBING'],
    [{ layer: { name: 'planet' } }, { planet: { altitude: 10, temperature: .26 } }, 'BUFFETED'],
    [{ layer: { name: 'planet' } }, { planet: { altitude: 10, focusMolecule: 'src' }, speed: 3 }, 'BONDED'],
    [{ layer: { name: 'planet' }, ship: { velocity: position(0, -3) } }, { planet: { altitude: 10, gravity: 20 }, speed: 5 }, 'SINKING'],
  ];
  for (const [state, metrics, expected] of cases) assert.equal(flightState({ ...base, ...state }, { ...data(), ...metrics }), expected);
  assert.equal(flightState({ ...base, input: { thrust: 1 } }, { ...data(), space: { nearest: near }, field: { acceleration: position(7, 0) } }), 'DRIFTING');
  assert.equal(flightState({ ...base, fieldEnabled: false }, { ...data(), planet: { temperature: 1, altitude: 10 } }), 'DRIFTING');
  assert.equal(flightState({ ...base, ship: { velocity: position(0, -3) } }, { ...data(), planet: { gravity: 0, altitude: 10 }, speed: 5 }), 'CRUISING');
});

test('instrument sums remain coherent across decay, and root is never a bonded molecule', () => {
  const state = fixtures(); state.ship.position = position(0, 6);
  refreshWorldPhysics(state.spaceWorld, state.planetWorld, now + HALF_LIFE_MS, .1);
  const metrics = readInstruments(state, now + HALF_LIFE_MS);
  assert.equal(metrics.physics, 'molecular');
  for (const key of ['restMass', 'effMass', 'luminosity']) assert(Math.abs(metrics.sums.bodies[key] - metrics.sums.atoms[key]) < 1e-9);
  assert.equal(metrics.planet.focusMolecule, null); assert.notEqual(metrics.flight, 'BONDED');
  assert.equal(metrics.field.curvature, state.planetWorld.field.curvature(state.ship.position));
  assert.equal(metrics.planet.body.effMass, state.spaceWorld.bodies[0].effMass);
  assert.equal(metrics.planet.body.luminosity, state.spaceWorld.bodies[0].luminosity);
  state.fieldEnabled = false;
  assert.equal(readInstruments(state, now).field.enabled, false);
});

test('captured instruments retain the actual capture body across overlapping rings', () => {
  const state = fixtures(), captured = state.spaceWorld.bodies[0];
  const closer = { ...captured, id: 'closer', name: 'Closer', center: position(0, 0), radius: 20 };
  captured.center = position(100, 0); state.spaceWorld.bodies.push(closer);
  state.ship.position = position(1, 0); state.layer = { name: 'space', capture: { held: true, bodyId: captured.id } };
  const metrics = readInstruments(state, now);
  assert.equal(metrics.space.nearest.id, captured.id);
  assert.equal(metrics.flight, 'CAPTURED BY Alpha');
});

test('molecule, edge and atmosphere notices fire only on their entry edges', () => {
  const state = fixtures(), src = state.planetWorld.molecules.find((m) => m.id === 'src');
  const current = { ...data(), planet: { focusMolecule: 'src', altitude: 10, atEdge: false } };
  const entered = environmentalNotices(null, current, state);
  assert.deepEqual(entered, [`Entered src: 2 atoms, T ${src.temperature.toFixed(2)}.`]);
  assert.deepEqual(environmentalNotices(current, current, state), []);
  const open = { ...data(), planet: { focusMolecule: null, altitude: 10, atEdge: false } };
  assert.deepEqual(environmentalNotices(current, open, state), ['Left src.']);
  const root = { ...data(), planet: { focusMolecule: '.', altitude: 10, atEdge: false } };
  assert.deepEqual(environmentalNotices(null, root, state), []);
  assert.deepEqual(environmentalNotices(root, open, state), []);
  const edge = { ...data(), planet: { focusMolecule: null, altitude: 61, atEdge: true } };
  assert.deepEqual(environmentalNotices(open, edge, state), ['Edge of Alpha. Turn back, or climb to lift off.', 'Leaving the atmosphere. Keep climbing to lift off.']);
  assert.deepEqual(environmentalNotices(edge, edge, state), []);
  assert.doesNotThrow(() => environmentalNotices(null, { ...current, planet: { ...current.planet, focusMolecule: 'removed' } }, state));
});

test('both approach notices use the two-ring approach threshold and do not repeat', () => {
  const state = fixtures(), body = state.spaceWorld.bodies[0]; state.layer.name = 'space';
  const near = { id: body.id, name: body.name, distance: 180, landingRadius: 100 };
  const current = { ...data(), space: { nearest: near } };
  body.horizonRadius = body.radius * 2;
  assert.deepEqual(environmentalNotices(null, current, state), ['Approaching Alpha. Cross the horizon to land, boost to skim past.']);
  assert.deepEqual(environmentalNotices(current, current, state), []);
  body.horizonRadius = body.radius / 2;
  assert.deepEqual(environmentalNotices(null, current, state), ['Approaching Alpha. No horizon: enter the atmosphere and brake, or press L, to land.']);
  assert.deepEqual(environmentalNotices(null, { ...current, space: { nearest: { ...near, distance: 200 } } }, state), []);
});
