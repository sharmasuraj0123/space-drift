import { HALF_LIFE_MS, LAMBDA_DAY, L_MIN, AMBIENT, ILLUM_GAIN, FLASH_SECONDS, ELEMENT_COLORS } from './constants.js';

const clamp = (n, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo));
const time = (n, fallback) => typeof n === 'number' && Number.isFinite(n) ? n : Number.isFinite(Date.parse(n)) ? Date.parse(n) : fallback;
const location = (body) => body?.center || body?.position || { x: 0, y: 0, z: 0 };
const identity = (event) => event.atomId || event.path || event.bodyId || event.planetId || event.id;
export function rgb(value) {
  if (Array.isArray(value)) return value.slice(0, 3).map((c) => clamp(Number(c)));
  const hex = typeof value === 'string' ? parseInt(value.replace('#', ''), 16) : Number(value);
  return Number.isFinite(hex) ? [(hex >> 16 & 255) / 255, (hex >> 8 & 255) / 255, (hex & 255) / 255] : rgb(ELEMENT_COLORS.other);
}
export function remainingExcitation(body, now = Date.now()) {
  const initial = Math.max(0, Number(body?.excitation) || 0);
  return initial * 2 ** (-Math.max(0, now - time(body?.excitationAt, now)) / HALF_LIFE_MS);
}
export function luminosity(body, now = Date.now()) { return LAMBDA_DAY * remainingExcitation(body, now); }
export function emits(body, now = Date.now()) { return luminosity(body, now) > L_MIN; }
export function emissionColor(atom, now = Date.now()) {
  const base = rgb(ELEMENT_COLORS[atom?.element] ?? ELEMENT_COLORS.other);
  const mass = Number(atom?.atomicMass ?? atom?.restMass ?? atom?.molecularMass ?? atom?.size ?? 0);
  const ratio = atom?.excitation !== undefined ? remainingExcitation(atom, now) / Math.max(mass, 1) : Number(atom?.xi) || 0;
  const xi = clamp(ratio);
  return base.map((component, index) => component + ([.9, .96, 1][index] - component) * xi);
}
export function bodyColor(body, atoms = [], now = Date.now()) {
  const colors = [0, 0, 0]; let total = 0;
  for (const atom of atoms) {
    const weight = luminosity(atom, now);
    if (!weight) continue;
    const color = emissionColor(atom, now);
    for (let i = 0; i < 3; i++) colors[i] += color[i] * weight;
    total += weight;
  }
  // All positive contributions count, even when each atom is below L_MIN.
  return total > 0 ? colors.map((value) => value / total) : body?.color ? rgb(body.color) : emissionColor(body, now);
}
export function irradiance(value, distance, minimumDistance = 1) {
  return Math.max(0, Number(value) || 0) / (4 * Math.PI * Math.max(minimumDistance, Math.abs(Number(distance) || 0)) ** 2);
}
export function illumination(body, bodies, now = Date.now()) {
  const p = location(body); let received = 0;
  for (const other of bodies || []) {
    if (other === body || (body?.id !== undefined && other.id === body.id) || !emits(other, now)) continue;
    const q = location(other);
    received += irradiance(luminosity(other, now), Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z));
  }
  return clamp(AMBIENT + ILLUM_GAIN * received);
}
export function skyStars(body, bodies, now = Date.now()) {
  const p = location(body);
  return (bodies || []).filter((other) => other.id !== body?.id).map((other) => {
    const q = location(other), dx = q.x - p.x, dy = q.y - p.y, dz = q.z - p.z;
    const distance = Math.hypot(dx, dy, dz), divisor = distance || 1;
    return { id: other.id, name: other.name, bearing: { x: dx / divisor, y: dy / divisor, z: dz / divisor }, distance,
      luminosity: luminosity(other, now), color: bodyColor(other, [], now), illumination: illumination(other, bodies, now), emits: emits(other, now) };
  });
}
export function flashesFrom(events, previousExcitations = new Map(), now = Date.now()) {
  const result = [], seen = new Set();
  for (const event of events || []) {
    const id = identity(event); if (!id || seen.has(id) || event.type === 'deleted') continue;
    const previous = previousExcitations instanceof Map ? previousExcitations.get(id) : previousExcitations[id];
    const before = event.previousExcitation ?? (typeof previous === 'object' ? remainingExcitation(previous, now) : previous);
    const after = Number(event.excitation ?? event.currentExcitation);
    const at = time(event.at ?? event.excitationAt, now);
    if (!Number.isFinite(before) || !Number.isFinite(after) || after <= before + Math.max(1e-9, Math.abs(before) * 1e-12) || now - at >= FLASH_SECONDS * 1000 || at > now) continue;
    seen.add(id); result.push({ id, at, until: at + FLASH_SECONDS * 1000, delta: after - before, position: event.position ?? event.center });
  }
  return result;
}
export function coolingFrom(events, now = Date.now()) {
  const seen = new Set();
  return (events || []).filter((event) => event.type === 'deleted').flatMap((event) => {
    const id = identity(event), at = time(event.at, now), progress = clamp((now - at) / (FLASH_SECONDS * 1000));
    if (!id || seen.has(id) || at > now || progress >= 1) return [];
    seen.add(id); return [{ id, at, until: at + FLASH_SECONDS * 1000, progress, intensity: 1 - progress, emits: false, position: event.position ?? event.center }];
  });
}
