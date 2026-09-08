import * as C from './constants.js';
import { effectiveMass, restMass } from './energy.js';

const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const point = (p = {}) => ({ x: finite(p.x), y: finite(p.y), z: finite(p.z) });
const radius = (b) => Math.max(.001, finite(b.radius ?? b.clusterRadius, C.R_MIN));
const mass = (b) => Math.max(0, finite(b.effMass, effectiveMass(b)));
const center = (b) => point(b.center ?? b.position);
const length = (v) => Math.hypot(v.x, v.y, v.z);

export function clampMagnitude(vector, maximum) {
  const p = point(vector), size = length(p), scale = size > maximum && size > 0 ? maximum / size : 1;
  return { x: p.x * scale || 0, y: p.y * scale || 0, z: p.z * scale || 0 };
}

export function deriveSystemConstants(bodies, previous = null) {
  const signature = [...bodies].sort((a, b) => a.id.localeCompare(b.id)).map((b) => `${b.id}:${!!b.survey?.pending}`).join('|');
  if (previous?.signature === signature) return { ...previous };
  const surveyed = bodies.filter((b) => !b.survey?.pending && restMass(b) > 0)
    .sort((a, b) => restMass(b) - restMass(a) || a.id.localeCompare(b.id));
  const heaviest = surveyed[0];
  if (!heaviest) return { G: 0, cSquared: 1, heaviestId: null, rMax: C.R_MIN, version: (previous?.version ?? 0) + 1, signature };
  const M = restMass(heaviest), R = radius(heaviest);
  const G = C.A_BODY * 5 ** 1.5 * R * R / (2 * M);
  return { G, cSquared: 2 * G * M / (C.HORIZON_K * R), heaviestId: heaviest.id, rMax: R, version: (previous?.version ?? 0) + 1, signature };
}

export function deriveSurfaceConstants(molecules) {
  const children = molecules.filter((m) => m.id !== '.' && restMass(m) > 0)
    .sort((a, b) => restMass(b) - restMass(a) || a.id.localeCompare(b.id));
  const child = children[0];
  return { G_S: child ? C.A_MOL * 5 ** 1.5 * radius(child) ** 2 / (2 * restMass(child)) : 0, heaviestId: child?.id ?? null, rMax: child ? radius(child) : 0 };
}
export function surfaceGravity(body, G) { return Math.min(C.G_SURFACE_MAX, Math.max(0, finite(G)) * mass(body) / (2 ** 1.5 * radius(body) ** 2)); }
export function horizonRadius(body, constants = body.system ?? {}) {
  return body.survey?.pending ? 0 : 2 * Math.max(0, finite(constants.G)) * mass(body) / Math.max(Number.EPSILON, finite(constants.cSquared ?? constants.C_SQUARED, 1));
}
export function landingRadius(body, constants = body.system ?? {}) { return Math.max(horizonRadius(body, constants), radius(body) + C.ATMOSPHERE); }
export function escapeVelocity(body, p, constants = body.system ?? {}) {
  const c = center(body), q = point(p), d = Math.hypot(q.x - c.x, q.y - c.y, q.z - c.z, radius(body));
  return Math.sqrt(2 * Math.max(0, finite(constants.G)) * mass(body) / d);
}
export function captureState(body, ship, constants = body.system ?? {}) {
  const c = center(body), p = point(ship.position), inside = !body.survey?.pending && Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z) < (body.landingRadius ?? landingRadius(body, constants));
  const skimming = inside && length(point(ship.velocity)) >= escapeVelocity(body, p, constants);
  return { inside, captured: inside && !skimming, skimming };
}

function gridBounds(bounds = 500) {
  if (typeof bounds === 'number') return { minX: -Math.abs(bounds), maxX: Math.abs(bounds), minZ: -Math.abs(bounds), maxZ: Math.abs(bounds) };
  return { minX: finite(bounds.minX, -500), maxX: finite(bounds.maxX, 500), minZ: finite(bounds.minZ, -500), maxZ: finite(bounds.maxZ, 500) };
}

