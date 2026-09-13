import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_STEPS, createDemoMission, demoStep, updateDemoMission, crossedDemoGate } from '../public/demo-mission.js';

const README = 'observatory/README.md';
const SPECTRUM = 'observatory/signals/spectrum-01.csv';
const evidence = {
  thrust: { gateReached: true, manualThrust: true },
  steer: { gateReached: true, manualSteer: true },
  brake: { braking: true, speed: 1.5 },
  approach: { landingAvailable: true },
  land: { layer: 'planet', planetId: 'observatory' },
  open: { openedFiles: [README], viewerOpen: false },
  overlay: { overlayChanges: 1 },
  discover: { openedFiles: [README, SPECTRUM], viewerOpen: false },
  takeoff: { layer: 'space', liftedOff: true },
};

function advance(mission) {
  const result = updateDemoMission(mission, evidence[demoStep(mission).id], .1);
  assert.equal(result.status, 'celebrating');
  return updateDemoMission(result, {}, .9);
}

function at(id) {
  let mission = createDemoMission();
  while (demoStep(mission)?.id !== id) mission = advance(mission);
  return mission;
}

test('flight gates detect a forward swept crossing inside the ring, including fast travel', () => {
  const gate = Object.freeze({ position: Object.freeze({ x: 5, y: 2, z: 10 }), direction: Object.freeze({ x: 0, y: 0, z: 4 }), radius: 3 });
  assert.equal(crossedDemoGate({ x: 5, y: 2, z: 0 }, { x: 5, y: 2, z: 20 }, gate), true);
  assert.equal(crossedDemoGate({ x: 6, y: 2, z: -1000 }, { x: 6, y: 2, z: 1000 }, gate), true);
  assert.equal(crossedDemoGate({ x: 8, y: 2, z: 9 }, { x: 8, y: 2, z: 11 }, gate), true);
  assert.equal(crossedDemoGate({ x: 8.1, y: 2, z: 9 }, { x: 8.1, y: 2, z: 11 }, gate), false);
  assert.equal(crossedDemoGate({ x: 5, y: 2, z: 20 }, { x: 5, y: 2, z: 0 }, gate), false);
  assert.equal(crossedDemoGate({ x: 5, y: 2, z: 8 }, { x: 5, y: 2, z: 9.9 }, gate), false);
  assert.equal(crossedDemoGate({ x: 5, y: 2, z: 10 }, { x: 5, y: 2, z: 10 }, gate), false);
  assert.equal(crossedDemoGate({ x: 5, y: 2, z: 10 }, { x: 5, y: 2, z: 11 }, gate), true);
  assert.equal(gate.direction.z, 4);
});

test('gate intersection uses its oriented plane and rejects malformed or nonfinite geometry', () => {
  const before = Object.freeze({ x: 0, y: 0, z: 2 }), after = Object.freeze({ x: 20, y: 20, z: 2 });
  const gate = { position: { x: 10, y: 10, z: 0 }, direction: { x: 1, y: 1, z: 0 }, radius: 2.5 };
  assert.equal(crossedDemoGate(before, after, gate), true);
  assert.equal(crossedDemoGate(before, after, { ...gate, radius: 1.5 }), false);
  for (const invalid of [undefined, { ...gate, radius: 0 }, { ...gate, radius: -1 }, { ...gate, radius: Infinity }, { ...gate, direction: { x: 0, y: 0, z: 0 } }, { ...gate, direction: { x: NaN, y: 1, z: 0 } }, { ...gate, position: { x: 10, y: Infinity, z: 0 } }]) {
    assert.equal(crossedDemoGate(before, after, invalid), false);
  }
  assert.equal(crossedDemoGate({ ...before, x: NaN }, after, gate), false);
  assert.equal(crossedDemoGate(before, { ...after, z: Infinity }, gate), false);
  assert.equal(crossedDemoGate(null, after, gate), false);
});

test('flight gates require the matching manual action, and braking requires an actual stop', () => {
  for (const [id, wrong] of [
    ['thrust', [{ gateReached: true }, { manualThrust: true }, { gateReached: true, manualSteer: true }]],
    ['steer', [{ gateReached: true }, { manualSteer: true }, { gateReached: true, manualThrust: true }]],
    ['brake', [{ speed: 0 }, { braking: true, speed: 2 }, { braking: true, speed: NaN }, { braking: true, speed: -1 }]],
  ]) {
    const mission = at(id);
    for (const facts of wrong) {
      const result = updateDemoMission(mission, facts, .1);
      assert.equal(result.status, 'playing', `${id} must reject ${JSON.stringify(facts)}`);
      assert.deepEqual(result.completed, mission.completed);
    }
    assert.equal(updateDemoMission(mission, evidence[id], .1).status, 'celebrating');
  }
});

