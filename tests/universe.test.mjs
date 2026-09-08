import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSurveyUniverse } from '../public/universe-reader.js';
import { createUniverseReader } from '../lib/universe.mjs';
import { finalizeDiscovery, groupIntoMolecules, aggregateBody, replayLedger, snapshotExcitations } from '../public/universe-core.js';
import { HALF_LIFE_MS } from '../public/constants.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));
function snapshot(files, at = 1000, complete = true) {
  const records = new Map(files.map(([name, size]) => {
    const file = { id: name, path: name, name: name.split('/').at(-1), size, modifiedAt: new Date(at).toISOString() };
    return [name, { file, mtimeMs: at, identity: `identity:${name}`, ctimeMs: at }];
  }));
  return { world: { files: [...records.values()].map((r) => r.file), scannedAt: new Date(at).toISOString(), truncated: !complete, omitted: 0, unreadable: 0 }, records, complete, directories: ['.'], repoDirectories: [] };
}
const topology = (names) => finalizeDiscovery({ rootName: 'fixture', repositories: names.map((name) => ({ path: name, marker: 'dir' })) });

test('initial space is pending; slow surveys and Git never block cached space, coalesced surveys respect concurrency', async (t) => {
  let running = 0; let peak = 0; let scans = 0; const release = [];
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, live: false, options: { surveyConcurrency: 2 },
    discover: async () => topology(['a', 'b', 'c']),
    scanBody: (body) => { scans += 1; running += 1; peak = Math.max(peak, running); return new Promise((resolve) => release.push(() => { running -= 1; resolve(snapshot([[body.id + '.txt', 10]])); })); },
    readGit: () => new Promise(() => {}),
  }); t.after(() => universe.dispose());
  const initial = await universe.readSpace(); assert.equal(scans, 0); assert.ok(initial.bodies.every((b) => b.survey.pending && b.restMass === 0));
  const a = universe.readPlanet('a'); const same = universe.readPlanet('a'); await flush(); assert.equal(scans, 1);
  const b = universe.readPlanet('b'); const c = universe.readPlanet('c'); await flush();
  assert.equal(peak, 2); assert.equal((await universe.readSpace()).bodies.length, 4);
  release.shift()(); await a; await same; await flush();
  while (release.length) { release.shift()(); await flush(); }
  await b; await c;
  assert.equal(peak, 2); assert.equal((await universe.readPlanet('a')).restMass, 10);
  assert.equal((await universe.readSpace()).bodies.find((body) => body.id === 'a').survey.pending, false);
});

test('active bodies refresh each tick, events stay scoped, search does not scan and discovery removes old indexes', async (t) => {
  let now = 1000; let scans = 0; let names = ['a', 'b']; const versions = new Map();
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 },
    discover: async () => topology(names),
    scanBody: async (body) => { scans += 1; return snapshot([[`${body.id}.txt`, versions.get(body.id) || 10]], now); },
  }); t.after(() => universe.dispose());
  await universe.readPlanet('a'); await universe.readPlanet('b');
  now += 6000; versions.set('a', 15); await universe.tick();
  const updated = await universe.readPlanet('a');
  assert.ok(updated.events.some((e) => e.type === 'modified' && e.planetId === 'a' && e.path === 'a.txt'));
  assert.ok(updated.atoms[0].excitation > 0); assert.equal(updated.atoms[0].rho, .5);
  const beforeSearch = scans; assert.equal(universe.search('A.TXT')[0].id, 'a/a.txt'); assert.equal(scans, beforeSearch);
  now += 61000; await universe.tick(); const beforeIdleSearch = scans;
  assert.ok(universe.search('a.txt').length); assert.equal(scans, beforeIdleSearch);
  names = ['b']; now += 31000; await universe.tick();
  assert.ok(!universe.planets().some((body) => body.id === 'a')); assert.deepEqual(universe.search('a.txt'), []);
  await assert.rejects(universe.readPlanet('a'), { status: 404 });
});

