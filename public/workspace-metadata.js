/** Explicit, bounded metadata reads for tours; ordinary map scans never call this. */
export async function readWorkspaceMetadata(bodies, { list, read, signal }) {
  const definitions = []; const errors = []; const entryPoints = {};
  const scopes = [{ id: null, path: '' }, ...bodies.filter((body) => body.kind === 'planet' && body.path)];
  let bytes = 0; let attempted = 0;
  const join = (scope, file) => scope ? `${scope}/${file}` : file;
  for (const scope of scopes) {
    if (signal?.aborted) throw Object.assign(new Error('Disconnected workspace.'), { name: 'AbortError' });
    const directory = join(scope.path, '.space/tours');
    let names;
    try { names = await list(directory, signal); } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && error.name !== 'NotFoundError') errors.push({ id: directory, error: 'Tour metadata directory is unavailable or exceeded its time limit.' });
      names = [];
    }
    if (names.truncated) errors.push({ id: directory, error: 'Tour directory listing limit reached; some definitions were omitted.' });
    for (const name of names.sort()) {
      if (!/^[^./\\\0][^/\\\0]*\.json$/i.test(name)) continue;
      const id = `${directory}/${name}`;
      if (attempted >= 32 || bytes >= 1048576) { errors.push({ id, error: 'Tour metadata limit reached.' }); break; }
      attempted += 1;
      try {
        const result = await read(id, Math.min(131072, 1048576 - bytes), signal);
        bytes += result.size;
        definitions.push({ id, planet: scope.id || (bodies.length === 1 ? bodies[0].id : null), value: JSON.parse(result.text) });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        errors.push({ id, error: error instanceof SyntaxError ? 'Invalid tour JSON.' : 'Tour metadata is unavailable or too large.' });
      }
    }
    const body = bodies.find((candidate) => candidate.path === scope.path && candidate.kind === 'planet');
    if (!body || bytes >= 1048576) continue;
    try {
      const result = await read(join(scope.path, 'package.json'), Math.min(131072, 1048576 - bytes), signal);
      bytes += result.size;
      const manifest = JSON.parse(result.text);
      const candidates = [manifest.main];
      // Extract filename tokens only. Shell expressions are neither evaluated nor followed.
      if (typeof manifest.scripts?.start === 'string') candidates.push(...[...manifest.scripts.start.matchAll(/(?:^|\s)(?:["']?)([\w@./-]+\.(?:[cm]?js|tsx?|jsx))(?:["']?)(?=\s|$)/g)].map((match) => match[1]));
      entryPoints[body.id] = [...new Set(candidates.filter((value) => typeof value === 'string').map((value) => value.replace(/^\.\//, '')).filter((value) => value && value.length < 1024 && value.split('/').every((part) => part && !part.startsWith('.') && !/[\\\0:]/.test(part))))].slice(0, 8);
    } catch (error) { if (error.name === 'AbortError') throw error; }
  }
  return { definitions, errors, entryPoints };
}
