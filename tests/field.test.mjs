import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import * as C from '../public/constants.js';
import { deriveSystemConstants, deriveSurfaceConstants, gravityField, chemistryField, horizonRadius, landingRadius, escapeVelocity, captureState, surfaceGravity, interpolate } from '../public/field.js';
const now = Date.now();
const body = (id = 'heavy', restMass = 200 * 1024 ** 2, radius = 54, center = { x: 0, y: 0, z: 0 }) => ({ id, restMass, effMass: restMass, radius, center, survey: { pending: false } });
const molecule = (id = 'src', molecularMass = 4000, clusterRadius = 20, center = { x: 0, y: 0, z: 0 }) => ({ id, molecularMass, effMass: molecularMass, clusterRadius, center, temperature: 0, depth: 1 });
const magnitude = (p) => Math.hypot(p.x, p.y, p.z);
const close = (a, b, e = 1e-7) => assert(Math.abs(a - b) <= e * Math.max(1, Math.abs(b)), `${a} != ${b}`);
function assertGradient(field, points) {
  for (const p of points) {
    const force = field.acceleration(p), h = 1e-3;
    for (const axis of ['x', 'y', 'z']) {
      const positive = { ...p, [axis]: p[axis] + h }, negative = { ...p, [axis]: p[axis] - h };
      const expected = -(field.potential(positive) - field.potential(negative)) / (2 * h);
      close(force[axis], expected, 1e-3);
    }
  }
}

test('space calibration, fixed-radius scaling, pending transitions and worked example', () => {
  const heavy = body(), small = body('small', heavy.restMass / 10, 54, { x: 300, y: 0, z: 0 });
  const constants = deriveSystemConstants([heavy, small]);
  const field = gravityField([heavy], constants);
  close(magnitude(field.acceleration({ x: 108, y: 0, z: 0 })), C.A_BODY);
  const surface = magnitude(field.acceleration({ x: 54, y: 0, z: 0 }));
  assert(surface > 98 && surface < 100);
  close(horizonRadius(heavy, constants), 108);
  assert(horizonRadius(small, constants) < small.radius);
  const doubled = { ...heavy, effMass: heavy.restMass * 2 };
  close(horizonRadius(doubled, constants), 216);
  const scaled = [heavy, small].map((b) => ({ ...b, restMass: b.restMass * 2, effMass: b.restMass * 2 }));
  const p = { x: 180, y: 40, z: 60 };
  close(magnitude(gravityField(scaled, deriveSystemConstants(scaled)).acceleration(p)), magnitude(gravityField([heavy, small], constants).acceleration(p)));
  const pending = { ...body('pending', 1e12), survey: { pending: true } };
  const next = deriveSystemConstants([heavy, small, pending], constants);
  close(next.G, constants.G); assert.equal(next.version, constants.version + 1);
  assert.deepEqual(gravityField([heavy, small, pending], next).acceleration(p), gravityField([heavy, small], constants).acceleration(p));
  assert.equal(deriveSystemConstants([pending]).G, 0);
  assert(Number.isFinite(deriveSystemConstants([]).cSquared));
  assert.equal(deriveSystemConstants([{ ...heavy, restMass: 1e9 }], deriveSystemConstants([heavy])).G, constants.G);
  assert(constants.G > .0038 && constants.G < .0040);
  assert(constants.cSquared > 15000 && constants.cSquared < 15200);
  const speed = escapeVelocity(heavy, { x: 108, y: 0, z: 0 }, constants);
  assert(speed > C.SPEED_CRUISE && speed < C.SPEED_BOOST);
  assert(escapeVelocity(heavy, { x: 216, y: 0, z: 0 }, constants) < speed);
  assert.equal(captureState(heavy, { position: { x: 100, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 } }, constants).captured, true);
  assert.equal(captureState(heavy, { position: { x: 100, y: 0, z: 0 }, velocity: { x: 120, y: 0, z: 0 } }, constants).skimming, true);
  assert(landingRadius(small, constants) >= small.radius + C.ATMOSPHERE);
});

test('both conservative fields match numerical gradients away from contact and clamps', () => {
  const astro = gravityField([body()], { G: .001 });
  const mol = molecule();
  const atom = { id: 'atom', atomicMass: 1024, xi: .5, radius: 1.5, position: { x: 0, y: 5, z: 0 } };
  const molecular = chemistryField({ molecules: [mol], atoms: [atom], gravity: 2, edgeRadius: 50 }, { G_S: .02 });
  const points = Array.from({ length: 50 }, (_, i) => ({ x: 12 + (i * 17 % 101), y: 7 + i % 5, z: 5 + i * 13 % 71 }));
  assertGradient(astro, points);
  assertGradient(molecular, points.map((p, i) => ({ ...p, x: 12 + i * 17 % 50, z: 5 + i * 13 % 40 })));
  assertGradient(molecular, [{ x: 4, y: 5, z: 0 }, { x: 6, y: 5, z: 0 }]);
});

