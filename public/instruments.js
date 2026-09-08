import * as C from './constants.js';
import { childMoleculeAt } from './bodies.js';
import { escapeVelocity, captureState, surfaceGravity } from './field.js';
import { illumination } from './light.js';

const length = (p) => Math.hypot(p.x, p.y, p.z);
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const sum = (objects) => objects.reduce((a, b) => ({ restMass: a.restMass + (b.restMass ?? b.atomicMass ?? 0), effMass: a.effMass + (b.effMass ?? 0), luminosity: a.luminosity + (b.luminosity ?? 0) }), { restMass: 0, effMass: 0, luminosity: 0 });
const nearest = (items, p) => [...(items || [])].sort((a, b) => distance(a.center || a.position, p) - distance(b.center || b.position, p) || a.id.localeCompare(b.id))[0];

/** One source of truth for visible instruments and read-only browser diagnostics. */
export function readInstruments(state, now) {
  const { spaceWorld, planetWorld, ship, layer } = state;
  const surface = layer?.name === 'planet' || layer?.name === 'ascending';
  const world = surface ? planetWorld : spaceWorld, p = ship.position, speed = length(ship.velocity);
  const field = world?.field;
  const acceleration = field?.acceleration(p) || { x: 0, y: 0, z: 0 };
  const heldBody = layer?.capture?.held ? spaceWorld?.bodies.find((b) => b.id === layer.capture.bodyId) : null;
  const body = heldBody || nearest(spaceWorld?.bodies, p);
  const space = { nearest: body ? { id: body.id, name: body.name, kind: body.kind, distance: distance(body.center, p), restMass: body.restMass, effMass: body.effMass, xi: body.xi,
    horizonRadius: body.horizonRadius, landingRadius: body.landingRadius, escapeVelocity: escapeVelocity(body, p, spaceWorld.system), luminosity: body.luminosity, emits: body.emits,
    ...captureState(body, ship, spaceWorld.system), captured: !!(layer?.capture?.held && layer.capture.bodyId === body.id), partial: body.partial,
    illumination: illumination(body, spaceWorld.bodies, now), gravity: surfaceGravity(body, spaceWorld.system.G) } : null };
  let planet = null;
  if (surface && planetWorld) {
    const atom = nearest(planetWorld.atoms, p), focus = childMoleculeAt(planetWorld, p);
    const molecule = planetWorld.molecules.find((m) => m.id === atom?.moleculeId) || focus || planetWorld.molecules.find((m) => m.id === '.');
    planet = { id: planetWorld.planetId, molecules: planetWorld.molecules.length, atoms: planetWorld.atoms.length, gravity: planetWorld.gravity,
      nearest: { atom: atom ? { ...atom, distance: distance(atom.position, p) } : null,
        molecule: molecule ? { ...molecule, distance: distance(molecule.center, p), bonds: planetWorld.bonds.filter((b) => b.moleculeId === molecule.id).length } : null },
      focusMolecule: focus?.id || null, temperature: focus?.temperature || 0, altitude: p.y, atEdge: Math.hypot(p.x, p.z) > planetWorld.surfaceRadius,
      cohesion: field?.cohesionPotential?.(p) || 0, body: planetWorld.body };
  }
  const result = { physics: world?.field?.kind || null, speed, space, planet,
    field: { enabled: !!state.fieldEnabled, potential: field?.potential(p) || 0, acceleration, curvature: field?.curvature(p) || 0, damping: field?.damping?.(p) || C.DAMPING_FREE,
      escapeVelocity: surface ? null : space.nearest?.escapeVelocity || null, buffet: surface ? field?.buffet?.(p, ship.simulationTime) || { x: 0, y: 0, z: 0 } : null },
    system: { root: spaceWorld?.root?.name || '', bodies: spaceWorld?.bodies.length || 0, constants: { G: spaceWorld?.system.G || 0, cSquared: spaceWorld?.system.cSquared || 1, A_BODY: C.A_BODY, HORIZON_K: C.HORIZON_K, HALF_LIFE_MS: C.HALF_LIFE_MS, version: spaceWorld?.system.version || 0 } },
    sums: { bodies: sum(spaceWorld?.bodies || []), atoms: surface && planetWorld ? sum(planetWorld.atoms) : null },
    survey: { pending: (spaceWorld?.bodies || []).filter((b) => b.survey?.pending).length, partial: (spaceWorld?.bodies || []).filter((b) => b.survey?.partial).length,
      stale: (spaceWorld?.bodies || []).filter((b) => !b.survey?.pending && now - Date.parse(b.survey?.scannedAt || 0) > 60000).length },
  };
  result.flight = flightState(state, result);
  return result;
}