test('ledger caps at excitation time, handles relative edits and preserves additive mass and excitation across hierarchy', () => {
  for (const [lines, delta, rho] of [[20, 10, .5], [10000, 10, .001], [20, 30, 1]]) assert.equal(replayLedger({ atomicMass: 100, lines }, [{ at: 1000, delta }], 1000).rho, rho);
  const capped = replayLedger({ atomicMass: 100, lines: 20 }, [{ at: 1000, delta: 100 }, { at: 1000, delta: 100 }], 1000 + HALF_LIFE_MS);
  assert.equal(capped.excitation, 50);
  const separate = replayLedger({ atomicMass: 100, lines: 100 }, [{ at: 1000, delta: 10 }, { at: 1000 + HALF_LIFE_MS, delta: 10 }], 1000 + 2 * HALF_LIFE_MS);
  assert.equal(separate.excitation, 7.5);
  const estimates = snapshotExcitations([{ type: 'modified', path: 'a', beforeSize: 100, afterSize: 100 }, { type: 'created', path: 'b', afterSize: 200 }, { type: 'deleted', path: 'c' }]);
  assert.equal(estimates[0].rho, .05); assert.equal(estimates[1].rho, 1); assert.equal(estimates[2].cooling, true);
  for (const now of [1000, 1000 + HALF_LIFE_MS, 1000 + 2 * HALF_LIFE_MS]) {
    const files = [['root.txt', 100], ['lib/a.js', 200], ['lib/nested/b.js', 300]].map(([path, size]) => ({ path, id: `repo/${path}`, size, ...replayLedger({ atomicMass: size, lines: 20 }, [{ at: 1000, delta: 10 }], now) }));
    const { atoms, molecules } = groupIntoMolecules(files, [{ path: 'lib/nested', marker: 'file' }], { at: now });
    const aggregate = aggregateBody(molecules, atoms);
    assert.equal(aggregate.restMass, 600); assert.equal(aggregate.excitation, atoms.reduce((n, a) => n + a.excitation, 0));
    assert.equal(molecules.find((m) => m.id === 'lib').molecularMass, 500);
    assert.equal(molecules.find((m) => m.id === 'lib').atomCount, 2);
    assert.deepEqual(molecules.find((m) => m.id === 'lib').elements, { source: 2 });
    assert.equal(molecules[0].atomCount, 3);
    assert.equal(molecules.find((m) => m.id === 'lib/nested').worktree, true);
    assert.deepEqual(molecules[0].atomIds, ['repo/root.txt']);
  }
  const existing = replayLedger({ atomicMass: 100, excitation: 150, excitationAt: 1000 }, [], 1000 + HALF_LIFE_MS);
  assert.equal(existing.excitation, 75);
  const preserved = groupIntoMolecules([{ path: 'a.js', atomicMass: 100, excitation: 150 }]);
  assert.equal(preserved.atoms[0].excitation, 150); assert.equal(preserved.molecules[0].excitation, 150);
  assert.equal(replayLedger({ atomicMass: 100, excitation: 150, excitationAt: 1000 }, [{ at: 1000, delta: 0 }], 1000).excitation, 100);
});

test('nested Git readers own only their atoms and belt root Git cannot claim planet atoms', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-git-scope-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const folder of ['', 'planet', 'planet/nested']) { await mkdir(path.join(root, folder, '.git'), { recursive: true }); await writeFile(path.join(root, folder, 'atom.js'), '1234567890'); }
  const calls = [];
  const reader = async (directory, { metadata, now }) => {
    calls.push({ directory, paths: [...metadata.keys()] });
    const files = new Map([...metadata.keys()].map((key) => [key, { status: 'clean', excitations: [{ at: now, delta: 1 }], lastCommitAt: now }]));
    return { ok: true, head: 'fixture', branch: 'main', lines: new Map([...metadata.keys()].map((key) => [key, 2])), tracked: new Set(metadata.keys()), files, collectedAt: now };
  };
  const universe = createUniverseReader(root, { readRepoChurn: reader, now: () => 1000 }); t.after(() => universe.dispose());
  await universe.readPlanet('planet'); await universe.readPlanet('__belt__');
  for (let i = 0; i < 10; i += 1) await flush();
  assert.deepEqual(calls.find((c) => c.directory === root).paths, ['atom.js']);
  assert.deepEqual(calls.find((c) => c.directory === path.join(root, 'planet')).paths, ['atom.js']);
  assert.deepEqual(calls.find((c) => c.directory === path.join(root, 'planet/nested')).paths, ['atom.js']);
  const planet = await universe.readPlanet('planet'); const belt = await universe.readPlanet('__belt__');
  assert.equal(planet.excitation, 10); assert.equal(belt.excitation, 5); assert.equal(planet.git.enabled, true);
  assert.equal((await universe.readSpace()).bodies.find((b) => b.id === 'planet').excitation, planet.atoms.reduce((n, a) => n + a.excitation, 0));
});

