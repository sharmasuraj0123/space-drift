import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanetLoader } from '../public/planet-loader.js';

test('payload loads coalesce, retry once, retain takeoff cache, and refresh on demand', async () => {
  let calls = 0, now = 0;
  const loader = createPlanetLoader({ clock: () => now, read: async (id) => { if (++calls === 1) throw new Error('retry'); return { id, atoms: [], version: calls }; } });
  const first = loader.load('a'), second = loader.load('a'); assert.equal(first, second);
  assert.equal((await first).version, 2); assert.equal(calls, 2);
  now = 6000; assert.equal((await loader.load('a')).version, 2);
  assert.equal((await loader.load('a', { fresh: true })).version, 3);
  now = 70000; assert.equal(loader.peek('a'), null); loader.dispose();
});
test('failed surveys stop after one retry; disposal prevents stale responses from caching', async () => {
  let calls = 0;
  const failed = createPlanetLoader({ read: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(failed.load('a'), /offline/); assert.equal(calls, 2);
  let resolve;
  const stale = createPlanetLoader({ read: () => new Promise((r) => { resolve = r; }) });
  const loading = stale.load('a'); stale.dispose(); resolve({ id: 'a', atoms: [] });
  await assert.rejects(loading, { name: 'AbortError' }); assert.equal(stale.peek('a'), null);
});
test('a provider that ignores cancellation still times out and releases the pending load', async () => {
  const loader = createPlanetLoader({ read: () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(loader.load('a'), { name: 'AbortError' }); loader.dispose();
});
