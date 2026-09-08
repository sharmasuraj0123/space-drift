const safePath = (path) => typeof path === 'string' && path.length > 0 && path.length <= 2048 && path.split('/').every((p) => p && !p.startsWith('.') && !/[\0\\]/.test(p));
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const join = (body, path) => body?.path ? `${body.path}/${path}` : path;

export function validateTour(input, { defaultPlanet = null, sourceId = '', scopeId = '' } = {}) {
  const fail = (error) => ({ tour: null, error });
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('A tour must be a JSON object.');
  if (typeof input.id !== 'string' || !/^[\w.-]{1,80}$/.test(input.id)) return fail('A tour needs a short id using letters, numbers, dots, dashes or underscores.');
  if (!Array.isArray(input.stops) || !input.stops.length || input.stops.length > 64) return fail('A tour needs between 1 and 64 stops.');
  const stops = [];
  for (const [index, raw] of input.stops.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(`Stop ${index + 1} must be an object.`);
    const planet = raw.planet ?? defaultPlanet;
    if (planet != null && (typeof planet !== 'string' || !planet || planet.length > 2048 || /[\0\\]/.test(planet) || planet.split('/').includes('..'))) return fail(`Stop ${index + 1} has an invalid body id.`);
    const molecule = raw.molecule ?? raw.sector;
    if (raw.path != null && !safePath(raw.path)) return fail(`Stop ${index + 1} has an unsafe file path.`);
    if (molecule != null && molecule !== '.' && !safePath(molecule)) return fail(`Stop ${index + 1} has an unsafe molecule path.`);
    if (raw.path != null && molecule != null) return fail(`Stop ${index + 1} must choose a file or a molecule.`);
    if (planet == null && raw.path == null && molecule == null) return fail(`Stop ${index + 1} has no destination.`);
    if (raw.open != null && typeof raw.open !== 'boolean') return fail(`Stop ${index + 1} open must be true or false.`);
    if (raw.dwellSeconds != null && (!Number.isFinite(raw.dwellSeconds) || raw.dwellSeconds < 0 || raw.dwellSeconds > 120)) return fail(`Stop ${index + 1} dwell must be between 0 and 120 seconds.`);
    stops.push({ planet, ...(raw.path != null ? { path: raw.path } : {}), ...(molecule != null ? { molecule } : {}), note: text(raw.note, 2000), open: raw.path != null && raw.open !== false, dwellSeconds: raw.dwellSeconds ?? 2 });
  }
  return { tour: { id: input.id, key: `${sourceId || scopeId || defaultPlanet || 'root'}:${input.id}`, title: text(input.title, 160) || input.id, description: text(input.description, 1000), planet: defaultPlanet, stops }, error: null };
}

export function resolveTour(tour, bodies = [], index = []) {
  const atoms = index instanceof Map ? [...index.values()] : Array.isArray(index) ? index : [];
  return { ...tour, stops: tour.stops.map((stop) => {
    let body = bodies.find((b) => b.id === stop.planet);
    if (!body && stop.planet == null && bodies.length === 1) body = bodies[0];
    if (!body && stop.planet == null && stop.path) {
      const found = atoms.find((a) => a.id === stop.path);
      if (found) body = bodies.find((b) => b.id === found.planetId);
    }
    if (!body) return { ...stop, missing: true, kind: stop.path ? 'atom' : stop.molecule ? 'molecule' : 'body', id: stop.path || stop.molecule || stop.planet };
    const bodyAtoms = atoms.filter((a) => a.planetId === body.id);
    if (stop.path) {
      const canonical = join(body, stop.path);
      const atom = bodyAtoms.find((a) => a.id === canonical || (stop.planet == null && a.id === stop.path));
      return { ...stop, planet: body.id, path: atom?.path || stop.path, kind: 'atom', id: atom?.id || canonical, missing: !atom };
    }
    if (stop.molecule != null) {
      const exists = stop.molecule === '.' || body.molecules?.some((m) => m.id === stop.molecule) || bodyAtoms.some((a) => (a.path || a.id.slice(body.path ? body.path.length + 1 : 0)).startsWith(`${stop.molecule}/`));
      return { ...stop, planet: body.id, kind: 'molecule', id: stop.molecule, missing: !exists };
    }
    return { ...stop, planet: body.id, kind: 'body', id: body.id, missing: false };
  }) };
}

