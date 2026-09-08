/** The loopback API implements the same two-layer interface as browser folders. */
export function createServerSource({ baseUrl = '', name = 'Local workspace', fetch: fetcher = globalThis.fetch } = {}) {
  const lifetime = new AbortController();
  const request = async (route, { signal } = {}) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (lifetime.signal.aborted || signal?.aborted) controller.abort();
    lifetime.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetcher(`${baseUrl}${route}`, { signal: controller.signal, cache: 'no-store' });
      const value = await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || 'The workspace is unavailable.'), { status: response.status });
      return value;
    } finally { lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort); }
  };
  return {
    kind: 'server', name, live: true,
    readSpace: (options) => request('/api/world', options),
    readWorld: (options) => request('/api/world', options),
    readPlanet: (id, options) => request(`/api/planet?id=${encodeURIComponent(id)}`, options),
    search: async (query, limit = 60, options) => (await request(`/api/search?q=${encodeURIComponent(query)}&limit=${Math.min(60, Math.max(0, Number(limit) || 0))}`, options)).results,
    tours: (options) => request('/api/tours', options),
    dispose: () => lifetime.abort(),
  };
}
