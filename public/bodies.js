import * as C from './constants.js';
import { hash } from './model.js';
import { excitationAt, effectiveMass, excitationRatio, restMass } from './energy.js';
import { deriveSystemConstants, deriveSurfaceConstants, gravityField, chemistryField, horizonRadius, landingRadius, surfaceGravity } from './field.js';
import { luminosity, emits, bodyColor, emissionColor, illumination } from './light.js';

const numeric = (x) => Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0;
const compare = (a, b) => a.id.localeCompare(b.id);
const unit = (id) => hash(id) / 4294967296;
const origin = () => ({ x: 0, y: 0, z: 0 });
const distance2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const bodyRadius = (m) => Math.min(C.R_MAX, C.R_MIN + C.R_K * Math.log10(1 + numeric(m) / 1024));
export const atomRadius = (m) => Math.max(.9, Math.min(2.7, .9 + .24 * Math.log10(1 + numeric(m))));
const colorOf = (body) => body.color ?? C.ELEMENT_COLORS[body.element] ?? C.ELEMENT_COLORS.other;
function excited(body, now) {
  return { ...body, effMass: effectiveMass(body, now), xi: excitationRatio(body, now), luminosity: luminosity(body, now), emits: emits(body, now), color: colorOf(body) };
}

/** Chord-safe constellation rings; existing slots are kept whenever footprints fit. */
export function layoutSpace(bodies, previousPositions = null) {
  const groupsById = new Map();
  for (const body of [...bodies].sort(compare)) {
    const constellation = body.kind === 'planet' ? (body.constellation || (body.path?.includes('/') ? body.path.split('/')[0] : '')) : '';
    const id = constellation ? `group:${constellation}` : `body:${body.id}`;
    if (!groupsById.has(id)) groupsById.set(id, { id, name: constellation || body.name || body.id, members: [], belt: body.kind === 'belt' });
    groupsById.get(id).members.push(body);
  }
  const groups = [...groupsById.values()].sort((a, b) => Number(b.belt) - Number(a.belt) || a.id.localeCompare(b.id));
  for (const group of groups) {
    const n = group.members.length, radii = group.members.map((b) => b.restLandingRadius ?? b.landingRadius ?? b.radius + C.ATMOSPHERE);
    let ring = n > 1 ? Math.max(C.GROUP_RING_MIN, radii.reduce((sum, r) => sum + 2 * r + C.GROUP_GAP, 0) / (2 * Math.PI)) : 0;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) {
      ring = Math.max(ring, (radii[a] + radii[b] + C.GROUP_GAP) / (2 * Math.sin(Math.PI * (b - a) / n)));
    }
    group.ringRadius = ring; group.radius = ring + Math.max(C.R_MIN, ...radii); group.bodyIds = group.members.map((b) => b.id);
  }
  const oldGroups = previousPositions?.groups;
  const old = new Map(oldGroups ? oldGroups.map((g) => [g.id, g.center]) : previousPositions instanceof Map ? previousPositions : Object.entries(previousPositions?.positions ?? previousPositions ?? {}));
  const placed = [];
  let area = 0;
  groups.forEach((group, index) => {
    area += group.radius ** 2;
    group.slot = { radius: C.SLOT_D0 + Math.sqrt(C.SPACE_PACK * area), angle: index * C.GOLDEN_ANGLE };
  });
  const placementOrder = [...groups].sort((a, b) => Number(b.belt) - Number(a.belt) || Number(old.has(b.id)) - Number(old.has(a.id)) || a.id.localeCompare(b.id));
  for (const group of placementOrder) {
    const prior = old.get(group.id), angle = group.slot.angle;
    let position = group.belt ? origin() : prior && Number.isFinite(prior.x) ? { ...prior } : { x: Math.sin(angle) * group.slot.radius, y: 0, z: -Math.cos(angle) * group.slot.radius };
    let attempt = 0;
    while (placed.some((other) => distance2(position, other.center) < group.radius + other.radius + C.GROUP_GAP)) {
      attempt++;
      const r = group.slot.radius + Math.sqrt(attempt) * 2 * (group.radius + C.GROUP_GAP);
      const theta = angle + attempt * C.GOLDEN_ANGLE;
      position = { x: Math.sin(theta) * r, y: 0, z: -Math.cos(theta) * r };
    }
    group.center = position; placed.push(group);
    group.members.forEach((body, index) => {
      const theta = 2 * Math.PI * index / group.members.length;
      body.center = { x: position.x + Math.sin(theta) * group.ringRadius, y: 0, z: position.z + Math.cos(theta) * group.ringRadius };
      body.position = body.center;
    });
  }
  const launch = { x: 0, y: 12, z: (groups[0]?.radius ?? 30) + 40 };
  while (bodies.some((b) => distance2(launch, b.center) < (b.restLandingRadius ?? b.radius) + 10)) launch.z += 80;
  return { bodies, groups, launch, bounds: Math.max(250, ...bodies.map((b) => Math.hypot(b.center.x, b.center.z) + (b.landingRadius ?? b.radius) + 80)) };
}