/** Deterministic system prefix plus a bounded body reading route, with no content fetching. */
export function generateOnboardingTour(space, payloads = []) {
  const bodies = (space?.bodies || []).filter((b) => !b.survey?.pending);
  if (!bodies.length) return null;
  const hottest = [...bodies].sort((a, b) => (b.excitation || 0) - (a.excitation || 0) || a.id.localeCompare(b.id));
  const heaviest = [...bodies].sort((a, b) => b.restMass - a.restMass || a.id.localeCompare(b.id));
  const payload = payloads.find((p) => p.id === hottest[0].id) || payloads.find((p) => p.atoms?.length) || payloads[0];
  const target = bodies.find((b) => b.id === payload?.id) || hottest[0];
  const stops = [];
  if (bodies.length > 1) {
    for (const body of heaviest.slice(0, 3)) stops.push({ planet: body.id, molecule: '.', note: `Land on ${body.name}. Its ${body.fileCount || 0} files give this body its mass.`, open: false, dwellSeconds: 2 });
    for (const body of hottest.slice(0, 2)) stops.push({ planet: body.id, note: `${body.name}: current activity makes a body heavier and brighter.`, open: false, dwellSeconds: 2 });
  }
  if (payload?.atoms?.length) {
    const atoms = [...payload.atoms].sort((a, b) => a.path.localeCompare(b.path));
    const local = [], chosen = new Set();
    const add = (atom) => {
      if (!atom || chosen.has(atom.id) || local.length >= 7) return;
      chosen.add(atom.id); local.push({ planet: target.id, path: atom.path, note: `Read ${atom.path}. This atom stays on your computer.`, open: true, dwellSeconds: 2 });
    };
    const addMolecule = (molecule, note) => { if (molecule && local.length < 7) local.push({ planet: target.id, molecule: molecule.id, note, open: false, dwellSeconds: 2 }); };
    for (const regex of [/^readme(?:\.|$)/i, /^project\.md$/i, /^plan\.md$/i, /^(agents|claude)\.md$/i, /^(package\.json|pyproject\.toml|go\.mod)$/i]) add(atoms.find((a) => regex.test(a.path)));
    const explicitEntry = (payload.entryPoints || []).map((entry) => atoms.find((a) => a.path === entry)).find(Boolean);
    add(explicitEntry || atoms.find((a) => /(^|\/)(main|index|app)\.(js|mjs|ts|tsx|py|go|rs)$/i.test(a.path)));
    const candidates = (payload.molecules || []).filter((m) => /^(src|lib|app|public)$/.test(m.path || m.id)).sort((a, b) => b.molecularMass - a.molecularMass || a.id.localeCompare(b.id));
    addMolecule(candidates[0], 'A molecule groups files and nested folders. Activity raises its temperature.');
    const tests = payload.molecules?.find((m) => /^tests?$/.test(m.path || m.id));
    if (tests?.id !== candidates[0]?.id) addMolecule(tests, 'Tests explain how this project checks its work.');
    // Two molecule stops leave room for five available files; sparse metadata
    // gets additional files without displacing the higher-priority entry point.
    for (const atom of atoms) { if (chosen.size >= 5) break; add(atom); }
    stops.push(...local);
  } else stops.push({ planet: target.id, molecule: '.', note: 'This body is still being surveyed. Explore its surface and return to the tour list as files arrive.', open: false, dwellSeconds: 2 });
  const validated = validateTour({ id: 'onboarding', title: 'Welcome aboard', description: 'Land on bodies, read your first atoms, and learn the map.', stops }, { sourceId: 'generated' }).tour;
  const index = payloads.flatMap((p) => (p.atoms || []).map((a) => ({ ...a, planetId: p.id })));
  return { ...resolveTour(validated, bodies, index), generated: true };
}

export function createTourState(tour) {
  if (!tour?.stops?.length) return null;
  return { id: tour.id, key: tour.key || tour.id, title: tour.title || tour.id, stops: tour.stops.map((s) => ({ ...s })), index: 0, status: 'travelling', elapsed: 0, visited: [], opened: [], skipped: [], distance: 0, pausedFrom: null };
}

/** Availability may change during flight; a started itinerary keeps its destinations. */
export function refreshTourState(state, definition) {
  if (!state || !definition || (definition.key || definition.id) !== state.key) return state;
  return { ...state, stops: state.stops.map((stop) => {
    const fresh = definition.stops.find((candidate) => candidate.planet === stop.planet && candidate.kind === stop.kind && candidate.id === stop.id);
    return fresh ? { ...stop, missing: !!fresh.missing, note: fresh.note } : { ...stop };
  }) };
}
function advance(state, index = state.index + 1) {
  if (index >= state.stops.length) return { ...state, index: state.stops.length, status: 'complete', elapsed: 0 };
  return { ...state, index: Math.max(0, index), status: 'travelling', elapsed: 0, pausedFrom: null };
}
export function tourReducer(state, event) {
  if (!state || !event) return state;
  if (event.type === 'exit') return null;
  if (event.type === 'restart') return createTourState(state);
  if (event.type === 'distance') return { ...state, distance: state.distance + Math.max(0, Number(event.distance) || 0) };
  if (event.type === 'skip') return advance({ ...state, skipped: [...new Set([...state.skipped, state.index])] }, state.index + (event.direction === -1 ? -1 : 1));
  if (event.type === 'steer' && !['paused', 'complete'].includes(state.status)) return { ...state, status: 'paused', pausedFrom: state.status };
  if (event.type === 'resume' && state.status === 'paused') return { ...state, status: 'travelling', elapsed: 0, pausedFrom: null };
  if (state.status === 'paused' || state.status === 'complete') return state;
  const stop = state.stops[state.index];
  if (!stop) return { ...state, status: 'complete' };
  if (event.type === 'missing') return advance({ ...state, skipped: [...new Set([...state.skipped, state.index])] });
  if (event.type === 'arrived' && state.status === 'travelling') return { ...state, status: stop.open ? 'opening' : 'dwelling', elapsed: 0, visited: [...new Set([...state.visited, state.index])] };
  if (event.type === 'opened' && state.status === 'opening') return { ...state, status: 'reading', opened: [...new Set([...state.opened, stop.id || `${stop.planet}/${stop.path}`])] };
  if (event.type === 'openFailed' && state.status === 'opening') return { ...state, status: 'paused', pausedFrom: 'opening' };
  if (event.type === 'viewerClosed' && state.status === 'reading') return advance(state);
  if (event.type === 'tick' && state.status === 'dwelling') {
    const elapsed = state.elapsed + Math.max(0, Number(event.dt) || 0);
    return elapsed >= stop.dwellSeconds ? advance(state) : { ...state, elapsed };
  }
  return state;
}

export function exportTour(state) {
  return JSON.stringify({ id: state.id || 'my-route', title: state.title || 'My route', stops: state.stops.map(({ planet, path, molecule, note, open, dwellSeconds }) => ({ planet, ...(path != null ? { path } : {}), ...(molecule != null ? { molecule } : {}), note: note || '', open: !!open, dwellSeconds: dwellSeconds ?? 2 })) }, null, 2);
}