test('approach and landing accept the observatory and reject unrelated or unfinished landings', () => {
  const approach = at('approach'), land = at('land');
  const earlyLanding = { layer: 'planet', planetId: 'observatory' };
  assert.equal(updateDemoMission(approach, earlyLanding, .1).status, 'celebrating');
  assert.equal(updateDemoMission(approach, { landingAvailable: true }, .1).status, 'celebrating');
  for (const mission of [approach, land]) {
    for (const facts of [{ layer: 'planet', planetId: 'field-notes' }, { layer: 'descending', planetId: 'observatory' }]) {
      assert.equal(updateDemoMission(mission, facts, .1).status, 'playing');
    }
  }
  assert.equal(updateDemoMission(land, { landingAvailable: true }, .1).status, 'playing');
  assert.equal(updateDemoMission(land, earlyLanding, .1).status, 'celebrating');
});

test('file objectives require the canonical file to have opened and the viewer to have closed', () => {
  for (const [id, path] of [['open', README], ['discover', SPECTRUM]]) {
    const mission = at(id);
    for (const facts of [{ openedFiles: [path], viewerOpen: true }, { openedFiles: ['field-notes/README.md'], viewerOpen: false }, { nearFile: true, viewerOpen: false }]) {
      assert.equal(updateDemoMission(mission, facts, .1).status, 'playing');
    }
    assert.equal(updateDemoMission(mission, { openedFiles: new Set([path]), viewerOpen: false }, .1).status, 'celebrating');
  }
  assert.equal(updateDemoMission(at('discover'), evidence.open, .1).status, 'playing');
});

test('saved overlay preferences and merely being in space cannot finish objectives', () => {
  const overlay = at('overlay'), takeoff = at('takeoff');
  for (const facts of [{ overlay: 'temperature' }, { overlay: 'bonds', overlayChanges: 0 }, { overlayChanges: '1' }]) {
    assert.equal(updateDemoMission(overlay, facts, .1).status, 'playing');
  }
  assert.equal(updateDemoMission(overlay, evidence.overlay, .1).status, 'celebrating');
  assert.equal(updateDemoMission(takeoff, { layer: 'space' }, .1).status, 'playing');
  assert.equal(updateDemoMission(takeoff, { layer: 'ascending', liftedOff: true }, .1).status, 'playing');
  assert.equal(updateDemoMission(takeoff, evidence.takeoff, .1).status, 'celebrating');
});

test('pauses record nothing, freeze celebrations, and resume with previously observed file events', () => {
  const mission = at('open');
  for (const dt of [0, -1, NaN, Infinity]) assert.equal(updateDemoMission(mission, evidence.open, dt), mission);
  const celebrating = updateDemoMission(mission, evidence.open, .1);
  assert.equal(celebrating.celebrationRemaining, .9);
  assert.equal(updateDemoMission(celebrating, evidence.open, 0), celebrating);
  const partial = updateDemoMission(celebrating, evidence.open, .4);
  assert.equal(partial.index, mission.index);
  assert.equal(partial.status, 'celebrating');
  assert.equal(partial.completed.length, mission.completed.length + 1);
  const next = updateDemoMission(partial, { overlayChanges: 99 }, .5);
  assert.equal(demoStep(next).id, 'overlay');
  assert.equal(next.status, 'playing');
  assert.deepEqual(next.completed, partial.completed);
});

test('a full mission awards each objective once, completes at 900 points, and restarts independently', () => {
  let mission = createDemoMission();
  const original = mission;
  assert.ok(Object.isFrozen(mission) && Object.isFrozen(mission.completed));
  for (const step of DEMO_STEPS) {
    assert.equal(demoStep(mission).id, step.id);
    const previous = mission;
    mission = advance(mission);
    assert.equal(mission.score, mission.completed.length * 100);
    assert.equal(previous.completed.length + 1, mission.completed.length);
    assert.equal(previous.status, 'playing');
  }
  assert.equal(mission.status, 'complete');
  assert.equal(mission.index, DEMO_STEPS.length);
  assert.equal(demoStep(mission), null);
  assert.deepEqual(mission.completed, DEMO_STEPS.map(step => step.id));
  assert.equal(mission.score, 900);
  assert.ok(Math.abs(mission.elapsed - 9) < 1e-9);
  assert.equal(updateDemoMission(mission, evidence.takeoff, 100), mission);
  assert.deepEqual(original.completed, []);
  assert.equal(original.elapsed, 0);
  const restarted = createDemoMission();
  assert.deepEqual(restarted, original);
  assert.notEqual(restarted, original);
  assert.notEqual(restarted.completed, original.completed);
});
