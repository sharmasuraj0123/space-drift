import { DEMO_STEPS, createDemoMission, demoStep } from './demo-mission.js';

const layerName = layer => typeof layer === 'object' ? layer?.name : layer;
const finite = value => Number.isFinite(value) ? value : 0;
const clamp = value => Math.max(0, Math.min(1, finite(value)));
const ACTIONS = Object.freeze({
  thrust: ['reset', 'Reset checkpoint'], steer: ['reset', 'Reset checkpoint'],
  brake: ['reset', 'Reset checkpoint'], approach: ['assist', 'Assist approach'],
  land: ['land', 'Land · L'], open: ['open', 'Open README · E'],
  overlay: ['overlay', 'Cycle overlay · G'], discover: ['atlas', 'Find signal in Atlas'],
  takeoff: ['land', 'Lift off · L'],
});
const HOLD_HINTS = Object.freeze({
  thrust: 'Hold W / Thrust.', steer: 'Hold A or D / Left or Right, with thrust.',
  brake: 'Hold Space / Brake.',
});

function nearReadme(facts) {
  if (typeof facts.nearREADME === 'boolean') return facts.nearREADME;
  if (typeof facts.nearFile === 'object' && facts.nearFile) {
    const path = facts.nearFile.id || facts.nearFile.path || facts.nearFile.name;
    return path === 'observatory/README.md' || path === 'README.md';
  }
  // The caller scopes its proximity flag to this objective's target.
  return facts.nearFile === true;
}

/** Derive display and action availability without advancing the mission clock. */
export function demoPresentation(mission = createDemoMission(), facts = {}, { busy = false } = {}) {
  const current = demoStep(mission), complete = mission.status === 'complete';
  const id = complete ? 'complete' : current?.id || 'thrust';
  const changingLayer = ['descending', 'ascending'].includes(layerName(facts.layer));
  const blocked = busy || !!facts.paused || !!facts.viewerOpen || changingLayer || mission.status === 'celebrating';
  let [action, normalLabel] = ACTIONS[id] || [null, ''];
  let label = normalLabel, disabled = blocked, feedback = '', notice = '';
  const speed = Math.max(0, finite(facts.speed));
  const distance = Number.isFinite(facts.distance) ? `${Math.max(0, Math.round(facts.distance))} u to target` : 'Follow the cyan target';
  switch (id) {
    case 'thrust': case 'steer':
      feedback = `${distance} · ${Math.round(clamp(facts.gateProgress) * 100)}% through course`;
      break;
    case 'brake': feedback = `${speed.toFixed(1)} u/s · goal below 2 u/s`; break;
    case 'approach':
      feedback = facts.landingAvailable ? 'Landing ring reached' : facts.routeActive ? `Assisted course · ${distance}` : distance;
      disabled ||= !!facts.routeActive;
      if (facts.routeActive) label = 'Approach in progress';
      break;
    case 'land':
      disabled ||= layerName(facts.layer) !== 'space' || !facts.landingAvailable;
      feedback = facts.landingAvailable ? 'In range · press L to descend' : 'Enter the observatory’s landing ring';
      break;
    case 'open':
      disabled ||= layerName(facts.layer) !== 'planet' || !nearReadme(facts);
      feedback = nearReadme(facts) ? 'README is in reach · open it, then return' : 'Approach the highlighted README atom';
      break;
    case 'overlay': feedback = facts.overlayChanges > 0 ? 'Overlay changed · field revealed' : 'Press G or use Cycle overlay'; break;
    case 'discover':
      if (facts.nearFile === true && layerName(facts.layer) === 'planet') {
        action = 'open';
        label = 'Open signal · E';
        feedback = 'Signal is in reach · open it, then return';
      } else feedback = facts.routeActive ? `Following your Atlas route · ${distance}` : 'Find and open signals/spectrum-01.csv';
      break;
    case 'takeoff':
      disabled ||= layerName(facts.layer) !== 'planet';
      feedback = 'Press L to return to the system';
      break;
    case 'complete': feedback = 'Mission complete · the controls are yours'; break;
  }
  if (mission.status === 'celebrating') notice = '✓ Skill check complete · +100 points';
  if (facts.viewerOpen) notice = 'Close the file viewer to continue the mission.';
  else if (facts.paused) notice = 'Mission paused · resume flight when ready.';
  else if (changingLayer) notice = 'Traveling between space and the surface…';
  if (facts.paused && !facts.viewerOpen && !changingLayer && !complete) {
    action = 'resume';
    label = 'Resume flight';
    disabled = busy;
  }
  if (busy) label = 'Working…';
  const completed = Array.isArray(mission.completed) ? mission.completed : [];
  const opened = facts.openedFiles instanceof Set ? facts.openedFiles.size
    : Array.isArray(facts.openedFiles) ? new Set(facts.openedFiles).size : 0;
  const files = Math.max(opened, Number(completed.includes('open')) + Number(completed.includes('discover')));
  return {
    id, complete, title: complete ? 'Flight trial complete.' : current?.title || DEMO_STEPS[0].title,
    instruction: complete ? '' : current?.description || DEMO_STEPS[0].description,
    holdHint: complete ? '' : HOLD_HINTS[id] || '',
    meaning: complete ? 'You flew the course, read the field, and discovered the signal. Bring your own folder into orbit next.' : current?.meaning || DEMO_STEPS[0].meaning,
    action, label, disabled, resetDisabled: blocked,
    controlsDisabled: blocked || complete, feedback, notice, files,
    score: Math.max(0, finite(mission.score)), completed: completed.length,
    number: Math.min(DEMO_STEPS.length, finite(mission.index) + 1),
  };
}