export function buildSpaceWorld(payload = {}, now = Date.now(), previousPositions = null) {
  const bodies = (payload.bodies ?? []).map((input) => {
    const body = excited({ ...input, restMass: restMass(input), radius: bodyRadius(restMass(input)) }, now);
    body.partial = !!input.survey?.partial; return body;
  }).sort(compare);
  const targetSystem = deriveSystemConstants(bodies, previousPositions?.targetSystem ?? previousPositions?.system);
  const previousSystem = previousPositions?.system;
  const changed = previousSystem && (previousSystem.G !== targetSystem.G || previousSystem.cSquared !== targetSystem.cSquared);
  const system = changed ? { ...targetSystem, G: previousSystem.G, cSquared: previousSystem.cSquared } : { ...targetSystem };
  for (const body of bodies) {
    body.system = system;
    body.horizonRadius = horizonRadius(body, system); body.landingRadius = landingRadius(body, system);
    body.restLandingRadius = landingRadius({ ...body, effMass: body.restMass }, targetSystem);
  }
  const layout = layoutSpace(bodies, previousPositions);
  const world = { ...layout, layer: 'space', root: payload.root, payload, now, system, targetSystem,
    systemTransition: changed ? { elapsed: 0, from: { G: previousSystem.G, cSquared: previousSystem.cSquared } } : null,
    field: gravityField(bodies, system), colliders: bodies.filter((b) => !b.survey?.pending).map((b) => ({ id: b.id, kind: 'sphere', center: b.center, radius: b.radius })) };
  bodies.forEach((b) => { b.illumination = illumination(b, bodies, now); });
  return world;
}

/** A ring's capacity and jitter are computed from chord clearance, not arc length. */
function packRings(items, depth, start = null, anchorId = null) {
  const gap = C.PACK_GAP / (1 + C.PACK_DEPTH * depth), placed = [];
  let cursor = 0, ring = start?.ring ?? 0, previousMax = start?.max ?? 0;
  while (cursor < items.length) {
    const maxSlot = items[cursor].slotRadius;
    ring = ring ? ring + previousMax + maxSlot + gap : maxSlot + gap;
    const safeRatio = Math.min(1, (2 * maxSlot + C.ATOM_GAP) / (2 * ring));
    const capacity = Math.max(1, Math.floor(Math.PI / Math.asin(safeRatio)));
    const count = Math.min(capacity, items.length - cursor), pitch = 2 * Math.PI / count;
    const requiredAngle = 2 * Math.asin(Math.min(1, maxSlot / ring));
    const free = Math.max(0, pitch - requiredAngle);
    for (let i = 0; i < count; i++) {
      const item = items[cursor++], jitter = item.id === anchorId ? 0 : (unit(item.id) - .5) * free * .35;
      const angle = i * pitch + jitter;
      placed.push({ ...item, local: { x: Math.sin(angle) * ring, y: 0, z: Math.cos(angle) * ring } });
    }
    previousMax = maxSlot;
  }
  return { placed, ring, max: previousMax, radius: ring + previousMax + C.MOL_PADDING };
}