/** A halo makes every grid-node Laplacian use the same central stencil as the HUD. */
function sampledField(slicePotential, sources, maxHeight) {
  let dx = 1, dz = 1;
  const curvature = (p) => {
    const x = finite(p.x), z = finite(p.z), mid = slicePotential(x, z);
    return (slicePotential(x + dx, z) - 2 * mid + slicePotential(x - dx, z)) / (dx * dx)
      + (slicePotential(x, z + dz) - 2 * mid + slicePotential(x, z - dz)) / (dz * dz);
  };
  function sampleGrid(bounds, resolution = C.GRID_RESOLUTION) {
    const reference = Math.max(1e-30, ...sources.map((b) => Math.abs(slicePotential(center(b).x, center(b).z))));
    const box = gridBounds(bounds), n = Math.max(3, Math.floor(finite(resolution, C.GRID_RESOLUTION)));
    dx = Math.max(1e-6, (box.maxX - box.minX) / (n - 1)); dz = Math.max(1e-6, (box.maxZ - box.minZ) / (n - 1));
    const width = n + 2, values = new Float64Array(width * width);
    for (let row = 0; row < width; row++) for (let col = 0; col < width; col++) {
      values[row * width + col] = slicePotential(box.minX + (col - 1) * dx, box.minZ + (row - 1) * dz);
    }
    const heights = new Float32Array(n * n), gradients = new Float32Array(n * n * 3), K = new Float32Array(n * n);
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
      const i = row * n + col, j = (row + 1) * width + col + 1, p = values[j];
      heights[i] = maxHeight * p / reference;
      gradients[i * 3] = (values[j + 1] - values[j - 1]) / (2 * dx);
      gradients[i * 3 + 2] = (values[j + width] - values[j - width]) / (2 * dz);
      K[i] = (values[j + 1] - 2 * p + values[j - 1]) / (dx * dx) + (values[j + width] - 2 * p + values[j - width]) / (dz * dz);
    }
    const sorted = K.slice().sort();
    return { resolution: n, bounds: box, stepX: dx, stepZ: dz, heights, height: heights, gradients, gradient: gradients, curvature: K,
      legend: { min: sorted[Math.floor(sorted.length * .05)], max: sorted[Math.floor(sorted.length * .95)] } };
  }
  return { curvature, sampleGrid };
}

export function gravityField(bodies, constants = deriveSystemConstants(bodies)) {
  const active = bodies.filter((b) => !b.survey?.pending && mass(b) > 0);
  const packed = active.map((b) => ({ ...center(b), r2: radius(b) ** 2, mu: Math.max(0, finite(constants.G)) * mass(b) }));
  function refresh(nextConstants = constants) {
    Object.assign(constants, nextConstants);
    for (let i = 0; i < packed.length; i++) packed[i].mu = Math.max(0, finite(constants.G)) * mass(active[i]);
  }
  function potential(p) {
    let sum = 0;
    for (const b of packed) { const x = p.x - b.x, y = (p.y ?? 0) - b.y, z = p.z - b.z; sum -= b.mu / Math.sqrt(x * x + y * y + z * z + b.r2); }
    return sum;
  }
  function acceleration(p) {
    let x = 0, y = 0, z = 0;
    for (const b of packed) {
      const a = p.x - b.x, d = (p.y ?? 0) - b.y, e = p.z - b.z, r2 = a * a + d * d + e * e + b.r2;
      const k = -b.mu / (r2 * Math.sqrt(r2)); x += a * k; y += d * k; z += e * k;
    }
    return clampMagnitude({ x, y, z }, constants.A_MAX_SPACE ?? C.A_MAX_SPACE);
  }
  const slice = (x, z) => { let sum = 0; for (const b of packed) { const a = x - b.x, e = z - b.z; sum -= b.mu / Math.sqrt(a * a + b.y * b.y + e * e + b.r2); } return sum; };
  return { kind: 'astro', potential, acceleration, damping: () => C.DAMPING_FREE, bodies: active, constants, refresh,
    buffet: () => ({ x: 0, y: 0, z: 0 }), ...sampledField(slice, active, C.H_SPACE_MAX) };
}

