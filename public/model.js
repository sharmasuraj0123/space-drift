/**
 * Metadata becomes a navigable metaphor here: bytes give files visual mass,
 * modification times create currents, and folders become islands. No file
 * contents are read or modified by this simulation.
 */

export const PALETTE = [0x68e4ef, 0xaab8ff, 0xc4a5ff, 0xffad9b, 0x77b9ff, 0xf29bd3];
const TAU = Math.PI * 2;
const SHIP_RADIUS = 1.4;
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const finite = (n, fallback = 0) => Number.isFinite(Number(n)) ? Number(n) : fallback;

export const PROBE_MAX_RANGE = 160;
export const PROBE_ANGLE_TOLERANCE = .035;

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

function currentForce(position, world) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const sector of world.sectors || []) {
    const dx = sector.position.x - position.x;
    const dy = sector.position.y + 8 - position.y;
    const dz = sector.position.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 0.01 || distance > 220) continue;
    const falloff = (1 - distance / 220) ** 2;
    // Gentle attraction makes mass tangible; fresh data adds a circular flow.
    const pull = falloff * 1.5;
    const swirl = falloff * finite(sector.activity) * 5;
    x += (dx * pull - dz * swirl) / distance;
    y += dy * pull / distance;
    z += (dz * pull + dx * swirl) / distance;
  }
  const length = Math.hypot(x, y, z);
  const scale = length > 5 ? 5 / length : 1;
  return { x: x * scale, y: y * scale, z: z * scale };
}

function resolveFileInteractions(ship, files, dt, currents) {
  let pullX = 0;
  let pullY = 0;
  let pullZ = 0;
  for (const file of files) {
    const dx = ship.position.x - file.position.x;
    const dy = ship.position.y - file.position.y;
    const dz = ship.position.z - file.position.z;
    const radius = Math.max(0.1, finite(file.radius, 1));
    const mass = clamp(finite(file.mass, 1), 1, 12);
    // The renderer stretches crystals vertically by this same mass factor.
    // Use an ellipsoid around that mesh so its visible tips are tangible too.
    const verticalRadius = radius * (1.3 + mass * 0.08) + SHIP_RADIUS;
    const horizontalRadius = radius + SHIP_RADIUS;
    const distanceSquared = dx * dx + dy * dy + dz * dz;
    const interactionRadius = Math.max(18, verticalRadius, horizontalRadius);
    if (distanceSquared > interactionRadius * interactionRadius) continue;
    if (currents && distanceSquared > 0.0001 && distanceSquared < 18 * 18) {
      const distance = Math.sqrt(distanceSquared);
      const strength = (0.07 + mass * 0.04) * (1 - distance / 18) ** 2 / distance;
      pullX -= dx * strength;
      pullY -= dy * strength;
      pullZ -= dz * strength;
    }
    const scaledDistance = Math.hypot(dx / horizontalRadius, dy / verticalRadius, dz / horizontalRadius);
    if (scaledDistance >= 1) continue;
    // An exact center hit needs a defined normal, otherwise 0/0 poisons motion.
    const push = scaledDistance > 0.00001 ? 1.002 / scaledDistance : 0;
    const surfaceX = dx * push;
    const surfaceY = push ? dy * push : verticalRadius + 0.01;
    const surfaceZ = dz * push;
    ship.position.x = file.position.x + surfaceX;
    ship.position.y = file.position.y + surfaceY;
    ship.position.z = file.position.z + surfaceZ;
    // The gradient gives the contact normal on the stretched surface.
    const gradientX = surfaceX / (horizontalRadius * horizontalRadius);
    const gradientY = surfaceY / (verticalRadius * verticalRadius);
    const gradientZ = surfaceZ / (horizontalRadius * horizontalRadius);
    const gradientLength = Math.hypot(gradientX, gradientY, gradientZ);
    const nx = gradientX / gradientLength;
    const ny = gradientY / gradientLength;
    const nz = gradientZ / gradientLength;
    const inwardSpeed = ship.velocity.x * nx + ship.velocity.y * ny + ship.velocity.z * nz;
    if (inwardSpeed < 0) {
      ship.velocity.x -= inwardSpeed * nx * 1.25;
      ship.velocity.y -= inwardSpeed * ny * 1.25;
      ship.velocity.z -= inwardSpeed * nz * 1.25;
    }
  }
  // Dense folders must not turn into singularities: cap the combined nearby
  // pull, while preserving the direction and relative effect of file masses.
  const pullLength = Math.hypot(pullX, pullY, pullZ);
  const scale = pullLength > 1.2 ? 1.2 / pullLength : 1;
  ship.velocity.x += pullX * scale * dt;
  ship.velocity.y += pullY * scale * dt;
  ship.velocity.z += pullZ * scale * dt;
}

/**
 * W/thrust moves toward -Z at yaw 0. Positive turn turns left; lift moves up.
 * Exponential steering/damping and bounded substeps keep motion stable on both
 * fast screens and delayed frames. Currents are a simulated interpretation of
 * metadata, rather than a measurement of disk I/O.
 */