export function layoutSurface(molecules, atoms) {
  const byId = new Map(molecules.map((m) => [m.id, m])), atomsById = new Map(atoms.map((a) => [a.id, a]));
  const root = byId.get('.');
  const sizeOrder = (a, b) => b.slotRadius - a.slotRadius || a.id.localeCompare(b.id);
  const rootAtoms = root.atomIds.map((id) => atomsById.get(id)).filter(Boolean);
  const anchor = [...rootAtoms].sort((a, b) => Number(/^readme(?:\.|$)/i.test(b.name)) - Number(/^readme(?:\.|$)/i.test(a.name)) || compare(a, b))[0];
  function arrange(molecule, depth) {
    molecule.depth = depth;
    const children = molecule.moleculeIds.map((id) => byId.get(id)).filter(Boolean);
    children.forEach((m) => arrange(m, depth + 1));
    const ownAtoms = molecule.atomIds.map((id) => atomsById.get(id)).filter(Boolean).map((a) => ({ id: a.id, type: 'atom', slotRadius: a.radius + C.ATOM_GAP }));
    const childSlots = children.map((m) => ({ id: m.id, type: 'molecule', slotRadius: m.clusterRadius }));
    let packed;
    if (molecule.id === '.') {
      // Use a uniform envelope on the first root ring so the README anchor can
      // lead without invalidating the descending-size clearance calculation.
      const largest = Math.max(0, ...ownAtoms.map((a) => a.slotRadius));
      ownAtoms.forEach((a) => { a.slotRadius = largest; });
      ownAtoms.sort((a, b) => Number(b.id === anchor?.id) - Number(a.id === anchor?.id) || compare(a, b));
      const first = packRings(ownAtoms, depth, null, anchor?.id);
      const rest = packRings(childSlots.sort(sizeOrder), depth, ownAtoms.length ? first : null);
      packed = { placed: [...first.placed, ...rest.placed], radius: childSlots.length ? rest.radius : first.radius };
    } else packed = packRings([...ownAtoms, ...childSlots].sort(sizeOrder), depth);
    molecule.clusterRadius = Math.max(C.MOL_PADDING, packed.radius); molecule.radius = molecule.clusterRadius; molecule.slots = packed.placed;
  }
  arrange(root, 0);
  function position(molecule, c) {
    molecule.center = { ...c };
    for (const slot of molecule.slots) {
      const p = { x: c.x + slot.local.x, y: 0, z: c.z + slot.local.z };
      if (slot.type === 'molecule') position(byId.get(slot.id), p);
      else { const atom = atomsById.get(slot.id); atom.position = { ...p, y: C.SURFACE_FLOOR + atom.radius }; }
    }
  }
  position(root, origin());
  const surfaceRadius = root.clusterRadius + C.SURFACE_MARGIN;
  let landing = { x: 0, y: C.SURFACE_FLOOR + 4, z: 14 }, landingTargetId = anchor?.id ?? null;
  const target = anchor ?? [...atoms].sort(compare)[0];
  const clear = (p) => atoms.every((a) => Math.hypot((p.x - a.position.x) / (a.radius + C.SHIP_RADIUS), (p.y - a.position.y) / (1.5 * a.radius + C.SHIP_RADIUS), (p.z - a.position.z) / (a.radius + C.SHIP_RADIUS)) > 1.02);
  const result = () => ({ molecules, atoms, surfaceRadius, edgeRadius: surfaceRadius + C.EDGE_MARGIN, landing, landingTargetId,
    landingYaw: target ? Math.atan2(landing.x - target.position.x, landing.z - target.position.z) : 0 });
  if (target && (!anchor || !clear(landing))) {
    landingTargetId = target.id;
    // A safe, facing anchor also works when the root has no free atoms.
    for (let ring = 0; ring < 4; ring++) for (let i = 0; i < 24; i++) {
      const angle = i * C.GOLDEN_ANGLE, d = 7 + ring * 2;
      const candidate = { x: target.position.x + Math.sin(angle) * d, y: C.SURFACE_FLOOR + 4, z: target.position.z + Math.cos(angle) * d };
      if (clear(candidate)) { landing = candidate; return result(); }
    }
    landing = { x: target.position.x, y: target.position.y + target.radius * 1.5 + C.SHIP_RADIUS + 2, z: target.position.z };
  }
  return result();
}

