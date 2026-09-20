import test from 'node:test';
import assert from 'node:assert/strict';
import { createTourDraft, importTourDraft, exportTourDraft, validateTourDraft } from '../public/tour-draft.js';
import { validateTour, exportTour, createTourState, tourReducer } from '../public/tours.js';

const bodies = [{ id: 'a', path: 'a', name: 'Alpha' }, { id: 'b', path: 'b', name: 'Beta' }];
const payloads = bodies.map((body) => ({ ...body, molecules: [{ id: '.' }, { id: 'src' }, { id: 'empty' }],
  atoms: Array.from({ length: 70 }, (_, i) => ({ id: `${body.id}/src/${i}.js`, path: `src/${i}.js` })) }));
const workspace = { bodies, loadPlanet: async (id) => payloads.find((p) => p.id === id) };

test('draft import/export keeps descriptions, annotations, destinations and playback options without runtime state', () => {
  const input = { id: 'guide', title: 'Read this first', description: 'An introduction', stops: [
    { path: 'src/69.js', title: 'Entry point', note: '<b>Plain text</b>', open: false, dwellSeconds: 7 },
    { sector: 'empty', title: 'Empty directory', dwellSeconds: 0 },
    { planet: 'b', title: 'Fly by Beta' },
  ] };
  const { tour, error } = importTourDraft(JSON.stringify(input), 'a');
  assert.equal(error, null);
  assert.equal(tour.stops[0].planet, 'a');
  assert.equal(tour.stops[0].title, 'Entry point');
  assert.equal(tour.stops[0].note, '<b>Plain text</b>');
  assert.equal(tour.stops[0].open, false);
  assert.equal(tour.stops[1].molecule, 'empty');
  assert.equal(tour.stops[1].dwellSeconds, 0);
  assert.equal(tour.stops[2].planet, 'b');
  const state = createTourState({ ...tour, stops: tour.stops.map((s) => ({ ...s, missing: true, reason: 'Not here' })) });
  const copy = createTourDraft(state);
  assert.equal(copy.description, input.description);
  assert.equal('missing' in copy.stops[0], false);
  assert.equal('reason' in copy.stops[0], false);
  copy.stops.reverse(); copy.stops[2].note = 'Changed';
  assert.equal(state.stops[0].note, '<b>Plain text</b>');
  assert.equal(validateTour(JSON.parse(exportTour(copy))).error, null);
  assert.deepEqual(createTourDraft(), { id: 'my-tour', title: 'My tour', description: '', stops: [] });
});

test('import rejects malformed, unsafe, oversized and invalid definitions without creating a draft', () => {
  for (const json of ['{', 'null', '[]', JSON.stringify({ id: 'bad', stops: [{ path: '../secret' }] }),
    JSON.stringify({ id: 'bad', stops: [{ planet: 'a', open: 'true' }] }),
    JSON.stringify({ id: 'bad', stops: Array(65).fill({ planet: 'a' }) })]) {
    const result = importTourDraft(json);
    assert.ok(result.error); assert.equal(result.tour, null);
  }
  assert.match(importTourDraft('é'.repeat(524289)).error, /1 MB/);
});

test('export honors the workspace loader byte limit and retains unresolved destinations', () => {
  const draft = { id: 'r', description: 'Keep this route', stops: [{ planet: 'gone', path: 'missing.md', title: 'Unavailable' }] };
  const result = exportTourDraft(draft);
  assert.equal(result.error, null);
  assert.equal(importTourDraft(result.json).tour.stops[0].planet, 'gone');
  assert.equal(JSON.parse(result.json).description, draft.description);
  assert.match(exportTourDraft({ id: 'r', stops: Array.from({ length: 64 }, () => ({ planet: 'a', note: 'é'.repeat(2000) })) }).error, /128 KiB/);
  assert.equal(exportTourDraft(createTourDraft()).json, null);
});

test('validation uses full body payloads, preserves empty folders and loads each referenced body once', async () => {
  const calls = [];
  const draft = { id: 'r', stops: [{ planet: 'a', path: 'src/69.js' }, { planet: 'a', molecule: 'empty' }, { planet: 'b' }] };
  const { tour, error } = await validateTourDraft(draft, { bodies, loadPlanet: async (id) => { calls.push(id); return workspace.loadPlanet(id); } });
  assert.equal(error, null);
  assert.deepEqual(calls, ['a', 'b']);
  assert.deepEqual(tour.stops.map((s) => [s.kind, s.id, s.missing]), [['atom', 'a/src/69.js', false], ['molecule', 'empty', false], ['body', 'b', false]]);
  assert.equal('missing' in draft.stops[0], false);
});

test('validation explains absent bodies, unmapped paths and failed surveys; preview skips unavailable stops', async () => {
  const draft = { id: 'r', stops: [{ planet: 'gone' }, { planet: 'a', path: 'lost.js' }, { planet: 'b', molecule: '.' }, { planet: 'a', molecule: 'src' }] };
  const { tour } = await validateTourDraft(draft, { bodies, loadPlanet: async (id) => {
    if (id === 'b') throw new Error('Permission lost');
    return payloads[0];
  } });
  assert.match(tour.stops[0].reason, /not in the connected workspace/);
  assert.match(tour.stops[1].reason, /file is not mapped/);
  assert.match(tour.stops[2].reason, /could not be surveyed/);
  assert.equal(tour.stops[3].missing, false);
  let state = createTourState(tour);
  for (let i = 0; i < 3; i++) state = tourReducer(state, { type: 'missing' });
  assert.equal(state.index, 3);
  assert.deepEqual(state.skipped, [0, 1, 2]);
  const reimport = importTourDraft(exportTour(draft)).tour;
  assert.deepEqual(reimport.stops.map((s) => s.planet), ['gone', 'a', 'b', 'a']);
});

test('unscoped workspace file ids resolve across bodies while relative folders require an import body', async () => {
  const { tour } = await validateTourDraft({ id: 'r', stops: [{ path: 'b/src/69.js' }, { molecule: 'src' }] }, workspace);
  assert.equal(tour.stops[0].planet, 'b');
  assert.equal(tour.stops[0].path, 'src/69.js');
  assert.equal(tour.stops[0].missing, false);
  assert.match(tour.stops[1].reason, /select its body when importing/);
  const imported = importTourDraft(JSON.stringify({ id: 'r', stops: [{ molecule: 'src' }] }), 'b');
  const validated = await validateTourDraft(imported.tour, workspace);
  assert.equal(validated.tour.stops[0].missing, false);
});

test('invalid and empty drafts fail before metadata is loaded, and revalidation reflects removed files', async () => {
  let reads = 0;
  const loadPlanet = async () => { reads++; return payloads[0]; };
  assert.ok((await validateTourDraft(createTourDraft(), { bodies, loadPlanet })).error);
  assert.equal(reads, 0);
  const draft = { id: 'r', stops: [{ planet: 'a', path: 'src/0.js' }] };
  assert.equal((await validateTourDraft(draft, workspace)).tour.stops[0].missing, false);
  const updated = await validateTourDraft(draft, { bodies, loadPlanet: async () => ({ ...payloads[0], atoms: [] }) });
  assert.equal(updated.tour.stops[0].missing, true);
});
