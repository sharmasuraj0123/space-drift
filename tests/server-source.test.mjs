import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerSource } from '../public/server-source.js';

test('server transport uses a browser-safe root query and shares source cancellation', async () => {
  const routes = []; const source = createServerSource({ fetch: async (url, options) => {
    routes.push({ url, options }); if (options.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    return { ok: true, json: async () => url.startsWith('/api/search') ? { results: [{ id: 'repo/a.js' }] } : { layer: 'space' } };
  } });
  await source.readPlanet('.'); assert.equal(routes.at(-1).url, '/api/planet?id=.');
  await source.readPlanet('group/repo'); assert.equal(routes.at(-1).url, '/api/planet?id=group%2Frepo');
  assert.deepEqual(await source.search('a&b'), [{ id: 'repo/a.js' }]); assert.match(routes.at(-1).url, /q=a%26b/);
  source.dispose(); await assert.rejects(source.readSpace(), { name: 'AbortError' });
});