test('signed slice curvature agrees with grid nodes and excludes dispersion', () => {
  const astro = gravityField([body()]);
  const grid = astro.sampleGrid(300, 61);
  const centerIndex = 30 * 61 + 30;
  assert(grid.curvature[centerIndex] > 0);
  assert(astro.curvature({ x: 150, z: 0 }) < 0);
  assert(Math.abs(astro.curvature({ x: 1e6, z: 0 })) < 1e-9);
  close(grid.heights[centerIndex], -C.H_SPACE_MAX);
  for (const [row, col] of [[0, 0], [10, 33], [30, 30], [60, 60]]) {
    close(grid.curvature[row * 61 + col], astro.curvature({ x: -300 + col * 10, z: -300 + row * 10 }), 1e-6);
  }
  const root = molecule('.', 1e9, 100);
  const lone = chemistryField({ molecules: [root], atoms: [{ id: 'a', atomicMass: 10000, radius: 1, position: { x: 0, y: 3, z: 0 } }] });
  assert.equal(deriveSurfaceConstants([root]).G_S, 0);
  assert(lone.sampleGrid(40, 9).heights.every((n) => n === 0));
  assert.equal(lone.cohesionPotential({ x: 4, z: 0 }), 0);
  assert(lone.potential({ x: 4, y: 3, z: 0 }) < 0);
  assert.equal(lone.curvature({ x: 4, z: 0 }), 0);
  const child = molecule(), mfield = chemistryField({ molecules: [root, child] });
  const mgrid = mfield.sampleGrid(60, 31);
  close(mgrid.curvature[15 * 31 + 15], mfield.curvature({ x: 0, z: 0 }), 1e-6);
  close(mgrid.heights[15 * 31 + 15], -C.H_SURFACE_MAX);
  const blended = interpolate(mgrid, { ...mgrid, heights: mgrid.heights.map((n) => n * 2) }, .5);
  close(blended.heights[15 * 31 + 15], -C.H_SURFACE_MAX * 1.5);
});

test('surface cohesion attracts, finite force-shifted dispersion ends continuously, temperature and damping stay local', () => {
  const root = molecule('.', 1e9, 500), child = molecule();
  const calibrated = chemistryField({ molecules: [root, child], edgeRadius: 1000 });
  close(magnitude(calibrated.acceleration({ x: 40, y: 5, z: 0 })), C.A_MOL);
  assert(calibrated.potential({ x: 0, y: 5, z: 0 }) < calibrated.potential({ x: 20, y: 5, z: 0 }));
  assert(calibrated.acceleration({ x: 1, y: 5, z: 0 }).x < 0);
  const atom = { id: 'a', radius: 1, atomicMass: 1024, xi: 0, position: { x: 0, y: 0, z: 0 } };
  const cool = chemistryField({ molecules: [], atoms: [atom] });
  const hot = chemistryField({ molecules: [], atoms: [{ ...atom, xi: 1 }] });
  close(hot.potential({ x: 4, y: 0, z: 0 }), 2 * cool.potential({ x: 4, y: 0, z: 0 }));
  const cutoff = 3 * (atom.radius + C.SHIP_RADIUS);
  assert.equal(cool.potential({ x: cutoff, y: 0, z: 0 }), 0);
  assert(Math.abs(cool.potential({ x: cutoff - 1e-5, y: 0, z: 0 })) < 1e-8);
  assert(magnitude(cool.acceleration({ x: cutoff - 1e-5, y: 0, z: 0 })) < 1e-6);
  assert(Number.isFinite(cool.potential({ x: 0, y: 0, z: 0 })));
  assert.deepEqual(cool.acceleration({ x: 0, y: 0, z: 0 }), { x: 0, y: 0, z: 0 });
  const bonds = Array.from({ length: 9 }, () => ({ from: { x: -5, y: 3, z: 0 }, to: { x: 5, y: 3, z: 0 } }));
  const dense = chemistryField({ molecules: [{ ...child, temperature: 1 }], bonds });
  const p = { x: 0, y: 3, z: 0 };
  assert.equal(dense.damping(p), C.DAMPING_FREE + C.DAMP_BOND);
  assert.equal(dense.damping({ x: 1000, y: 3, z: 0 }), C.DAMPING_FREE);
  assert.deepEqual(dense.buffet(p, 5), dense.buffet(p, 5));
  close(magnitude(dense.buffet(p, 5)), C.BUFFET_K);
  assert.deepEqual(dense.buffet({ x: 40, y: 3, z: 0 }, 5), { x: 0, y: 0, z: 0 });
  assert.deepEqual(calibrated.buffet(p, 5), { x: 0, y: 0, z: 0 });
  close(surfaceGravity(body('light', 1000, 10), 1), magnitude(gravityField([body('light', 1000, 10)], { G: 1 }).acceleration({ x: 10, y: 0, z: 0 })));
});

test('warmed default-size grids meet the Node sampling budget', () => {
  const bodies = Array.from({ length: 64 }, (_, i) => body(String(i), 1e6, 30, { x: i % 8 * 150, y: 0, z: Math.floor(i / 8) * 150 }));
  const molecules = Array.from({ length: 200 }, (_, i) => molecule(String(i), 5000, 20, { x: i % 20 * 50, y: 0, z: Math.floor(i / 20) * 50 }));
  const atoms = Array.from({ length: 2500 }, (_, i) => ({ id: String(i), radius: 1, atomicMass: 100, position: { x: i % 50 * 10, y: 3, z: Math.floor(i / 50) * 10 } }));
  for (const [field, limit] of [[gravityField(bodies), 5], [chemistryField({ molecules, atoms }), 8]]) {
    for (let i = 0; i < 12; i++) field.sampleGrid(1500);
    const timings = Array.from({ length: 15 }, () => { const before = performance.now(); field.sampleGrid(1500); return performance.now() - before; }).sort((a, b) => a - b);
    assert(timings[7] < limit, `${field.kind} median ${timings[7].toFixed(2)} ms exceeds ${limit} ms`);
  }
});