export function stepShip(ship, input = {}, world = {}, dt = 0, { currents = true } = {}) {
  ship.position ||= { x: 0, y: 12, z: 100 };
  ship.velocity ||= { x: 0, y: 0, z: 0 };
  for (const axis of ['x', 'y', 'z']) {
    ship.position[axis] = finite(ship.position[axis]);
    ship.velocity[axis] = finite(ship.velocity[axis]);
  }
  ship.yaw = finite(ship.yaw);
  const elapsed = clamp(finite(dt), 0, 0.1);
  if (!elapsed) return ship;
  const steps = Math.ceil(elapsed / (1 / 120));
  const tick = elapsed / steps;
  const thrust = clamp(finite(input.thrust), -1, 1);
  const lift = clamp(finite(input.lift), -1, 1);
  const turn = clamp(finite(input.turn), -1, 1);
  const speed = input.boost ? 120 : 45;
  const damping = input.brake ? 9 : 1.8;
  const blend = Math.exp(-damping * tick);
  for (let i = 0; i < steps; i++) {
    ship.yaw += turn * 1.65 * tick;
    ship.yaw = Math.atan2(Math.sin(ship.yaw), Math.cos(ship.yaw));
    const target = input.brake ? { x: 0, y: 0, z: 0 } : {
      x: -Math.sin(ship.yaw) * speed * thrust,
      y: lift * speed * 0.7,
      z: -Math.cos(ship.yaw) * speed * thrust,
    };
    const force = currents && !input.brake ? currentForce(ship.position, world) : { x: 0, y: 0, z: 0 };
    for (const axis of ['x', 'y', 'z']) {
      ship.velocity[axis] = ship.velocity[axis] * blend + target[axis] * (1 - blend) + force[axis] * tick;
    }
    const magnitude = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
    if (magnitude > 150) {
      for (const axis of ['x', 'y', 'z']) ship.velocity[axis] *= 150 / magnitude;
    }
    for (const axis of ['x', 'y', 'z']) ship.position[axis] += ship.velocity[axis] * tick;
    // At 120 Hz, even the maximum speed cannot tunnel through the smallest file.
    resolveFileInteractions(ship, world.files || [], tick, currents && !input.brake);
  }
  return ship;
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

/**
 * Select the closest file inside an aim ray's angular cone. The renderer owns
 * ray construction; keeping this comparison here makes the targeting rule
 * deterministic and testable without Three.js.
 */
export function findProbeTarget(files, origin, direction, { angularTolerance = PROBE_ANGLE_TOLERANCE, maxDistance = Infinity } = {}) {
  const length = Math.hypot(finite(direction?.x), finite(direction?.y), finite(direction?.z));
  if (!length || angularTolerance < 0) return null;
  const ray = { x: finite(direction.x) / length, y: finite(direction.y) / length, z: finite(direction.z) / length };
  const minimumDot = Math.cos(angularTolerance);
  let target = null;
  for (const file of files || []) {
    const dx = finite(file.position?.x) - finite(origin?.x);
    const dy = finite(file.position?.y) - finite(origin?.y);
    const dz = finite(file.position?.z) - finite(origin?.z);
    const distance = Math.hypot(dx, dy, dz);
    if (!distance || distance > maxDistance) continue;
    const dot = (dx * ray.x + dy * ray.y + dz * ray.z) / distance;
    if (dot < minimumDot || (target && distance >= target.distance)) continue;
    target = { file, distance, angle: Math.acos(clamp(dot, -1, 1)) };
  }
  return target;
}

/** Create a cosmetic probe. A null result means its target is out of range. */
export function createProbe(origin, target, maxDistance = PROBE_MAX_RANGE) {
  const targetPosition = target?.position;
  const distance = Math.hypot(
    finite(targetPosition?.x) - finite(origin?.x),
    finite(targetPosition?.y) - finite(origin?.y),
    finite(targetPosition?.z) - finite(origin?.z),
  );
  if (!targetPosition || !Number.isFinite(distance) || distance > maxDistance) return null;
  const start = { x: finite(origin?.x), y: finite(origin?.y), z: finite(origin?.z) };
  return {
    id: target.id,
    origin: start,
    target: { x: finite(targetPosition.x), y: finite(targetPosition.y), z: finite(targetPosition.z) },
    position: { ...start },
    elapsed: 0,
    duration: clamp(.3 + distance / 320, .3, .8),
  };
}

/** Advance a probe in place and report whether it reached its target. */
export function stepProbe(probe, dt = 0) {
  if (!probe) return true;
  probe.elapsed = clamp(finite(probe.elapsed) + Math.max(0, finite(dt)), 0, finite(probe.duration));
  const progress = probe.duration ? probe.elapsed / probe.duration : 1;
  for (const axis of ['x', 'y', 'z']) probe.position[axis] = probe.origin[axis] + (probe.target[axis] - probe.origin[axis]) * progress;
  return progress >= 1;
}

export function formatBytes(value) {
  const size = Math.max(0, finite(value));
  if (size < 1024) return `${Math.round(size)} B`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
  const amount = size / 1024 ** unit;
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}
