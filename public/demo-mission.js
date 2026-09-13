const CELEBRATION_SECONDS = .9;
const OBSERVATORY = 'observatory';
const README = `${OBSERVATORY}/README.md`;
const SPECTRUM = `${OBSERVATORY}/signals/spectrum-01.csv`;

export const DEMO_STEPS = Object.freeze([
  { id: 'thrust', title: 'Reach the first beacon.', description: 'Use thrust to fly through the first flight gate.', meaning: 'Thrust changes your velocity. Your ship keeps drifting after you release it.', keycaps: ['W', 'S'], action: null },
  { id: 'steer', title: 'Turn through the next gate.', description: 'Steer your ship through the second flight gate.', meaning: 'Turning changes your heading. Combine steering and thrust to curve your course.', keycaps: ['A', 'D'], action: null },
  { id: 'brake', title: 'Bring your ship to a stop.', description: 'Hold the brake until your speed drops below 2 units per second.', meaning: 'Braking slows your drift so you can approach objects carefully.', keycaps: ['Space'], action: null },
  { id: 'approach', title: 'Approach the observatory.', description: 'Fly inside the observatory’s landing ring.', meaning: 'Each repository becomes a planet. Its landing ring is the entrance to its files.', keycaps: ['W', 'A', 'D'], action: 'fly' },
  { id: 'land', title: 'Land on the observatory.', description: 'Descend to the observatory’s surface.', meaning: 'Folders become molecular cages; files become atoms. Bytes give them mass, and recent edits add light.', keycaps: ['L'], action: 'land' },
  { id: 'open', title: 'Open your first file.', description: 'Open the observatory README, then close the viewer to return to flight.', meaning: 'Every atom represents a real file. The viewer reads it without changing it.', keycaps: ['E'], action: 'open' },
  { id: 'overlay', title: 'Reveal the field.', description: 'Change the physics overlay once and watch the map respond.', meaning: 'G cycles bonds, temperature, and light views. The Physics switch changes forces. Neither changes your files.', keycaps: ['G'], action: 'overlay' },
  { id: 'discover', title: 'Discover a signal.', description: 'Find spectrum-01.csv in the signals folder, open it, and return to flight.', meaning: 'Folders group related file atoms. The Atlas helps you find a specific destination.', keycaps: ['M', 'E'], action: 'find' },
  { id: 'takeoff', title: 'Return to space.', description: 'Lift off and leave the observatory’s surface.', meaning: 'You can travel between repositories and explore each one at a different scale.', keycaps: ['L'], action: 'takeoff' },
].map(step => Object.freeze({ ...step, keycaps: Object.freeze(step.keycaps) })));

function state(value) {
  return Object.freeze({ ...value, completed: Object.freeze([...value.completed]), score: value.completed.length * 100 });
}

export function createDemoMission() {
  return state({ index: 0, completed: [], status: 'playing', celebrationRemaining: 0, elapsed: 0 });
}

export function demoStep(mission) {
  return mission.status === 'complete' ? null : DEMO_STEPS[mission.index] || null;
}

/** A swept, forward crossing of a circular gate; proximity alone is insufficient. */
export function crossedDemoGate(before, after, target) {
  const axes = ['x', 'y', 'z'];
  const valid = point => point && axes.every(axis => Number.isFinite(point[axis]));
  if (!valid(before) || !valid(after) || !valid(target?.position) || !valid(target?.direction) || !Number.isFinite(target?.radius) || target.radius <= 0) return false;
  const magnitude = Math.hypot(...axes.map(axis => target.direction[axis]));
  if (!Number.isFinite(magnitude) || magnitude <= 0) return false;
  const normal = axes.map(axis => target.direction[axis] / magnitude);
  const signed = point => axes.reduce((sum, axis, index) => sum + (point[axis] - target.position[axis]) * normal[index], 0);
  const start = signed(before), end = signed(after), progress = end - start;
  if (![start, end, progress].every(Number.isFinite) || start > 0 || end < 0 || progress <= 0) return false;
  const fraction = -start / progress;
  const offset = axes.map(axis => before[axis] + (after[axis] - before[axis]) * fraction - target.position[axis]);
  const along = offset.reduce((sum, value, index) => sum + value * normal[index], 0);
  const radius = Math.hypot(...offset.map((value, index) => value - along * normal[index]));
  return Number.isFinite(radius) && radius <= target.radius;
}

function opened(facts, path) {
  const files = facts.openedFiles;
  return !facts.viewerOpen && (Array.isArray(files) ? files.includes(path) : files instanceof Set && files.has(path));
}

function achieved(id, facts) {
  const landed = facts.layer === 'planet' && facts.planetId === OBSERVATORY;
  switch (id) {
    case 'thrust': return facts.gateReached === true && facts.manualThrust === true;
    case 'steer': return facts.gateReached === true && facts.manualSteer === true;
    case 'brake': return facts.braking === true && Number.isFinite(facts.speed) && facts.speed >= 0 && facts.speed < 2;
    // The caller scopes landingAvailable to the observatory's ring.
    case 'approach': return facts.landingAvailable === true || landed;
    case 'land': return landed;
    case 'open': return opened(facts, README);
    case 'overlay': return Number.isFinite(facts.overlayChanges) && facts.overlayChanges > 0;
    case 'discover': return opened(facts, SPECTRUM);
    case 'takeoff': return facts.layer === 'space' && facts.liftedOff === true;
    default: return false;
  }
}

/** Advance only from observed play. Zero simulation time records no progress. */
export function updateDemoMission(mission, facts = {}, dt = 0) {
  if (!Number.isFinite(dt) || dt <= 0 || mission.status === 'complete') return mission;
  const elapsed = mission.elapsed + dt;
  if (mission.status === 'celebrating') {
    const remaining = Math.max(0, mission.celebrationRemaining - dt);
    if (remaining > 1e-9) return state({ ...mission, elapsed, celebrationRemaining: remaining });
    const index = mission.index + 1;
    // Never evaluate the next objective with the previous objective's facts.
    return state({ ...mission, elapsed, index, celebrationRemaining: 0, status: index === DEMO_STEPS.length ? 'complete' : 'playing' });
  }
  const step = demoStep(mission);
  if (!step || !achieved(step.id, facts)) return state({ ...mission, elapsed });
  return state({ ...mission, elapsed, completed: [...mission.completed, step.id], status: 'celebrating', celebrationRemaining: CELEBRATION_SECONDS });
}