export function flightState(state, data) {
  const name = state.layer?.name;
  if (!state.launched) return 'AWAITING PILOT';
  if (state.paused || state.dialogOpen) return 'FLIGHT PAUSED';
  if (name === 'descending') return 'LANDING';
  if (name === 'ascending') return 'TAKING OFF';
  if (state.layer?.capture?.held) return `CAPTURED BY ${data.space.nearest?.name || ''}`.trim();
  if (state.route) return 'FOLLOWING COURSE';
  if (state.holding) return 'HOLDING POSITION';
  if (data.planet) {
    if (data.planet.altitude > 60) return 'CLIMBING';
    if (state.fieldEnabled && data.planet.temperature > .25) return 'BUFFETED';
    if (data.planet.focusMolecule && data.speed < 4) return 'BONDED';
    if (state.fieldEnabled && data.planet.gravity > 0 && state.ship.velocity.y < -2 && !state.input?.lift) return 'SINKING';
  } else if (data.space.nearest) {
    const near = data.space.nearest;
    if (near.skimming) return `SKIMMING ${near.name}`;
    if (near.distance < near.landingRadius * 2) return `APPROACHING ${near.name}`;
    if (state.fieldEnabled && length(data.field.acceleration) > 6 && !state.input?.thrust) return 'FALLING';
  }
  return data.speed > 65 ? 'BOOST ENGAGED' : data.speed > 2 ? 'CRUISING' : 'DRIFTING';
}

/** Edge-triggered catalog, kept separate from DOM so it can be exhaustively verified. */
export function environmentalNotices(previous, data, state) {
  const notices = [], p = data.planet, before = previous?.planet;
  if (p) {
    if (before?.focusMolecule && before.focusMolecule !== '.' && before.focusMolecule !== p.focusMolecule) notices.push(`Left ${before.focusMolecule}.`);
    if (p.focusMolecule && p.focusMolecule !== '.' && before?.focusMolecule !== p.focusMolecule) {
      const m = state.planetWorld.molecules.find((m) => m.id === p.focusMolecule);
      if (m) notices.push(`Entered ${m.path || m.id}: ${m.atomCount ?? state.planetWorld.atoms.filter((a) => a.moleculeId === m.id).length} atoms, T ${(m.temperature || 0).toFixed(2)}.`);
    }
    if (p.atEdge && !before?.atEdge) notices.push(`Edge of ${state.planetWorld.body.name}. Turn back, or climb to lift off.`);
    if (p.altitude > 60 && !(before?.altitude > 60)) notices.push('Leaving the atmosphere. Keep climbing to lift off.');
  } else if (state.layer?.name === 'space' && data.space.nearest) {
    const body = state.spaceWorld.bodies.find((b) => b.id === data.space.nearest.id), near = data.space.nearest, old = previous?.space.nearest;
    if (body && near.distance < near.landingRadius * 2 && (old?.id !== near.id || old.distance >= old.landingRadius * 2)) {
      notices.push(body.horizonRadius > body.radius ? `Approaching ${body.name}. Cross the horizon to land, boost to skim past.` : `Approaching ${body.name}. No horizon: enter the atmosphere and brake, or press L, to land.`);
    }
  }
  return notices;
}
