import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoMission, DEMO_STEPS } from '../public/demo-mission.js';
import { demoPresentation } from '../public/tutorial.js';

const at = (id, extra = {}) => ({ ...createDemoMission(), index: DEMO_STEPS.findIndex(step => step.id === id), ...extra });

test('manual flight objectives offer a checkpoint reset, not a way to skip a skill', () => {
  for (const id of ['thrust', 'steer', 'brake']) {
    const mission = at(id), view = demoPresentation(mission, { layer: 'space', speed: 12, distance: 20 });
    assert.equal(view.action, 'reset');
    assert.equal(view.disabled, false);
    assert.equal(view.instruction, DEMO_STEPS.find(step => step.id === id).description);
    assert.match(view.holdHint, /^Hold /);
    assert.equal(mission.completed.length, 0);
    assert.equal(mission.index, DEMO_STEPS.findIndex(step => step.id === id));
  }
});

test('a reached signal replaces Atlas with the open action for touch pilots', () => {
  const approaching = demoPresentation(at('discover'), { layer: 'planet', routeActive: true, nearFile: false, distance: 40 });
  assert.equal(approaching.action, 'atlas');
  const reached = demoPresentation(at('discover'), { layer: 'planet', routeActive: false, nearFile: true });
  assert.equal(reached.action, 'open');
  assert.equal(reached.label, 'Open signal · E');
  assert.equal(reached.disabled, false);
  assert.match(reached.feedback, /Signal is in reach/);
  assert.equal(demoPresentation(at('discover'), { layer: 'space', nearFile: true }).action, 'atlas');
  assert.equal(demoPresentation(at('discover'), { layer: 'planet', nearFile: true, viewerOpen: true }).disabled, true);
});

test('landing, file opening and takeoff are gated by the actual target and layer', () => {
  assert.equal(demoPresentation(at('land'), { layer: 'space', landingAvailable: false }).disabled, true);
  assert.equal(demoPresentation(at('land'), { layer: 'space', landingAvailable: true }).disabled, false);
  assert.equal(demoPresentation(at('land'), { layer: 'planet', landingAvailable: true }).disabled, true);
  assert.equal(demoPresentation(at('open'), { layer: 'planet', nearFile: { id: 'observatory/signals/spectrum-01.csv' } }).disabled, true);
  assert.equal(demoPresentation(at('open'), { layer: 'planet', nearFile: { id: 'observatory/README.md' } }).disabled, false);
  assert.equal(demoPresentation(at('open'), { layer: 'planet', nearFile: true, nearREADME: false }).disabled, true);
  assert.equal(demoPresentation(at('open'), { layer: 'space', nearFile: true }).disabled, true);
  assert.equal(demoPresentation(at('takeoff'), { layer: 'planet' }).disabled, false);
  assert.equal(demoPresentation(at('takeoff'), { layer: 'space' }).disabled, true);
});

test('transitioning, viewing and celebrating states release flight controls and block actions', () => {
  for (const facts of [{ viewerOpen: true }, { layer: 'descending' }, { layer: { name: 'ascending' } }]) {
    const view = demoPresentation(at('overlay'), facts);
    assert.equal(view.controlsDisabled, true);
    assert.equal(view.disabled, true);
    assert.ok(view.notice);
  }
  const checked = demoPresentation(at('thrust', { status: 'celebrating', completed: ['thrust'], score: 100 }), {});
  assert.equal(checked.controlsDisabled, true);
  assert.equal(checked.disabled, true);
  assert.match(checked.notice, /Skill check complete/);
  const busy = demoPresentation(at('approach'), {}, { busy: true });
  assert.equal(busy.label, 'Working…');
  assert.equal(busy.disabled, true);
});

test('a paused mission can resume even during celebration without enabling held controls', () => {
  for (const status of ['playing', 'celebrating']) {
    const view = demoPresentation(at('thrust', { status }), { paused: true });
    assert.equal(view.action, 'resume');
    assert.equal(view.label, 'Resume flight');
    assert.equal(view.disabled, false);
    assert.equal(view.controlsDisabled, true);
    assert.equal(view.resetDisabled, true);
  }
  assert.equal(demoPresentation(at('thrust'), { paused: true }, { busy: true }).disabled, true);
  assert.notEqual(demoPresentation(at('open'), { paused: true, viewerOpen: true }).action, 'resume');
  assert.notEqual(demoPresentation(at('land'), { paused: true, layer: 'descending' }).action, 'resume');
});

test('assistance waits for its existing route without disabling manual steering', () => {
  const view = demoPresentation(at('approach'), { routeActive: true, distance: 52.4 });
  assert.equal(view.action, 'assist');
  assert.equal(view.disabled, true);
  assert.equal(view.controlsDisabled, false);
  assert.match(view.feedback, /52 u to target/);
});

test('completion reports earned score and distinct scanned files, while removing flight actions', () => {
  const mission = { ...createDemoMission(), index: 9, status: 'complete', completed: DEMO_STEPS.map(step => step.id), score: 900 };
  const view = demoPresentation(mission, { openedFiles: ['observatory/README.md', 'observatory/README.md', 'observatory/signals/spectrum-01.csv'] });
  assert.equal(view.id, 'complete');
  assert.equal(view.complete, true);
  assert.equal(view.completed, 9);
  assert.equal(view.score, 900);
  assert.equal(view.files, 2);
  assert.equal(view.action, null);
  assert.equal(view.controlsDisabled, true);
});