export function createTutorial({ onAction = () => {}, onClose = () => {}, onControl = () => {}, onRelease = () => {} } = {}) {
  const section = document.createElement('section');
  section.id = 'tutorial-guide';
  section.className = 'tutorial-guide demo-hud';
  section.hidden = true;
  section.setAttribute('aria-labelledby', 'tutorial-title');
  section.innerHTML = `
    <div class="demo-heading"><span class="demo-badge"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7"/><ellipse cx="12" cy="12" rx="11" ry="4" transform="rotate(-30 12 12)"/><path d="m10 13 2-5 2 5-2-1z"/></svg>Kepler mission</span><button class="demo-exit" type="button" title="Leave the mission and keep flying">Exit demo</button></div>
    <div class="demo-scoreboard"><span class="demo-count"></span><progress class="demo-progress" max="9" value="0" aria-label="Skills completed"></progress><strong class="demo-score">000 <small>PTS</small></strong></div>
    <div class="demo-content tutorial-content" tabindex="0" aria-label="Current mission objective">
      <div class="demo-objective" aria-live="polite" aria-atomic="true"><h2 id="tutorial-title"></h2><p class="demo-instruction"></p><p class="demo-hold-hint"></p><p class="demo-meaning"></p></div>
      <p class="demo-result" hidden></p><p class="demo-error" role="alert" hidden></p>
    </div>
    <div class="demo-feedback-row"><p class="demo-feedback"></p><p class="demo-notice" role="status" hidden></p></div>
    <div class="demo-controls" role="group" aria-label="Mission flight controls">
      <button type="button" data-control="KeyW" aria-label="Thrust forward" aria-pressed="false" title="Hold to thrust forward (W)"><kbd>W</kbd><span>Thrust</span></button>
      <button type="button" data-control="KeyA" aria-label="Steer left" aria-pressed="false" title="Hold to steer left (A)"><kbd>A</kbd><span>Left</span></button>
      <button type="button" data-control="KeyD" aria-label="Steer right" aria-pressed="false" title="Hold to steer right (D)"><kbd>D</kbd><span>Right</span></button>
      <button type="button" data-control="Space" aria-label="Brake" aria-pressed="false" title="Hold to brake (Space)"><kbd>Space</kbd><span>Brake</span></button>
    </div>
    <div class="demo-action-row"><button class="demo-primary" type="button"></button><button class="demo-reset" type="button" title="Return to this objective’s checkpoint">Reset</button></div>
    <div class="demo-complete-actions" hidden><button class="demo-restart" type="button">Fly again</button><button class="demo-connect" type="button">Connect my folder</button><button class="demo-freeflight" type="button">Keep exploring the sample ↗</button></div>
  `;
  document.body.append(section);
  const find = selector => section.querySelector(selector);
  const title = find('h2'), meaning = find('.demo-meaning'), content = find('.demo-content');
  const primary = find('.demo-primary'), reset = find('.demo-reset'), error = find('.demo-error');
  const controls = [...section.querySelectorAll('[data-control]')];
  const held = new Map(), pointers = new Map(), cached = new Map();
  let active = false, mission = createDemoMission(), facts = {}, busy = false, epoch = 0, renderedId = '';

  function set(key, value, apply) {
    if (cached.get(key) === value) return;
    cached.set(key, value);
    apply(value);
  }
  function release(code, source) {
    const sources = held.get(code);
    if (!sources || !sources.delete(source)) return;
    if (!sources.size) {
      held.delete(code);
      controls.find(button => button.dataset.control === code).setAttribute('aria-pressed', 'false');
      onRelease(code);
    }
  }
  function releaseAll() {
    const codes = [...held.keys()];
    held.clear();
    for (const code of codes) {
      controls.find(button => button.dataset.control === code).setAttribute('aria-pressed', 'false');
      onRelease(code);
    }
    for (const [id, button] of pointers) {
      if (button.hasPointerCapture?.(id)) button.releasePointerCapture(id);
    }
    pointers.clear();
  }
  function press(button, source) {
    if (!active || button.disabled || demoPresentation(mission, facts, { busy }).controlsDisabled) return;
    const code = button.dataset.control;
    if (!held.has(code)) held.set(code, new Set());
    const sources = held.get(code);
    if (sources.has(source)) return;
    const first = sources.size === 0;
    sources.add(source);
    button.setAttribute('aria-pressed', 'true');
    if (first) onControl(code);
  }

  function render() {
    const view = demoPresentation(mission, facts, { busy });
    set('id', view.id, value => { section.dataset.step = value; });
    set('status', mission.status, value => { section.dataset.status = value; });
    if (renderedId !== view.id) {
      renderedId = view.id;
      title.textContent = view.title;
      find('.demo-instruction').textContent = view.instruction;
      find('.demo-instruction').hidden = !view.instruction;
      find('.demo-hold-hint').textContent = view.holdHint;
      find('.demo-hold-hint').hidden = !view.holdHint;
      meaning.textContent = view.meaning;
      error.hidden = true;
      content.scrollTop = 0;
    }
    set('count', `${String(view.number).padStart(2, '0')} / ${DEMO_STEPS.length}`, value => { find('.demo-count').textContent = value; });
    set('score', view.score, value => { find('.demo-score').replaceChildren(document.createTextNode(`${String(value).padStart(3, '0')} `), Object.assign(document.createElement('small'), { textContent: 'PTS' })); });
    set('progress', view.completed, value => { find('progress').value = value; });
    set('feedback', view.feedback, value => { find('.demo-feedback').textContent = value; });
    set('notice', view.notice, value => { const node = find('.demo-notice'); node.textContent = value; node.hidden = !value; });
    set('label', view.label, value => { primary.textContent = value; });
    set('disabled', view.disabled, value => { primary.disabled = value; });
    set('busy', busy, value => { primary.setAttribute('aria-busy', String(value)); });
    set('resetDisabled', view.resetDisabled, value => { reset.disabled = value; find('.demo-restart').disabled = value; });
    set('resetHidden', view.action === 'reset', value => { reset.hidden = value; });
    set('folderBusy', busy, value => { find('.demo-connect').disabled = value; });
    set('controlsDisabled', view.controlsDisabled, value => {
      if (value) releaseAll();
      for (const button of controls) button.disabled = value;
    });
    set('complete', view.complete, value => {
      find('.demo-controls').hidden = value;
      find('.demo-action-row').hidden = value;
      find('.demo-complete-actions').hidden = !value;
      find('.demo-result').hidden = !value;
    });
    set('result', `${view.completed} skills cleared · ${view.files} files scanned`, value => { find('.demo-result').textContent = value; });
  }

  async function act(action) {
    const view = demoPresentation(mission, facts, { busy });
    if (!active || busy) return;
    if (action !== 'folder' && (action === 'reset' || action === 'restart' ? view.resetDisabled : view.disabled)) return;
    releaseAll();
    const actionEpoch = epoch;
    busy = true;
    error.hidden = true;
    render();
    try { await onAction(action); }
    catch {
      if (active && epoch === actionEpoch) {
        error.textContent = 'That action could not finish. Try again or reset the checkpoint.';
        error.hidden = false;
      }
    } finally {
      if (active && epoch === actionEpoch) { busy = false; render(); }
    }
  }
  function close() {
    if (!active) return;
    releaseAll();
    active = false;
    busy = false;
    epoch++;
    section.hidden = true;
    document.body.classList.remove('tutorial-active');
    if (section.contains(document.activeElement)) document.getElementById('scene')?.focus({ preventScroll: true });
    onClose();
  }
  primary.addEventListener('click', () => act(demoPresentation(mission, facts).action));
  reset.addEventListener('click', () => act('reset'));
  find('.demo-restart').addEventListener('click', () => act('restart'));
  find('.demo-connect').addEventListener('click', () => act('folder'));
  find('.demo-exit').addEventListener('click', close);
  find('.demo-freeflight').addEventListener('click', close);

  for (const button of controls) {
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || button.disabled) return;
      event.preventDefault();
      pointers.set(event.pointerId, button);
      button.setPointerCapture?.(event.pointerId);
      press(button, `pointer:${event.pointerId}`);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(name, event => {
        release(button.dataset.control, `pointer:${event.pointerId}`);
        pointers.delete(event.pointerId);
      });
    }
    button.addEventListener('keydown', event => {
      if (!['Space', 'Enter', 'NumpadEnter'].includes(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) press(button, `key:${event.code}`);
    });
    button.addEventListener('keyup', event => {
      if (!['Space', 'Enter', 'NumpadEnter'].includes(event.code)) return;
      event.preventDefault();
      release(button.dataset.control, `key:${event.code}`);
      // Keyup continues to the game's listener, which clears its own held keys.
    });
    button.addEventListener('blur', () => {
      for (const source of [...held.get(button.dataset.control) || []]) if (source.startsWith('key:')) release(button.dataset.control, source);
    });
  }
  for (const name of ['pointerdown', 'pointerup', 'click']) section.addEventListener(name, event => event.stopPropagation());
  addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  return Object.freeze({
    start(nextMission = createDemoMission()) {
      releaseAll();
      active = true;
      mission = nextMission;
      facts = {};
      busy = false;
      epoch++;
      cached.clear();
      renderedId = '';
      section.hidden = false;
      document.body.classList.add('tutorial-active');
      render();
    },
    update({ mission: nextMission = mission, facts: nextFacts = facts } = {}) {
      mission = nextMission;
      facts = nextFacts;
      if (active) render();
    },
    close,
    getState() { return { active, step: mission.index, id: demoStep(mission)?.id || 'complete', status: mission.status, score: mission.score, completed: [...mission.completed] }; },
  });
}
