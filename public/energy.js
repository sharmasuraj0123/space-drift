import { HALF_LIFE_MS } from './constants.js';

const numeric = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
export const timestamp = (value) => typeof value === 'number' ? numeric(value) : numeric(Date.parse(value));
export function restMass(body = {}) {
  return Math.max(0, numeric(body.restMass ?? body.atomicMass ?? body.molecularMass ?? body.size));
}
export function decayedExcitation(x, at, now = Date.now()) {
  return Math.max(0, numeric(x)) * 2 ** (-Math.max(0, timestamp(now) - timestamp(at)) / HALF_LIFE_MS);
}
export function excitationAt(body = {}, now = Date.now()) {
  return decayedExcitation(body.excitation, body.excitationAt ?? now, now);
}
export function effectiveMass(body, now = Date.now()) { return restMass(body) + excitationAt(body, now); }
export function excitationRatio(body, now = Date.now()) { return Math.min(1, excitationAt(body, now) / Math.max(restMass(body), 1)); }
export function sumExcitation(bodies, now = Date.now()) { return [...bodies].reduce((sum, body) => sum + excitationAt(body, now), 0); }
