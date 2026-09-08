import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerState, layerReducer, landable, spawnAfterLanding, spawnAfterTakeoff, altitudeTakeoff, planRoute, nextLeg } from '../public/layers.js';
import { LANDING_SECONDS, TAKEOFF_SECONDS, TAKEOFF_K, TAKEOFF_SPEED, TAKEOFF_ALTITUDE, TAKEOFF_HOLD } from '../public/constants.js';

const body = { id: 'a', center: { x: 0, y: 0, z: 0 }, landingRadius: 100, radius: 50 };
const world = { bodies: [body, { id: 'b', center: { x: 300, y: 0, z: 0 }, landingRadius: 80 }], launch: { x: 0, y: 12, z: 200 } };
const descend = () => layerReducer(createLayerState(world), { type: 'land', bodyId: 'a', world, position: { x: 0, y: 0, z: 90 } });

test('one body boots landed; landing guards and overlap selection use the normalized ring distance', () => {
  assert.equal(createLayerState({ bodies: [body] }).name, 'planet');
  const state = createLayerState(world);
  assert.equal(state.name, 'space');
  assert.equal(layerReducer(state, { type: 'takeoff' }), state);
  assert.equal(layerReducer(state, { type: 'land', bodyId: 'a', world, position: { x: 0, y: 0, z: 101 } }), state);
  assert.equal(layerReducer(state, { type: 'land', bodyId: 'b', world, position: { x: 0, y: 0, z: 80 } }), state);
  const overlap = { bodies: [body, { id: 'c', center: { x: 50, y: 0, z: 0 }, landingRadius: 200 }] };
  assert.equal(landable(overlap, { x: 10, y: 0, z: 0 }).id, 'a');
  assert.equal(landable(overlap, { x: 40, y: 0, z: 0 }).id, 'c');
});

test('landing remembers early payload readiness and also waits for late payloads', () => {
  const descending = descend();
  const wrong = layerReducer(descending, { type: 'planetLoaded', bodyId: 'b' });
  assert.equal(wrong, descending);
  const early = layerReducer(descending, { type: 'planetLoaded', bodyId: 'a' });
  assert.equal(early.name, 'descending');
  assert.equal(layerReducer(early, { type: 'tick', dt: LANDING_SECONDS }).name, 'planet');
  const late = layerReducer(descending, { type: 'tick', dt: LANDING_SECONDS + 10 });
  assert.equal(late.name, 'descending');
  assert.equal(late.transition.progress, 1);
  assert.equal(layerReducer(late, { type: 'planetLoaded', bodyId: 'a' }).name, 'planet');
});

test('failure or removal ascends safely and ignores stale body responses', () => {
  for (const type of ['planetLost', 'planetFailed']) {
    let state = layerReducer(descend(), { type });
    assert.equal(state.name, 'ascending');
    assert.equal(layerReducer(state, { type: 'planetLoaded', bodyId: 'a' }), state);
    assert.equal(layerReducer(state, { type: 'ascended' }), state);
    state = layerReducer(state, { type: 'tick', dt: TAKEOFF_SECONDS });
    state = layerReducer(state, { type: 'ascended' });
    assert.equal(state.name, 'space'); assert.equal(state.planetId, null);
    assert.equal(state.capture.armed, false);
  }
  assert.deepEqual(spawnAfterTakeoff(world, null).position, world.launch);
});

test('capture is latched, thrust releases it, and escape re-arms it', () => {
  let state = layerReducer(createLayerState(world), { type: 'captured', bodyId: 'a' });
  assert.equal(state.capture.held, true); assert.equal(state.capture.armed, false);
  state = layerReducer(state, { type: 'released' });
  assert.equal(state.capture.held, false);
  assert.equal(layerReducer(state, { type: 'captured', bodyId: 'a' }), state);
  state = layerReducer(state, { type: 'escaped' });
  assert.equal(state.capture.armed, true); assert.equal(state.capture.bodyId, null);
});

test('spawn positions honor safe landing points and the original approach side on takeoff', () => {
  assert.deepEqual(spawnAfterLanding({ landing: { x: 8, y: 6, z: 14 } }).position, { x: 8, y: 6, z: 14 });
  const ship = spawnAfterTakeoff(world, body, { x: 4, y: 0, z: 0 });
  assert.equal(ship.position.x, TAKEOFF_K * 100);
  assert.equal(ship.velocity.x, TAKEOFF_SPEED);
  assert.equal(ship.armed, false);
});

test('altitude takeoff requires continuous time above the ceiling and resets below it', () => {
  const state = { name: 'planet', altitudeTime: 0 };
  const above = { position: { y: TAKEOFF_ALTITUDE + 1 } };
  const first = altitudeTakeoff(state, above, TAKEOFF_HOLD / 2);
  assert.equal(first.takeoff, false);
  assert.equal(altitudeTakeoff({ ...state, altitudeTime: first.elapsed }, above, TAKEOFF_HOLD / 2).takeoff, true);
  assert.equal(altitudeTakeoff({ ...state, altitudeTime: first.elapsed }, { position: { y: 0 } }, 1).elapsed, 0);
});

test('routes implement cross-layer sequences and body-only routes stop at the landing prompt', () => {
  const target = { planetId: 'b', kind: 'atom', id: 'b/README.md', path: 'README.md' };
  assert.deepEqual(planRoute({ layer: 'space' }, target).legs.map((l) => l.type), ['fly', 'land', 'fly']);
  assert.deepEqual(planRoute({ layer: 'planet', planetId: 'a' }, target).legs.map((l) => l.type), ['takeoff', 'fly', 'land', 'fly']);
  assert.deepEqual(planRoute({ layer: 'planet', planetId: 'b' }, target).legs.map((l) => l.type), ['fly']);
  assert.deepEqual(planRoute({ layer: 'planet', planetId: 'a' }, { planetId: 'b', kind: 'body' }).legs.map((l) => l.type), ['takeoff', 'fly']);
  assert.deepEqual(planRoute({ layer: 'space' }, { planetId: 'b', kind: 'body', land: true }).legs.map((l) => l.type), ['fly', 'land']);
  let route = planRoute({ layer: 'space' }, target);
  route = nextLeg(route); assert.equal(route.index, 1);
  route = nextLeg(route); assert.equal(route.index, 2); assert.equal(nextLeg(route), null);
});