function spatialHash(items, getCenter, cellSize) {
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const item of items) {
    const p = getCenter(item), k = key(Math.floor(p.x / cellSize), Math.floor(p.y / cellSize), Math.floor(p.z / cellSize));
    if (!cells.has(k)) cells.set(k, []); cells.get(k).push(item);
  }
  return function nearby(p) {
    const result = [], x = Math.floor(p.x / cellSize), y = Math.floor(p.y / cellSize), z = Math.floor(p.z / cellSize);
    for (let a = x - 1; a <= x + 1; a++) for (let b = y - 1; b <= y + 1; b++) for (let c = z - 1; c <= z + 1; c++) {
      const found = cells.get(key(a, b, c)); if (found) result.push(...found);
    }
    return result;
  };
}
function segmentDistance(p, a, b) {
  const x = b.x - a.x, y = b.y - a.y, z = b.z - a.z, n = x * x + y * y + z * z;
  const t = n ? Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y + (p.z - a.z) * z) / n)) : 0;
  return Math.hypot(p.x - a.x - t * x, p.y - a.y - t * y, p.z - a.z - t * z);
}
function hash(text) { let n = 2166136261; for (const char of String(text)) n = Math.imul(n ^ char.charCodeAt(0), 16777619); return n >>> 0; }

export function chemistryField(world, constants = deriveSurfaceConstants(world.molecules ?? [])) {
  const children = (world.molecules ?? []).filter((m) => m.id !== '.');
  const packed = children.map((m) => ({ ...center(m), r2: radius(m) ** 2, mu: finite(constants.G_S) * mass(m) }));
  const atoms = (world.atoms ?? []).map((a) => ({ ...a, position: center(a), sigma: Math.max(.01, finite(a.sigma, radius(a) + C.SHIP_RADIUS)), epsilon: Math.max(0, finite(a.epsilon, C.EPS_0 * Math.log2(1 + restMass(a) / C.M_REF) * (1 + finite(a.xi)))) }));
  const nearAtoms = spatialHash(atoms, (a) => a.position, Math.max(1, ...atoms.map((a) => a.sigma * C.CUTOFF)));
  const atomById = new Map(atoms.map((a) => [a.id, a]));
  const bonds = (world.bonds ?? []).map((b) => ({ from: point(b.from ?? atomById.get(b.a)?.position), to: point(b.to ?? atomById.get(b.b)?.position) }));
  const bondCell = C.BOND_DENSITY_RADIUS + Math.max(1, ...bonds.map((b) => Math.hypot(b.from.x - b.to.x, b.from.y - b.to.y, b.from.z - b.to.z) / 2));
  const nearBonds = spatialHash(bonds, (b) => ({ x: (b.from.x + b.to.x) / 2, y: (b.from.y + b.to.y) / 2, z: (b.from.z + b.to.z) / 2 }), bondCell);
  let g = Math.max(0, finite(world.gravity));
  const edgeRadius = Math.max(0, finite(world.edgeRadius, Infinity));
  function refresh(nextConstants = constants) {
    Object.assign(constants, nextConstants); g = Math.max(0, finite(world.gravity));
    for (let i = 0; i < packed.length; i++) packed[i].mu = finite(constants.G_S) * mass(children[i]);
    for (let i = 0; i < atoms.length; i++) atoms[i].epsilon = Math.max(0, finite(world.atoms[i].epsilon));
  }
  const byDepth = [...children].sort((a, b) => finite(b.depth, b.id.split('/').length) - finite(a.depth, a.id.split('/').length) || radius(a) - radius(b) || a.id.localeCompare(b.id));
  const childAt = (p) => byDepth.find((m) => Math.hypot(p.x - center(m).x, p.z - center(m).z) <= radius(m)) ?? null;
  function cohesion(x, z) { let sum = 0; for (const m of packed) { const a = x - m.x, b = z - m.z; sum -= m.mu / Math.sqrt(a * a + b * b + m.r2); } return sum; }
  function potential(p) {
    p = point(p);
    let value = g * (p.y ?? 0) + cohesion(p.x, p.z) + .5 * C.K_EDGE * Math.max(0, Math.hypot(p.x, p.z) - edgeRadius) ** 2;
    for (const a of nearAtoms(p)) {
      const d = Math.hypot(p.x - a.position.x, p.y - a.position.y, p.z - a.position.z), cutoff = C.CUTOFF * a.sigma;
      if (d >= cutoff) continue;
      const r = Math.max(a.sigma, d), slope = 6 * a.epsilon / (C.CUTOFF ** 7 * a.sigma);
      value += -a.epsilon * (a.sigma / r) ** 6 + a.epsilon / C.CUTOFF ** 6 - (r - cutoff) * slope;
    }
    return value;
  }
  function acceleration(p) {
    p = point(p);
    let x = 0, y = -g, z = 0;
    for (const m of packed) { const a = p.x - m.x, b = p.z - m.z, r2 = a * a + b * b + m.r2, k = -m.mu / (r2 * Math.sqrt(r2)); x += a * k; z += b * k; }
    for (const atom of nearAtoms(p)) {
      const a = p.x - atom.position.x, b = p.y - atom.position.y, c = p.z - atom.position.z, r = Math.hypot(a, b, c);
      if (r <= atom.sigma || r >= C.CUTOFF * atom.sigma) continue;
      const slope = 6 * atom.epsilon / (C.CUTOFF ** 7 * atom.sigma);
      const k = -(6 * atom.epsilon * atom.sigma ** 6 / r ** 7 - slope) / r;
      x += a * k; y += b * k; z += c * k;
    }
    const radial = Math.hypot(p.x, p.z);
    if (radial > edgeRadius) { const k = -C.K_EDGE * (radial - edgeRadius) / radial; x += p.x * k; z += p.z * k; }
    return clampMagnitude({ x, y, z }, constants.A_MAX_SURFACE ?? C.A_MAX_SURFACE);
  }
  function damping(p) {
    p = point(p);
    let count = 0;
    for (const bond of nearBonds(p)) if (segmentDistance(p, bond.from, bond.to) <= C.BOND_DENSITY_RADIUS) count++;
    return C.DAMPING_FREE + C.DAMP_BOND * Math.min(1, count / C.BOND_DENSITY_REF);
  }
  function buffet(p, time = 0) {
    const molecule = childAt(p), temperature = Math.max(0, finite(molecule?.temperature));
    if (!temperature) return { x: 0, y: 0, z: 0 };
    const seed = hash(molecule.id) / 4294967296 * 20, t = finite(time);
    const noise = { x: Math.sin(seed + p.x * .08 + t * 1.7), y: Math.sin(seed * 1.7 + p.z * .09 + t * 2.1), z: Math.cos(seed * .6 + p.x * .04 + p.z * .04 + t * 1.3) };
    const size = length(noise), scale = C.BUFFET_K * temperature / Math.max(1e-12, size);
    return { x: noise.x * scale, y: noise.y * scale, z: noise.z * scale };
  }
  return { kind: 'molecular', bodies: children, constants, potential, acceleration, damping, buffet, refresh, cohesionPotential: (p) => cohesion(p.x, p.z), childMoleculeAt: childAt,
    ...sampledField(cohesion, children, C.H_SURFACE_MAX) };
}

