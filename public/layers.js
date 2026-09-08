import { LANDING_SECONDS, TAKEOFF_SECONDS, TAKEOFF_K, TAKEOFF_SPEED, TAKEOFF_ALTITUDE, TAKEOFF_HOLD, SURFACE_FLOOR } from './constants.js';

const point = (p, fallback = { x: 0, y: 0, z: 1 }) => p && [p.x, p.y, p.z].every(Number.isFinite) ? { ...p } : { ...fallback };
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const direction = (p) => { const d = Math.hypot(p.x, p.y, p.z); return d > 1e-9 ? { x: p.x / d, y: p.y / d, z: p.z / d } : { x: 0, y: 0, z: 1 }; };
const seconds = (dt) => Number.isFinite(dt) ? Math.max(0, dt) : 0;

export function createLayerState(system) {
  const bodies = system?.bodies || [];
  const one = bodies.length === 1 ? bodies[0] : null;
  return { name: one ? 'planet' : 'space', planetId: one?.id || null, transition: null, approach: { x: 0, y: 0, z: 1 }, capture: { armed: true, bodyId: null, held: false }, payloadReady: false, altitudeTime: 0 };
}

export function landable(world, position) {
  if (!position) return null;
  return (world?.bodies || []).filter((b) => !b.survey?.pending && b.landingRadius > 0 && distance(position, b.center) < b.landingRadius)
    .sort((a, b) => distance(position, a.center) / a.landingRadius - distance(position, b.center) / b.landingRadius || a.id.localeCompare(b.id))[0] || null;
}

/** Pure layer transitions; payload arrival and animation completion are independent gates. */
export function layerReducer(state, event) {
  if (!state || !event) return state;
  const type = event.type;
  if (type === 'land' && state.name === 'space') {
    const body = landable(event.world, event.position);
    if (!body || body.id !== event.bodyId) return state;
    return { ...state, name: 'descending', planetId: body.id, payloadReady: false, altitudeTime: 0,
      approach: direction({ x: event.position.x - body.center.x, y: event.position.y - body.center.y, z: event.position.z - body.center.z }),
      transition: { kind: 'land', progress: 0 }, capture: { armed: false, bodyId: body.id, held: false } };
  }
  if (type === 'tick' && state.transition) {
    const duration = state.name === 'descending' ? LANDING_SECONDS : TAKEOFF_SECONDS;
    const progress = Math.min(1, state.transition.progress + seconds(event.dt) / duration);
    if (state.name === 'descending' && progress >= 1 && state.payloadReady) return { ...state, name: 'planet', transition: null };
    return { ...state, transition: { ...state.transition, progress } };
  }
  if (type === 'planetLoaded' && event.bodyId === state.planetId && ['descending', 'planet'].includes(state.name)) {
    const complete = state.name === 'planet' || state.transition.progress >= 1;
    return { ...state, payloadReady: true, name: complete ? 'planet' : state.name, transition: complete ? null : state.transition };
  }
  if ((type === 'takeoff' && state.name === 'planet') || (type === 'planetLost' && ['planet', 'descending'].includes(state.name)) || (type === 'planetFailed' && ['planet', 'descending'].includes(state.name))) {
    return { ...state, name: 'ascending', transition: { kind: 'takeoff', progress: 0 }, altitudeTime: 0, capture: { armed: false, bodyId: state.planetId, held: false } };
  }
  if (type === 'ascended' && state.name === 'ascending' && state.transition.progress >= 1) return { ...state, name: 'space', planetId: null, payloadReady: false, transition: null };
  if (type === 'captured' && state.name === 'space' && state.capture.armed) return { ...state, capture: { armed: false, bodyId: event.bodyId, held: true } };
  if (type === 'released' && state.name === 'space' && state.capture.held) return { ...state, capture: { ...state.capture, held: false } };
  if (type === 'escaped' && state.name === 'space') return { ...state, capture: { armed: true, bodyId: null, held: false } };
  return state;
}

export function spawnAfterLanding(world) {
  return { position: point(world?.landing, { x: 0, y: SURFACE_FLOOR + 4, z: 14 }), velocity: { x: 0, y: 0, z: 0 }, yaw: world?.landingYaw || 0, simulationTime: 0 };
}

export function spawnAfterTakeoff(world, body, approach) {
  if (!body) return { position: point(world?.launch, { x: 0, y: 12, z: 70 }), velocity: { x: 0, y: 0, z: 0 }, yaw: 0, armed: false, simulationTime: 0 };
  const d = direction(point(approach));
  const r = Math.max(body.landingRadius || body.radius || 1, 1) * TAKEOFF_K;
  return { position: { x: body.center.x + d.x * r, y: body.center.y + d.y * r, z: body.center.z + d.z * r }, velocity: { x: d.x * TAKEOFF_SPEED, y: d.y * TAKEOFF_SPEED, z: d.z * TAKEOFF_SPEED }, yaw: Math.atan2(-d.x, -d.z), armed: false, simulationTime: 0 };
}

export function altitudeTakeoff(state, ship, dt) {
  const elapsed = state.name === 'planet' && ship.position.y > TAKEOFF_ALTITUDE ? (state.altitudeTime || 0) + seconds(dt) : 0;
  return { elapsed, takeoff: elapsed >= TAKEOFF_HOLD };
}

/** Canonical routes work for atlas, tour stops and space reticle landing. */
export function planRoute(from, to) {
  if (!to?.planetId) return { legs: [], index: 0, target: to || null };
  const layer = typeof from.layer === 'object' ? from.layer.name : from.layer || from.name;
  const current = from.planetId || from.layer?.planetId;
  const surface = layer === 'planet';
  const localTarget = ['atom', 'molecule'].includes(to.kind);
  const legs = [];
  if (surface && current === to.planetId && localTarget) legs.push({ type: 'fly', ...to });
  else if (surface && current === to.planetId && to.land) { /* Already landed. */ }
  else {
    if (surface) legs.push({ type: 'takeoff', planetId: current });
    legs.push({ type: 'fly', kind: 'body', planetId: to.planetId, id: to.planetId, mode: to.mode || 'land' });
    if (localTarget || to.land) legs.push({ type: 'land', planetId: to.planetId });
    if (localTarget) legs.push({ type: 'fly', ...to });
  }
  return { legs, index: 0, target: { ...to } };
}

export function nextLeg(route) {
  if (!route || route.index + 1 >= route.legs.length) return null;
  return { ...route, index: route.index + 1 };
}
