import test from 'node:test';
import assert from 'node:assert/strict';
import { decayedExcitation, excitationAt, effectiveMass, excitationRatio, sumExcitation } from '../public/energy.js';
import { HALF_LIFE_MS } from '../public/constants.js';
const now = Date.parse('2026-09-08T12:00:00Z');

test('excitation halves at 72 hours without changing rest mass', () => {
  const atom = { atomicMass: 100, excitation: 80, excitationAt: new Date(now).toISOString() };
  assert.equal(decayedExcitation(80, now, now + HALF_LIFE_MS), 40);
  assert.equal(excitationAt(atom, now + HALF_LIFE_MS), 40);
  assert.equal(effectiveMass(atom, now + HALF_LIFE_MS), 140);
  assert.equal(excitationRatio(atom, now + HALF_LIFE_MS), .4);
  assert.equal(atom.atomicMass, 100);
});
test('additive excitation survives mixed timestamps and remains finite for empty data', () => {
  assert.equal(sumExcitation([{ excitation: 50, excitationAt: now }, { excitation: 100, excitationAt: now - HALF_LIFE_MS }], now), 100);
  assert.equal(sumExcitation([], now), 0);
  assert.equal(effectiveMass({ restMass: 0, excitation: 0 }, now), 0);
  assert.equal(excitationRatio({ restMass: 0, excitation: 0 }, now), 0);
  assert.equal(decayedExcitation(-20, now, now), 0);
  assert.equal(decayedExcitation(80, now + HALF_LIFE_MS, now), 80);
});