export function bondsFor(molecule, atoms) {
  const siblings = atoms.filter((a) => a.moleculeId === molecule.id).sort(compare), candidates = new Map();
  for (const a of siblings) {
    const nearest = [];
    for (const b of siblings) {
      if (a === b) continue;
      const d = (a.position.x - b.position.x) ** 2 + (a.position.y - b.position.y) ** 2 + (a.position.z - b.position.z) ** 2;
      const last = nearest.at(-1);
      if (nearest.length === C.MAX_BONDS_PER_ATOM && (d > last.d || d === last.d && compare(b, last.b) >= 0)) continue;
      nearest.push({ a, b, d }); nearest.sort((x, y) => x.d - y.d || compare(x.b, y.b)); if (nearest.length > C.MAX_BONDS_PER_ATOM) nearest.pop();
    }
    for (const pair of nearest) { const ids = [a.id, pair.b.id].sort(); candidates.set(ids.join('\0'), { a: ids[0], b: ids[1], d: pair.d }); }
  }
  const degree = new Map(), lookup = new Map(siblings.map((a) => [a.id, a]));
  return [...candidates.values()].sort((a, b) => a.d - b.d || a.a.localeCompare(b.a) || a.b.localeCompare(b.b)).filter((pair) => {
    if ((degree.get(pair.a) ?? 0) >= C.MAX_BONDS_PER_ATOM || (degree.get(pair.b) ?? 0) >= C.MAX_BONDS_PER_ATOM) return false;
    degree.set(pair.a, (degree.get(pair.a) ?? 0) + 1); degree.set(pair.b, (degree.get(pair.b) ?? 0) + 1); return true;
  }).map((pair) => ({ id: `${pair.a}\0${pair.b}`, a: pair.a, b: pair.b, moleculeId: molecule.id, order: molecule.depth, from: lookup.get(pair.a).position, to: lookup.get(pair.b).position }));
}

export function moleculeAt(world, p) {
  return [...(world.molecules ?? [])].sort((a, b) => b.depth - a.depth || a.clusterRadius - b.clusterRadius || compare(a, b))
    .find((m) => Math.hypot(p.x - m.center.x, p.z - m.center.z) <= m.clusterRadius) ?? null;
}
export function childMoleculeAt(world, p) { const found = moleculeAt(world, p); return found?.id === '.' ? null : found; }

export function buildPlanetWorld(payload = {}, spaceWorld = {}, now = Date.now()) {
  const atomInputs = payload.atoms ?? [];
  const atoms = atomInputs.map((a) => excited({ ...a, atomicMass: restMass(a), radius: atomRadius(restMass(a)), moleculeId: a.moleculeId ?? (a.path?.split('/').slice(0, -1).join('/') || '.'), name: a.name || a.path?.split('/').at(-1) || a.id }, now)).sort(compare);
  const byId = new Map((payload.molecules ?? []).map((m) => [m.id, { ...m, moleculeIds: [], atomIds: [] }]));
  if (!byId.has('.')) byId.set('.', { id: '.', path: '.', parentId: null, moleculeIds: [], atomIds: [] });
  function ensure(id) {
    if (!id || id === '.') return byId.get('.');
    const parentId = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
    if (!byId.has(id)) byId.set(id, { id, path: id, parentId, moleculeIds: [], atomIds: [] });
    ensure(parentId); return byId.get(id);
  }
  atoms.forEach((a) => ensure(a.moleculeId).atomIds.push(a.id));
  for (const id of [...byId.keys()]) ensure(id);
  for (const m of [...byId.values()]) {
    if (m.id === '.') { m.parentId = null; continue; }
    m.parentId ||= m.id.includes('/') ? m.id.slice(0, m.id.lastIndexOf('/')) : '.';
    ensure(m.parentId).moleculeIds.push(m.id);
  }
  const atomMap = new Map(atoms.map((a) => [a.id, a]));
  function aggregate(m) {
    m.atomIds.sort(); m.moleculeIds.sort();
    const children = m.moleculeIds.map((id) => aggregate(byId.get(id))), own = m.atomIds.map((id) => atomMap.get(id));
    m.molecularMass = own.reduce((n, a) => n + a.atomicMass, 0) + children.reduce((n, c) => n + c.molecularMass, 0);
    m.atomCount = own.length + children.reduce((n, c) => n + c.atomCount, 0);
    m.elements = Object.fromEntries(Object.keys(C.ELEMENT_COLORS).map((element) => [element, 0]));
    for (const a of own) m.elements[a.element in m.elements ? a.element : 'other']++;
    for (const child of children) for (const element of Object.keys(m.elements)) m.elements[element] += child.elements[element];
    m.excitation = own.reduce((n, a) => n + excitationAt(a, now), 0) + children.reduce((n, c) => n + c.excitation, 0);
    m.excitationAt = now;
    Object.assign(m, excited(m, now)); m.temperature = m.xi; return m;
  }
  const root = aggregate(byId.get('.'));
  const molecules = [...byId.values()].sort(compare), layout = layoutSurface(molecules, atoms);
  atoms.forEach((a) => { a.epsilon = C.EPS_0 * Math.log2(1 + a.atomicMass / C.M_REF) * (1 + a.xi); a.sigma = a.radius + C.SHIP_RADIUS; });
  const bonds = molecules.flatMap((m) => bondsFor(m, atoms));
  const moleculeBonds = molecules.filter((m) => m.parentId).map((m) => ({ id: `${m.parentId}\0${m.id}`, parentId: m.parentId, childId: m.id, from: byId.get(m.parentId).center, to: m.center }));
  const body = spaceWorld.bodies?.find((b) => b.id === payload.id) ?? excited({ ...payload, restMass: root.molecularMass, radius: bodyRadius(root.molecularMass), excitation: root.excitation, excitationAt: now }, now);
  const system = deriveSurfaceConstants(molecules);
  const world = { ...layout, layer: 'planet', planetId: payload.id, payload, now, body, bonds, moleculeBonds, system, floor: C.SURFACE_FLOOR,
    gravity: surfaceGravity(body, spaceWorld.system?.G ?? 0),
    colliders: atoms.map((a) => ({ id: a.id, kind: 'ellipsoid', center: a.position, radius: a.radius, scaleY: 1.5 })),
    bounds: layout.edgeRadius + 20, spaceBodies: spaceWorld.bodies ?? [], restMass: root.molecularMass, excitation: root.excitation };
  world.field = chemistryField(world, system);
  updatePlanetLight(world, now);
  return world;
}