/** Grid blending preserves a shared visual/HUD transition; fields can blend too. */
export function interpolate(a, b, fraction) {
  const t = Math.max(0, Math.min(1, finite(fraction))), mix = (x, y) => x * (1 - t) + y * t;
  if (typeof a?.potential === 'function' && typeof b?.potential === 'function') {
    const vector = (x, y) => ({ x: mix(x.x, y.x), y: mix(x.y, y.y), z: mix(x.z, y.z) });
    return { ...b, potential: (p) => mix(a.potential(p), b.potential(p)), acceleration: (p) => vector(a.acceleration(p), b.acceleration(p)),
      curvature: (p) => mix(a.curvature(p), b.curvature(p)), damping: (p) => mix(a.damping(p), b.damping(p)),
      buffet: (p, time) => vector(a.buffet?.(p, time) ?? { x: 0, y: 0, z: 0 }, b.buffet?.(p, time) ?? { x: 0, y: 0, z: 0 }),
      sampleGrid: (bounds, n) => interpolate(a.sampleGrid(bounds, n), b.sampleGrid(bounds, n), t) };
  }
  if (!a || a.resolution !== b.resolution || JSON.stringify(a.bounds) !== JSON.stringify(b.bounds)) return b;
  const array = (first, second) => Float32Array.from(second, (value, i) => mix(first[i], value));
  const heights = array(a.heights, b.heights), gradients = array(a.gradients, b.gradients);
  return { ...b, heights, height: heights, gradients, gradient: gradients, curvature: array(a.curvature, b.curvature) };
}
