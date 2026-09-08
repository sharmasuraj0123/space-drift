/** Coalesced, cancellable payload loads. Cache lifetime and network freshness are separate. */
export function createPlanetLoader({ read, clock = Date.now, freshMs = 5000, cacheMs = 60000, timeoutMs = 10000, retries = 1 } = {}) {
  const cache = new Map(), pending = new Map();
  let generation = 0;
  function peek(id) {
    const entry = cache.get(id);
    if (!entry || clock() - entry.at > cacheMs) { cache.delete(id); return null; }
    return entry.payload;
  }
  function load(id, { fresh = false } = {}) {
    const entry = cache.get(id);
    if (peek(id) && (!fresh || clock() - entry.at < freshMs)) return Promise.resolve(entry.payload);
    if (pending.has(id)) return pending.get(id).promise;
    const token = generation, controller = new AbortController();
    const promise = (async () => {
      let lastError;
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (controller.signal.aborted || token !== generation) throw new DOMException('Obsolete load', 'AbortError');
        const request = new AbortController();
        const abort = () => request.abort(); controller.signal.addEventListener('abort', abort, { once: true });
        let timer;
        try {
          const payload = await Promise.race([
            read(id, { signal: request.signal }),
            new Promise((_, reject) => {
              request.signal.addEventListener('abort', () => reject(new DOMException('Payload load cancelled', 'AbortError')), { once: true });
              timer = setTimeout(() => request.abort(), timeoutMs);
            }),
          ]);
          if (token !== generation || controller.signal.aborted) throw new DOMException('Obsolete load', 'AbortError');
          if (!payload || payload.id !== id || !Array.isArray(payload.atoms)) throw new Error('The body returned an invalid survey.');
          cache.set(id, { payload, at: clock() });
          return payload;
        } catch (error) { lastError = error; }
        finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); }
      }
      throw lastError;
    })().finally(() => { if (pending.get(id)?.promise === promise) pending.delete(id); });
    pending.set(id, { promise, controller }); return promise;
  }
  return { load, peek, get payloads() { return [...cache.keys()].map(peek).filter(Boolean); },
    prune(ids) { const alive = new Set(ids); for (const [id, entry] of cache) if (!alive.has(id) || clock() - entry.at > cacheMs) cache.delete(id); for (const [id, entry] of pending) if (!alive.has(id)) { entry.controller.abort(); pending.delete(id); } },
    dispose() { generation++; for (const entry of pending.values()) entry.controller.abort(); pending.clear(); cache.clear(); },
  };
}
