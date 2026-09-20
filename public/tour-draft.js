import { validateTour, resolveTour, exportTour } from './tours.js';

export const MAX_TOUR_BYTES = 1024 * 1024;

export function createTourDraft(tour) {
  return tour ? JSON.parse(exportTour(tour)) : { id: 'my-tour', title: 'My tour', description: '', stops: [] };
}

export function importTourDraft(json, defaultPlanet = null) {
  if (new TextEncoder().encode(json).length > MAX_TOUR_BYTES) return { tour: null, error: 'Tour JSON must be no larger than 1 MB.' };
  try {
    const result = validateTour(JSON.parse(json), { defaultPlanet });
    return result.error ? result : { tour: createTourDraft(result.tour), error: null };
  } catch {
    return { tour: null, error: 'Invalid tour JSON. Choose a JSON tour definition.' };
  }
}

export function exportTourDraft(draft) {
  const result = validateTour(draft);
  if (result.error) return { json: null, error: result.error };
  const json = exportTour(result.tour);
  // readWorkspaceMetadata accepts at most 128 KiB per definition.
  if (new TextEncoder().encode(json).length > 131072) return { json: null, error: 'The tour loader accepts up to 128 KiB per tour. Shorten explanations or remove stops before exporting.' };
  return { json, error: null };
}

/** Read only destination metadata; search results are capped and cannot validate a route. */
export async function validateTourDraft(draft, { bodies = [], loadPlanet } = {}) {
  const result = validateTour(draft, { sourceId: 'draft' });
  if (result.error) return result;
  const tour = result.tour;
  const unscoped = tour.stops.some((stop) => stop.planet == null);
  const needed = bodies.filter((body) => unscoped || tour.stops.some((stop) => stop.planet === body.id));
  const payloads = [], unavailable = new Set();
  for (const body of needed) {
    try {
      const payload = await loadPlanet(body.id);
      payloads.push(payload);
    } catch {
      unavailable.add(body.id);
    }
  }
  const resolved = resolveTour(tour, bodies.map((body) => ({ ...body, molecules: payloads.find((p) => p.id === body.id)?.molecules || [] })),
    payloads.flatMap((payload) => payload.atoms.map((atom) => ({ ...atom, planetId: payload.id }))));
  resolved.stops = resolved.stops.map((stop) => {
    let reason = '';
    if (unavailable.has(stop.planet)) reason = 'This body could not be surveyed. Reconnect or retry validation.';
    else if (!bodies.some((body) => body.id === stop.planet)) reason = stop.planet == null
      ? 'No body could be resolved. For a body-relative tour, select its body when importing.'
      : 'This body is not in the connected workspace.';
    else if (stop.missing) reason = `This ${stop.path != null ? 'file' : 'folder'} is not mapped. It may be missing, excluded, or outside the completed survey.`;
    return { ...stop, missing: !!reason, reason };
  });
  return { tour: resolved, error: null };
}
