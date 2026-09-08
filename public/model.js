import * as C from './constants.js';

/**
 * Metadata becomes a navigable metaphor here: bytes give files visual mass,
 * modification times create currents, and folders become islands. No file
 * contents are read or modified by this simulation.
 */

export const PALETTE = [0x68e4ef, 0xaab8ff, 0xc4a5ff, 0xffad9b, 0x77b9ff, 0xf29bd3];
export const SCAN_RANGE = 18;
export const SHOT_RANGE = 90;
const SHOT_HALF_ANGLE = 12 * Math.PI / 180;
const SHOT_VERTICAL_TOLERANCE = 30;
const TAU = Math.PI * 2;
const SHIP_RADIUS = 1.4;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;

/** Stable unsigned FNV-1a hash; layout never depends on Math.random(). */
export function hash(value) {
  const text = String(value);
  let result = 2166136261;
  for (let i = 0; i < text.length; i++) {
    result ^= text.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

const randomFor = (path, salt) => hash(`${path}:${salt}`) / 4294967296;
const cleanPath = (path) => String(path || '').replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
const parsedTime = (value) => {
  const result = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(result) ? result : 0;
};

function topDirectory(file) {
  const path = cleanPath(file.path || file.id || file.name);
  const slash = path.indexOf('/');
  return slash < 0 ? '.' : path.slice(0, slash);
}

function activityAt(time, now, decayHours = 48) {
  if (!time) return 0;
  return Math.exp(-Math.max(0, now - time) / (decayHours * 3600000));
}

/**
 * Build a deterministic map of at most 24 islands. File offsets are keyed only
 * by their paths, so adding a file to a folder does not rearrange its neighbors.
 * Folder names use a canonical order; adding/removing a whole folder can change
 * its map slot. The renderer can interpolate between these snapshot layouts.
 */
export function buildWorld(snapshot = {}) {
  const rawFiles = Array.isArray(snapshot.files) ? snapshot.files : [];
  const now = parsedTime(snapshot.scannedAt) || Math.max(0, ...rawFiles.map((f) => parsedTime(f.modifiedAt)));
  const groups = new Map();
  for (const file of rawFiles) {
    const path = cleanPath(file.path || file.id || file.name);
    if (!path) continue;
    const group = topDirectory(file);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({ ...file, path });
  }

  let keys = [...groups.keys()].sort((a, b) => a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b));
  if (keys.length > 24) {
    const overflowKeys = keys.slice(23);
    const overflow = overflowKeys.flatMap((key) => groups.get(key));
    for (const key of overflowKeys) groups.delete(key);
    groups.set('__other_folders__', overflow);
    keys = [...keys.slice(0, 23), '__other_folders__'];
  }

  const eventTimes = new Map();
  for (const event of snapshot.events || []) {
    const path = cleanPath(event.path);
    eventTimes.set(path, Math.max(eventTimes.get(path) || 0, parsedTime(event.at)));
  }
  // Favor the view ahead of the ship before filling in the back of each ring.
  const slotOrder = [0, 1, 7, 2, 6, 3, 5, 4];
  const sectors = keys.map((key, index) => {
    const ring = Math.floor(index / 8);
    const angle = slotOrder[index % 8] * TAU / 8;
    const distance = 170 + ring * 130;
    const position = {
      x: Math.sin(angle) * distance,
      y: (randomFor(key, 'altitude') - 0.5) * 14,
      z: -Math.cos(angle) * distance,
    };
    const color = PALETTE[hash(key) % PALETTE.length];
    const inputFiles = groups.get(key).sort((a, b) => a.path.localeCompare(b.path));
    const radius = Math.min(48, 24 + Math.sqrt(inputFiles.length) * 2);
    const files = inputFiles.map((file) => {
      const size = Math.max(0, finite(file.size));
      const azimuth = randomFor(file.path, 'angle') * TAU;
      const spread = 8 + Math.sqrt(randomFor(file.path, 'spread')) * 21;
      const activity = Math.max(
        activityAt(parsedTime(file.modifiedAt), now),
        activityAt(eventTimes.get(file.path), now, 0.5),
      );
      return {
        ...file,
        id: file.id || file.path,
        name: file.name || file.path.split('/').at(-1),
        parent: file.parent || file.path.split('/').slice(0, -1).join('/') || '.',
        size,
        sectorId: key,
        position: {
          x: position.x + Math.cos(azimuth) * spread,
          y: position.y + 1 + randomFor(file.path, 'height') * 21,
          z: position.z + Math.sin(azimuth) * spread,
        },
        radius: clamp(0.9 + Math.log10(size + 1) * 0.24, 0.9, 2.7),
        color,
        mass: clamp(1 + Math.log2(size + 1) / 5, 1, 12),
        activity,
        phase: randomFor(file.path, 'phase') * TAU,
      };
    });
    return {
      id: key,
      name: key === '.' ? snapshot.root?.name || 'Root files' : key === '__other_folders__' ? 'Other folders' : key,
      path: key === '__other_folders__' ? '' : key,
      position,
      radius,
      color,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
      fileCount: files.length,
      activity: files.reduce((sum, file) => sum + file.activity, 0) / files.length,
      files,
    };
  });
  const center = sectors.reduce((sum, sector) => ({
    x: sum.x + sector.position.x / sectors.length,
    y: sum.y + sector.position.y / sectors.length,
    z: sum.z + sector.position.z / sectors.length,
  }), { x: 0, y: 0, z: 0 });
  return {
    sectors,
    files: sectors.flatMap((sector) => sector.files),
    bounds: Math.max(250, ...sectors.map((sector) => Math.hypot(sector.position.x, sector.position.z) + sector.radius + 80)),
    center,
  };
}

function resolveCollisions(ship, world) {
  const colliders = world.colliders ?? (world.files ?? []).map((file) => ({
    center: file.position, radius: file.radius, kind: 'ellipsoid',
    scaleY: 1.3 + clamp(finite(file.mass, 1), 1, 12) * .08,
  }));
  for (const collider of colliders) {
    const center = collider.center ?? collider.position;
    if (!center) continue;
    const radius = Math.max(.1, finite(collider.radius, 1));
    const horizontal = radius + C.SHIP_RADIUS;
    const vertical = (collider.kind === 'sphere' ? radius : radius * finite(collider.scaleY, 1.5)) + C.SHIP_RADIUS;
    const dx = ship.position.x - center.x, dy = ship.position.y - center.y, dz = ship.position.z - center.z;
    if (Math.abs(dx) > horizontal || Math.abs(dz) > horizontal || Math.abs(dy) > vertical) continue;
    const distance = Math.hypot(dx / horizontal, dy / vertical, dz / horizontal);
    if (distance >= 1) continue;
    const scale = distance > 1e-9 ? 1.00001 / distance : 0;
    let x = dx * scale, y = scale ? dy * scale : vertical + .001, z = dz * scale;
    const floor = Number.isFinite(world.floor) ? world.floor + C.SHIP_RADIUS : -Infinity;
    if (center.y + y < floor && Math.abs((floor - center.y) / vertical) < 1) {
      // A newly packed atom can enclose a grounded ship. Project sideways along
      // the floor's ellipse section; projecting downward would pin it forever.
      y = floor - center.y;
      const planar = Math.hypot(dx, dz), required = horizontal * Math.sqrt(1 - (y / vertical) ** 2) + .001;
      x = planar > 1e-9 ? dx / planar * required : 0;
      z = planar > 1e-9 ? dz / planar * required : required;
    }
    ship.position.x = center.x + x; ship.position.y = center.y + y; ship.position.z = center.z + z;
    const nx = x / (horizontal * horizontal), ny = y / (vertical * vertical), nz = z / (horizontal * horizontal);
    const normalLength = Math.hypot(nx, ny, nz);
    const inward = (ship.velocity.x * nx + ship.velocity.y * ny + ship.velocity.z * nz) / normalLength;
    if (inward < 0) {
      ship.velocity.x -= inward * nx / normalLength * 1.1;
      ship.velocity.y -= inward * ny / normalLength * 1.1;
      ship.velocity.z -= inward * nz / normalLength * 1.1;
    }
  }
  if (Number.isFinite(world.floor)) {
    const floor = world.floor + C.SHIP_RADIUS;
    if (ship.position.y < floor) { ship.position.y = floor; ship.velocity.y = Math.max(0, ship.velocity.y); }
  }
}

/** Fixed 120 Hz simulation: explicit field, local drag, bounded control and contact.
 * Hold cancels the evaluated field; ordinary braking keeps gravity active.
 * Simulation time drives deterministic buffet independently of display cadence.
 */
export function stepShip(ship, input = {}, world = {}, dt = 0, { field = true } = {}) {
  ship.position ||= { x: 0, y: 12, z: 100 }; ship.velocity ||= { x: 0, y: 0, z: 0 };
  for (const axis of ['x', 'y', 'z']) { ship.position[axis] = finite(ship.position[axis]); ship.velocity[axis] = finite(ship.velocity[axis]); }
  ship.yaw = finite(ship.yaw); ship.simulationTime = finite(ship.simulationTime);
  const elapsed = clamp(finite(dt), 0, .1);
  if (!elapsed) return ship;
  ship._accumulator = Math.max(0, finite(ship._accumulator)) + elapsed;
  const tick = C.PHYSICS_STEP, thrust = clamp(finite(input.thrust), -1, 1), lift = clamp(finite(input.lift), -1, 1), turn = clamp(finite(input.turn), -1, 1);
  while (ship._accumulator + 1e-12 >= tick) {
    ship._accumulator = Math.max(0, ship._accumulator - tick);
    ship.yaw += turn * 1.65 * tick; ship.yaw = Math.atan2(Math.sin(ship.yaw), Math.cos(ship.yaw));
    const holding = !!input.hold, braking = holding || !!input.brake;
    const localDamping = field ? world.field?.damping?.(ship.position) : C.DAMPING_FREE;
    const damping = braking ? C.DAMPING_BRAKE : Math.max(.01, finite(localDamping, C.DAMPING_FREE));
    const blend = Math.exp(-damping * tick), response = (1 - blend) / damping;
    const drive = input.boost ? C.THRUST_BOOST : C.THRUST_CRUISE;
    const control = braking ? { x: 0, y: 0, z: 0 } : { x: -Math.sin(ship.yaw) * drive * thrust, y: .7 * drive * lift, z: -Math.cos(ship.yaw) * drive * thrust };
    const gravity = field ? world.field?.acceleration?.(ship.position) : null;
    const buffet = field ? world.field?.buffet?.(ship.position, ship.simulationTime) : null;
    const force = { x: finite(gravity?.x) + finite(buffet?.x), y: finite(gravity?.y) + finite(buffet?.y), z: finite(gravity?.z) + finite(buffet?.z) };
    if (holding) {
      const magnitude = Math.hypot(force.x, force.y, force.z), factor = magnitude > C.THRUST_BOOST ? C.THRUST_BOOST / magnitude : 1;
      for (const axis of ['x', 'y', 'z']) control[axis] = -force[axis] * factor;
    }
    for (const axis of ['x', 'y', 'z']) ship.velocity[axis] = ship.velocity[axis] * blend + (control[axis] + force[axis]) * response;
    const speed = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    if (speed > C.MAX_SPEED) for (const axis of ['x', 'y', 'z']) ship.velocity[axis] *= C.MAX_SPEED / speed;
    for (const axis of ['x', 'y', 'z']) ship.position[axis] += ship.velocity[axis] * tick;
    resolveCollisions(ship, world); ship.simulationTime += tick;
  }
  return ship;
}

export function findNearest(items, position, maxDistance = Infinity) {
  let nearest = null, best = maxDistance;
  for (const item of items ?? []) {
    const p = item.position ?? item.center;
    if (!p) continue;
    const distance = Math.hypot(p.x - position.x, p.y - position.y, p.z - position.z);
    if (distance <= best) { nearest = item; best = distance; }
  }
  return nearest;
}

export function findNearestFile(world, position, maxDistance = Infinity) {
  let nearest = null;
  let bestDistance = maxDistance;
  for (const file of world?.files || []) {
    const distance = Math.hypot(file.position.x - position.x, file.position.y - position.y, file.position.z - position.z);
    if (distance <= bestDistance) {
      bestDistance = distance;
      nearest = file;
    }
  }
  return nearest;
}

/** Nearby files need no aim; ranged shots use yaw with forgiving altitude. */
export function findScanCandidate(world, ship, focusedFileId = null) {
  const files = world?.files || [];
  const rangeTo = (file) => Math.hypot(file.position.x - ship.position.x, file.position.y - ship.position.y, file.position.z - ship.position.z);
  const focused = files.find((file) => file.id === focusedFileId);
  if (focused && rangeTo(focused) <= SCAN_RANGE) return focused;
  const nearby = findNearestFile(world, ship.position, SCAN_RANGE);
  if (nearby) return nearby;
  // Keep the atlas lock in range, but never override a point-blank file.
  if (focused && rangeTo(focused) <= SHOT_RANGE) return focused;

  let best = null, bestAngle = Infinity, bestDistance = Infinity;
  for (const file of files) {
    const dx = file.position.x - ship.position.x, dy = file.position.y - ship.position.y, dz = file.position.z - ship.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > SHOT_RANGE || Math.abs(dy) > SHOT_VERTICAL_TOLERANCE || Math.hypot(dx, dz) === 0) continue;
    const heading = Math.atan2(-dx, -dz);
    const angle = Math.abs(Math.atan2(Math.sin(heading - ship.yaw), Math.cos(heading - ship.yaw)));
    if (angle > SHOT_HALF_ANGLE) continue;
    if (angle < bestAngle || angle === bestAngle && distance < bestDistance) {
      best = file; bestAngle = angle; bestDistance = distance;
    }
  }
  return best;
}

/** A shot leaves the ship's nose and keeps its launch/impact points as flight continues. */
export function createFileShot(ship, file) {
  const start = { x: ship.position.x - Math.sin(ship.yaw) * 5.4, y: ship.position.y + .6, z: ship.position.z - Math.cos(ship.yaw) * 5.4 };
  const end = { ...file.position };
  const distance = Math.hypot(end.x - start.x, end.y - start.y, end.z - start.z);
  return { file, start, end, distance, duration: Math.max(.45, distance / 100), age: 0, progress: 0, phase: 'flight' };
}

/** Emit each event once, leaving a visible impact beat before the modal opens. */
export function stepFileShot(shot, dt) {
  if (shot.phase === 'complete') return null;
  shot.age += clamp(finite(dt), 0, .1);
  if (shot.phase === 'flight') {
    shot.progress = Math.min(1, shot.age / shot.duration);
    if (shot.progress < 1) return null;
    shot.phase = 'impact'; shot.age = 0;
    return 'impact';
  }
  if (shot.age < .2) return null;
  shot.phase = 'complete';
  return 'open';
}

export function formatBytes(value) {
  const size = Math.max(0, finite(value));
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  const amount = size / 1024 ** unit;
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}