test('Git cache runs independently at most twice in flight and refreshes only after 15 seconds', async (t) => {
  let now = 1000; let active = 0; let peak = 0; const calls = []; const release = [];
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 },
    discover: async () => topology(['a', 'b', 'c']), scanBody: async (body) => snapshot([[`${body.id}.txt`, 10]], now),
    readGit: (body) => { calls.push(body.id); active += 1; peak = Math.max(peak, active); return new Promise((resolve) => release.push(() => { active -= 1; resolve({ ok: false, reason: 'fixture' }); })); },
  }); t.after(() => universe.dispose());
  await Promise.all(['a', 'b', 'c'].map((id) => universe.readPlanet(id))); await flush();
  assert.equal(peak, 2); assert.equal(calls.length, 2);
  while (release.length) { release.shift()(); await flush(); }
  const initialA = calls.filter((id) => id === 'a').length;
  now = 7000; await universe.readPlanet('a'); await flush(); assert.equal(calls.filter((id) => id === 'a').length, initialA);
  now = 17000; await universe.readPlanet('a'); await flush(); assert.equal(calls.filter((id) => id === 'a').length, initialA + 1);
  while (release.length) { release.shift()(); await flush(); }
});

test('idle payload eviction retains the bounded no-scan index and reassembles a fresh snapshot', async (t) => {
  let now = 1000; let scans = 0;
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 },
    discover: async () => topology([]), scanBody: async () => { scans += 1; return snapshot(Array.from({ length: 90 }, (_, i) => [`FILE-${i}.txt`, 1]), now); },
  }); t.after(() => universe.dispose());
  const first = await universe.readPlanet('__belt__');
  now += 1000; assert.equal(await universe.readPlanet('__belt__'), first); assert.equal(scans, 1);
  now += 61000; await universe.tick(); const before = scans;
  assert.equal(universe.search('file').length, 60); assert.equal(universe.search('file', 1000).length, 60); assert.equal(scans, before);
  assert.equal(universe.mappedAtoms().files.length, 90);
  const rebuilt = await universe.readPlanet('__belt__'); assert.notEqual(rebuilt, first); assert.equal(rebuilt.atoms.length, 90); assert.equal(scans, before);
});

test('ownership changes invalidate an old belt generation before a late survey can republish it', async (t) => {
  let now = 1000; let discovered = topology([]); let release;
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 },
    discover: async () => discovered,
    scanBody: (body) => body.kind === 'belt' && !discovered.planets.length ? new Promise((resolve) => { release = () => resolve(snapshot([['new-repo/file.txt', 10]], now)); }) : Promise.resolve(snapshot(body.kind === 'belt' ? [] : [['file.txt', 10]], now)),
  }); t.after(() => universe.dispose());
  const stale = universe.readPlanet('__belt__'); stale.catch(() => {}); await flush();
  discovered = topology(['new-repo']); now += 31000;
  await universe.readSpace(); await flush();
  await assert.rejects(stale, { status: 404 }); release(); await flush();
  const planet = await universe.readPlanet('new-repo'); assert.equal(planet.atoms[0].id, 'new-repo/file.txt');
  assert.deepEqual(universe.search('file').map((a) => a.planetId), ['new-repo']);
});

test('incomplete discovery preserves previously known unobserved bodies until a complete walk proves removal', async (t) => {
  let now = 1000; let found = topology(['a', 'b']);
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 },
    discover: async () => found, scanBody: async (body) => snapshot([[`${body.id}.txt`, 10]], now),
  }); t.after(() => universe.dispose());
  await universe.readPlanet('b');
  found = { ...topology(['a']), incomplete: true, truncated: true }; now += 31000; await universe.tick();
  assert.ok(universe.planets().some((b) => b.id === 'b')); assert.ok(universe.search('b.txt').length);
  found = topology(['a']); now += 31000; await universe.tick();
  assert.ok(!universe.planets().some((b) => b.id === 'b')); assert.deepEqual(universe.search('b.txt'), []);
});