function updatePlanetLight(world, now) {
  const atomMap = new Map(world.atoms.map((a) => [a.id, a])), moleculeMap = new Map(world.molecules.map((m) => [m.id, m]));
  const members = (m) => [...m.atomIds.map((id) => atomMap.get(id)), ...m.moleculeIds.flatMap((id) => members(moleculeMap.get(id)))];
  for (const a of world.atoms) a.color = emissionColor(a, now);
  const emitters = world.molecules.filter((m) => m.id !== '.');
  for (const m of world.molecules) {
    m.color = bodyColor(m, members(m), now);
    m.illumination = illumination(m, emitters, now);
  }
  world._lightAt = now;
}

/** Update decaying masses without moving geometry or rebuilding spatial hashes.
 * A changed surveyed-body set interpolates its derived constants over one second.
 * Topology changes still require builders; this hook only mutates existing worlds.
 */
export function refreshWorldPhysics(spaceWorld, planetWorld, now = Date.now(), dt = 0) {
  if (spaceWorld) {
    const transition = spaceWorld.systemTransition;
    if (transition) {
      transition.elapsed = Math.min(1, transition.elapsed + Math.max(0, Number(dt) || 0));
      for (const key of ['G', 'cSquared']) spaceWorld.system[key] = transition.from[key] * (1 - transition.elapsed) + spaceWorld.targetSystem[key] * transition.elapsed;
      if (transition.elapsed === 1) spaceWorld.systemTransition = null;
    }
    for (const b of spaceWorld.bodies) {
      b.effMass = effectiveMass(b, now); b.xi = excitationRatio(b, now); b.luminosity = luminosity(b, now); b.emits = emits(b, now);
      b.horizonRadius = horizonRadius(b, spaceWorld.system); b.landingRadius = landingRadius(b, spaceWorld.system);
    }
    if (!spaceWorld._lightAt || Math.abs(now - spaceWorld._lightAt) >= 250) {
      for (const b of spaceWorld.bodies) b.illumination = illumination(b, spaceWorld.bodies, now);
      spaceWorld._lightAt = now;
    }
    spaceWorld.field.refresh(spaceWorld.system); spaceWorld.now = now;
  }
  if (planetWorld) {
    if (spaceWorld) { planetWorld.spaceBodies = spaceWorld.bodies; planetWorld.body = spaceWorld.bodies.find((b) => b.id === planetWorld.planetId) ?? planetWorld.body; }
    for (const b of [...planetWorld.molecules, ...planetWorld.atoms]) {
      b.effMass = effectiveMass(b, now); b.xi = excitationRatio(b, now); b.luminosity = luminosity(b, now); b.emits = emits(b, now);
      if (b.atomicMass !== undefined) b.epsilon = C.EPS_0 * Math.log2(1 + b.atomicMass / C.M_REF) * (1 + b.xi);
      else b.temperature = b.xi;
    }
    planetWorld.gravity = surfaceGravity(planetWorld.body, spaceWorld?.system.G ?? 0);
    planetWorld.field.refresh(planetWorld.system); planetWorld.now = now;
    if (Math.abs(now - planetWorld._lightAt) >= 250) updatePlanetLight(planetWorld, now);
  }
  return { spaceWorld, planetWorld };
}