test('a Git-observed dirty version is not excited twice when the next metadata survey observes the same edit', async (t) => {
  let now = 5000; let first = true;
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 }, discover: async () => topology([]),
    scanBody: async () => { const value = first ? snapshot([['a.js', 100]], 1000) : snapshot([['a.js', 110]], 2000); first = false; return value; },
    readGit: async () => ({ ok: true, lines: new Map([['a.js', 20]]), files: new Map([['a.js', { status: 'modified', observation: { mtimeMs: 2000, ctimeMs: 2000, size: 110 }, excitations: [{ at: 2000, delta: 5 }] }]]) }),
  }); t.after(() => universe.dispose());
  await universe.readPlanet('__belt__'); await flush();
  now = 11000; const body = await universe.readPlanet('__belt__');
  const expected = replayLedger({ atomicMass: 110, lines: 20 }, [{ at: 2000, delta: 5 }], now);
  assert.equal(body.atoms[0].excitation, expected.excitation); assert.equal(body.atoms[0].rho, .25);
  assert.equal(body.events[0].type, 'modified');
});

test('deleted atoms leave mass, excitation and eligibility immediately; recreation starts a new observed atom', async (t) => {
  let now = 1000; let files = [['a.txt', 100]];
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, now: () => now, options: { tickMs: 1e8 }, discover: async () => topology([]), scanBody: async () => snapshot(files, now) }); t.after(() => universe.dispose());
  await universe.readPlanet('__belt__'); now += 6000; const warm = await universe.readPlanet('__belt__'); assert.ok(warm.excitation > 0);
  files = []; now += 6000; const gone = await universe.readPlanet('__belt__');
  assert.equal(gone.restMass, 0); assert.equal(gone.excitation, 0); assert.deepEqual(universe.search('a.txt'), []); assert.deepEqual(universe.mappedAtoms().files, []);
  assert.equal(gone.events[0].type, 'deleted'); assert.equal(gone.events[0].path, 'a.txt');
  files = [['a.txt', 20]]; now += 6000; const recreated = await universe.readPlanet('__belt__');
  assert.equal(recreated.restMass, 20); assert.equal(recreated.excitation, 20); assert.equal(recreated.events[0].type, 'created');
  assert.deepEqual(universe.mappedAtoms().files.map((file) => [file.path, file.size]), [['a.txt', 20]]);
});

test('nested Git enrichment caps at eight repositories while remaining mapped files use fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'space-nested-git-cap-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.git')); await writeFile(path.join(root, 'root.js'), '1234');
  for (let i = 0; i < 10; i += 1) { await mkdir(path.join(root, `nested-${i}/.git`), { recursive: true }); await writeFile(path.join(root, `nested-${i}/a.js`), '1234'); }
  const calls = [];
  const universe = createUniverseReader(root, { discoveryOptions: { depth: 0 }, readRepoChurn: async (directory, { metadata, now }) => {
    calls.push(directory); return { ok: true, head: 'fixture', branch: 'main', lines: new Map([...metadata.keys()].map((key) => [key, 2])), tracked: new Set(metadata.keys()), files: new Map([...metadata.keys()].map((key) => [key, { status: 'clean', excitations: [{ at: now, delta: 1 }] }])), collectedAt: now };
  } }); t.after(() => universe.dispose());
  await universe.readPlanet('.'); for (let i = 0; i < 20; i += 1) await flush();
  const body = await universe.readPlanet('.'); assert.equal(calls.length, 9); assert.equal(body.atoms.length, 11); assert.equal(body.atoms.filter((atom) => !atom.linesExact).length, 2); assert.equal(body.git.partial, true);
});

test('an active request promotes its queued survey and a background pass stops waiting at its deadline', async (t) => {
  const starts = []; const release = [];
  const universe = createSurveyUniverse({ root: { name: 'fixture' }, options: { surveyConcurrency: 1, tickBudgetMs: 10, tickMs: 1e8 }, discover: async () => topology(['a', 'b', 'c']),
    scanBody: (body) => { starts.push(body.id); return new Promise((resolve) => release.push(() => resolve(snapshot([[`${body.id}.txt`, 10]])))); },
  }); t.after(() => universe.dispose());
  await universe.readSpace(); await new Promise((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(starts, ['a']);
  const active = universe.readPlanet('c'); await flush(); release.shift()(); await flush(); assert.deepEqual(starts, ['a', 'c']);
  release.shift()(); await active; await flush();
  const before = Date.now(); const pending = await universe.tick(); assert.ok(Date.now() - before < 200); assert.ok(pending.bodies.some((body) => body.survey.pending));
  while (release.length) { release.shift()(); await flush(); }
});
