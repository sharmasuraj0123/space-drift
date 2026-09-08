import * as C from './constants.js';
import { aggregateBody, canonicalAtomId, finalizeDiscovery, groupIntoMolecules, replayLedger, snapshotExcitations, timeMs } from './universe-core.js';
import { validateTour, resolveTour, generateOnboardingTour } from './tours.js';

let sequence = 0;
const abortError = () => Object.assign(new Error('The selected workspace is disconnected.'), { name: 'AbortError' });
const notFound = () => Object.assign(new Error('This body is no longer in the workspace.'), { status: 404, name: 'NotFoundError' });
const gitOff = (reason = 'unavailable') => ({ enabled: false, head: null, branch: null, dirty: 0, lastCommitAt: null, windowDays: C.GIT_WINDOW_DAYS, reason });

export function waitFor(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(abortError()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => { signal.removeEventListener('abort', abort); resolve(value); }, (error) => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

function diff(before, after, at) {
  if (!before) return [];
  const events = [];
  const emit = (type, path, extras) => events.push({ id: `survey-${++sequence}`, type, path, at, ...extras });
  const previous = new Map(before.world.files.map((file) => [file.path, file]));
  const current = new Map(after.world.files.map((file) => [file.path, file]));
  const removed = new Set([...previous.keys()].filter((key) => !current.has(key)));
  const added = new Set([...current.keys()].filter((key) => !previous.has(key)));
  const identity = (snapshot, key) => snapshot.records?.get(key)?.identity;
  for (const [key, file] of current) {
    const old = previous.get(key);
    const beforeRecord = before.records?.get(key); const afterRecord = after.records?.get(key);
    if (old && (old.size !== file.size || old.modifiedAt !== file.modifiedAt || beforeRecord?.ctimeMs !== afterRecord?.ctimeMs || beforeRecord?.identity !== afterRecord?.identity)) emit('modified', key, { beforeSize: old.size, afterSize: file.size, mtimeMs: afterRecord?.mtimeMs ?? timeMs(file.modifiedAt), ctimeMs: afterRecord?.ctimeMs });
  }
  if (!before.complete || !after.complete) return events;
  const oldIdentities = new Map(); const newCounts = new Map();
  for (const key of previous.keys()) { const value = identity(before, key); if (value) oldIdentities.set(value, oldIdentities.has(value) ? null : key); }
  for (const key of current.keys()) { const value = identity(after, key); if (value) newCounts.set(value, (newCounts.get(value) || 0) + 1); }
  for (const key of added) {
    const value = identity(after, key); const previousPath = value && oldIdentities.get(value);
    if (previousPath && removed.has(previousPath) && newCounts.get(value) === 1) {
      emit('moved', key, { previousPath, beforeSize: previous.get(previousPath).size, afterSize: current.get(key).size, mtimeMs: after.records?.get(key)?.mtimeMs ?? timeMs(current.get(key).modifiedAt), ctimeMs: after.records?.get(key)?.ctimeMs }); removed.delete(previousPath);
    } else emit('created', key, { beforeSize: 0, afterSize: current.get(key).size, mtimeMs: after.records?.get(key)?.mtimeMs ?? timeMs(current.get(key).modifiedAt), ctimeMs: after.records?.get(key)?.ctimeMs });
  }
  for (const key of removed) emit('deleted', key, { beforeSize: previous.get(key).size, afterSize: 0 });
  return events;
}

/** Runtime-neutral coordinator: adapters own I/O, this owns bounded survey scheduling. */
export function createSurveyUniverse({ root, discover, scanBody, readGit, readMetadata, live = true, now = () => Date.now(), options = {} }) {
  const states = new Map(); const queue = []; const gitQueue = [];
  const lifetime = new AbortController();
  const concurrency = options.surveyConcurrency ?? C.SURVEY_CONCURRENCY;
  const gitConcurrency = options.gitConcurrency ?? C.GIT_CONCURRENCY;
  const tickMs = options.tickMs ?? 5000;
  let topology = null; let discoveryPromise = null; let discoveredAt = -Infinity;
  let active = 0; let gitActive = 0; let disposed = false; let timer = null; let round = 0; let tickPromise = null;
  const ensure = () => { if (disposed) throw abortError(); };
  const descriptors = () => [...states.values()].filter((entry) => !entry.hidden).map((entry) => entry.body);
  const index = () => [...states.values()].filter((entry) => !entry.hidden).flatMap((entry) => [...entry.index.values()]);
  const summary = (entry) => ({ ...entry.body, ...entry.summary, survey: { ...entry.summary.survey } });
  const space = () => ({ layer: 'space', root: { ...root, isRepo: !!topology?.rootIsRepo }, scannedAt: new Date(now()).toISOString(), discovery: { depth: topology?.depth ?? C.PLANET_SEARCH_DEPTH, planets: descriptors().filter((body) => body.kind === 'planet').length, overflow: topology?.overflow?.length || 0, truncated: !!topology?.truncated, ...(topology?.limitation ? { limitation: topology.limitation } : {}) }, bodies: [...states.values()].filter((entry) => !entry.hidden).map(summary).sort((a, b) => a.id.localeCompare(b.id)), events: [...states.values()].filter((entry) => !entry.hidden).flatMap((entry) => entry.events).sort((a, b) => timeMs(b.at) - timeMs(a.at) || b.id.localeCompare(a.id)).slice(0, 40) });
  const valid = (entry) => !disposed && states.get(entry.body.id) === entry;

  function assemble(entry, at) {
    if (!entry.snapshot) return null;
    const stamp = new Date(at).toISOString();
    const files = entry.snapshot.world.files.map((file) => {
      const lines = entry.git?.lines?.get(file.path) ?? Math.ceil(file.size / C.BYTES_PER_LINE);
      const measured = entry.git?.ok && entry.git.files.get(file.path);
      let result;
      if (measured) {
        const history = measured.excitations.map((event) => ({ ...event, delta: event.binary || event.delta === null ? lines : event.delta }));
        const observed = measured.observation;
        const provisional = (entry.provisional.get(file.path) || []).filter((event) => timeMs(event.at) > (entry.git.collectedAt ?? Infinity) &&
          !(observed && event.mtimeMs === observed.mtimeMs && event.afterSize === observed.size && (event.ctimeMs == null || observed.ctimeMs == null || event.ctimeMs === observed.ctimeMs)));
        result = replayLedger({ atomicMass: file.size, lines }, [...history, ...provisional], at);
      } else {
        const prior = entry.energy.get(file.path);
        result = replayLedger({ ...prior, atomicMass: file.size, lines }, [], at);
      }
      const atom = { ...file, id: canonicalAtomId(entry.body.path, file.path), atomicMass: file.size, lines, linesExact: !!entry.git?.lines?.has(file.path), ...result, excitationAt: stamp, status: measured?.status || 'unknown' };
      entry.energy.set(file.path, { atomicMass: file.size, ...result });
      return atom;
    });
    const { atoms, molecules } = groupIntoMolecules(files, entry.snapshot.repoDirectories || entry.snapshot.world.repoDirectories || [], { directories: entry.snapshot.directories || entry.snapshot.world.directories || [], at });
    const aggregate = aggregateBody(molecules, atoms);
    if (entry.body.kind !== 'belt') delete aggregate.crystals;
    const survey = { scannedAt: entry.snapshot.world.scannedAt, pending: false, partial: !entry.snapshot.complete || !!entry.snapshot.world.truncated, omitted: entry.snapshot.world.omitted || 0, omittedIsLowerBound: !!entry.snapshot.world.omittedIsLowerBound, unreadable: entry.snapshot.world.unreadable || 0, revision: entry.revision };
    const git = entry.git?.ok ? { enabled: true, head: entry.git.head, branch: entry.git.branch, dirty: entry.git.dirty, lastCommitAt: entry.git.lastCommitAt ? new Date(timeMs(entry.git.lastCommitAt)).toISOString() : null, windowDays: C.GIT_WINDOW_DAYS, reason: entry.git.partial ? 'partial' : null, partial: !!entry.git.partial } : gitOff(entry.git?.reason || (readGit ? 'pending' : 'browser'));
    const payload = { layer: 'planet', ...entry.body, ...aggregate, scannedAt: entry.snapshot.world.scannedAt, survey, git, molecules, atoms, events: [...entry.events], entryPoints: entry.entryPoints || [] };
    entry.summary = { ...aggregate, survey, git };
    entry.index = new Map(atoms.map((atom) => [atom.id, { planetId: entry.body.id, id: atom.id, path: atom.path, name: atom.name, atomicMass: atom.atomicMass, bytes: atom.atomicMass, element: atom.element, moleculeId: atom.moleculeId, mtimeMs: timeMs(atom.modifiedAt) }]));
    entry.payload = at - entry.lastAccess <= (options.planetCacheMs ?? C.PLANET_CACHE_MS) ? payload : null;
    entry.hidden = entry.body.provisional && atoms.length === 0 && entry.snapshot.complete;
    return payload;
  }

  function pumpGit() {
    while (!disposed && gitActive < gitConcurrency && gitQueue.length) {
      const entry = gitQueue.shift();
      if (!valid(entry)) continue;
      gitActive += 1;
      const started = now(); const snapshot = entry.snapshot;
      Promise.resolve().then(() => readGit(entry.body, snapshot, topology, { signal: lifetime.signal, now: started })).then((result) => {
        if (!valid(entry)) return;
        entry.git = { ...result, collectedAt: result?.collectedAt ?? started };
        entry.gitAt = started;
        entry.revision += 1;
        for (const [key, events] of entry.provisional) entry.provisional.set(key, events.filter((event) => timeMs(event.at) > started));
        assemble(entry, now());
      }).catch(() => { if (valid(entry)) { entry.git = { ok: false, reason: 'unavailable' }; entry.gitAt = started; assemble(entry, now()); } }).finally(() => { entry.gitPending = false; gitActive -= 1; pumpGit(); });
    }
  }

  async function survey(entry) {
    const snapshot = await scanBody(entry.body, topology, { signal: lifetime.signal, now: now() });
    if (!valid(entry)) throw abortError();
    const at = now(); const stamp = new Date(at).toISOString();
    snapshot.world.scannedAt = stamp;
    const events = diff(entry.snapshot, snapshot, stamp);
    const estimates = snapshotExcitations(events, entry.energy);
    for (const event of estimates) {
      if (event.cooling) continue;
      const file = snapshot.world.files.find((candidate) => candidate.path === event.path);
      if (!file) continue;
      const before = entry.energy.get(event.carryFrom || event.path);
      const baseline = { ...(before || {}), atomicMass: file.size, lines: Math.ceil(file.size / C.BYTES_PER_LINE) };
      entry.energy.set(event.path, { atomicMass: file.size, ...replayLedger(baseline, [event], at) });
      entry.provisional.set(event.path, [...(entry.provisional.get(event.path) || []), event].slice(-64));
    }
    const selected = new Set(snapshot.world.files.map((file) => file.path));
    for (const key of entry.energy.keys()) if (!selected.has(key)) entry.energy.delete(key);
    for (const key of entry.provisional.keys()) if (!selected.has(key)) entry.provisional.delete(key);
    entry.events = [...events.map((event) => ({ ...event, planetId: entry.body.id })).reverse(), ...entry.events].slice(0, 40);
    entry.snapshot = snapshot; entry.surveyedAt = at; entry.revision += 1;
    const payload = assemble(entry, at);
    if (readGit && !entry.gitPending && at - entry.gitAt >= (options.gitCacheMs ?? C.GIT_CACHE_MS)) {
      entry.gitPending = true; gitQueue.push(entry); pumpGit();
    }
    return payload;
  }

  function pump() {
    while (!disposed && active < concurrency && queue.length) {
      const entry = queue.shift();
      if (!valid(entry)) { entry.job?.reject(abortError()); continue; }
      active += 1;
      survey(entry).then(entry.job.resolve, (error) => {
        if (valid(entry)) entry.summary.survey = { ...entry.summary.survey, pending: false, partial: true, error: error.message };
        entry.job.reject(error);
      }).finally(() => { entry.job = null; active -= 1; pump(); });
    }
  }
  function enqueue(entry, priority = false) {
    if (entry.job) {
      const position = priority ? queue.indexOf(entry) : -1;
      if (position > 0) { queue.splice(position, 1); queue.unshift(entry); }
      return entry.job.promise;
    }
    let resolve; let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    entry.job = { promise, resolve, reject };
    priority ? queue.unshift(entry) : queue.push(entry);
    pump(); return promise;
  }

  async function refreshDiscovery(force = false) {
    ensure();
    if (discoveryPromise) return discoveryPromise;
    if (topology && !force && now() - discoveredAt < (options.discoveryIntervalMs ?? C.DISCOVERY_INTERVAL_MS)) return topology;
    discoveryPromise = (async () => {
      let found = await discover({ signal: lifetime.signal }); ensure();
      // A timed-out walk cannot prove an absent body was deleted. Retain only
      // paths whose ownership was not explicitly superseded by a found repo.
      if (topology && found.incomplete) {
        const observed = [...found.planets, ...found.overflow];
        const retained = [...topology.planets, ...topology.overflow].filter((old) => !observed.some((current) => old.path === current.path || old.path.startsWith(current.path + '/') || current.path.startsWith(old.path + '/')));
        if (retained.length) found = { ...finalizeDiscovery({ rootName: root.name, rootIsRepo: found.rootIsRepo, repositories: [...observed, ...retained], truncated: true, depth: found.depth, maxPlanets: found.maxPlanets, limitation: found.limitation }), incomplete: true };
      }
      const ownership = (value) => value ? [...value.planets, ...value.overflow].map((body) => body.path).sort().join('\0') : '';
      const ownershipChanged = topology && ownership(topology) !== ownership(found);
      topology = found; discoveredAt = now();
      const ids = new Set(found.bodies.map((body) => body.id));
      for (const [id, entry] of states) if (!ids.has(id)) { states.delete(id); entry.job?.reject(notFound()); }
      for (const body of found.bodies) {
        let entry = states.get(body.id);
        if (entry && (JSON.stringify(entry.body) !== JSON.stringify(body) || (body.kind === 'belt' && ownershipChanged))) { states.delete(body.id); entry.job?.reject(notFound()); entry = null; }
        if (!entry) {
          entry = { body, summary: { restMass: 0, excitation: 0, excitationAt: new Date(now()).toISOString(), xi: 0, fileCount: 0, moleculeCount: 0, nestedRepos: 0, elements: {}, hot: [], patches: [], color: [.4, .5, .7], survey: { pending: true, partial: false, scannedAt: null, omitted: 0, revision: 0 }, git: gitOff(readGit ? 'pending' : 'browser') }, index: new Map(), energy: new Map(), provisional: new Map(), snapshot: null, payload: null, events: [], revision: 0, surveyedAt: -Infinity, lastAccess: now(), activeAt: -Infinity, gitAt: -Infinity, gitPending: false, git: null, job: null, hidden: false };
          states.set(body.id, entry);
        }
      }
      // Promise microtasks start surveys after the initial pending payload is assembled.
      setTimeout(() => { if (!disposed) for (const entry of states.values()) if (!entry.snapshot) enqueue(entry); }, 0).unref?.();
      return found;
    })().finally(() => { discoveryPromise = null; });
    return discoveryPromise;
  }

  async function tick() {
    ensure(); if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      await refreshDiscovery();
      const current = [...states.values()]; const jobs = [];
      const start = Date.now();
      for (const entry of current) {
        if (Date.now() - start >= (options.tickBudgetMs ?? C.SPACE_TICK_BUDGET_MS)) break;
        if (!entry.snapshot || (live && now() - entry.activeAt <= 10000)) jobs.push(enqueue(entry, true));
        if (now() - entry.lastAccess > (options.planetCacheMs ?? C.PLANET_CACHE_MS)) entry.payload = null;
      }
      if (live && current.length) jobs.push(enqueue(current[round++ % current.length]));
      let timer;
      try {
        await Promise.race([Promise.allSettled(jobs), new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, (options.tickBudgetMs ?? C.SPACE_TICK_BUDGET_MS) - (Date.now() - start))); })]);
      } finally { clearTimeout(timer); }
      return space();
    })().finally(() => { tickPromise = null; });
    return tickPromise;
  }
  function schedule(delay = tickMs) {
    if (disposed || !live) return;
    timer = setTimeout(() => { const start = Date.now(); tick().catch(() => {}).finally(() => schedule(Math.max(0, tickMs - (Date.now() - start)))); }, delay); timer.unref?.();
  }
  schedule();

  return {
    async readSpace({ signal } = {}) {
      ensure(); if (signal?.aborted) throw abortError();
      if (!topology) await waitFor(refreshDiscovery(), signal);
      else refreshDiscovery().catch(() => {});
      ensure(); return space();
    },
    async readPlanet(id, { signal } = {}) {
      ensure(); await waitFor(refreshDiscovery(), signal);
      const entry = states.get(id); if (!entry || entry.hidden) throw notFound();
      entry.lastAccess = now(); entry.activeAt = now();
      if (entry.snapshot && (!live || now() - entry.surveyedAt < 5000)) return entry.payload || assemble(entry, now());
      return waitFor(enqueue(entry, true), signal);
    },
    search(query, limit = 60) { ensure(); const needle = String(query || '').toLowerCase(); return index().filter((atom) => atom.id.toLowerCase().includes(needle)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.min(60, Math.max(0, Number(limit) || 0))); },
    planets() { ensure(); return descriptors(); },
    mappedAtoms() { ensure(); return { files: index().map((atom) => ({ ...atom, path: atom.id, size: atom.atomicMass })) }; },
    async tours({ signal } = {}) {
      ensure(); await waitFor(refreshDiscovery(), signal);
      const metadata = readMetadata ? await waitFor(readMetadata(descriptors(), { signal: lifetime.signal }), signal) : { definitions: [], errors: [] };
      const errors = [...(metadata.errors || [])]; const tours = [];
      const tourBodies = descriptors().map((body) => ({ ...body, molecules: (states.get(body.id)?.snapshot?.directories || []).map((directory) => ({ id: typeof directory === 'string' ? directory : directory.path })) }));
      for (const definition of metadata.definitions || []) {
        const result = validateTour(definition.value, { defaultPlanet: definition.planet || null, sourceId: definition.id, scopeId: definition.id });
        if (result.error) errors.push({ id: definition.id, error: result.error });
        else tours.push(resolveTour(result.tour, tourBodies, index()));
      }
      for (const [id, points] of Object.entries(metadata.entryPoints || {})) { const entry = states.get(id); if (entry) { entry.entryPoints = points; if (entry.payload) entry.payload = { ...entry.payload, entryPoints: points }; } }
      if (!tours.some((tour) => tour.id === 'onboarding' || tour.key === 'onboarding')) {
        const payloads = [...states.values()].map((entry) => entry.payload).filter(Boolean);
        if (!payloads.length) {
          const candidate = [...states.values()].filter((entry) => !entry.hidden && entry.snapshot).sort((a, b) => b.summary.excitation - a.summary.excitation || a.body.id.localeCompare(b.body.id))[0];
          if (candidate) payloads.push(assemble(candidate, now()));
        }
        const generated = generateOnboardingTour(space(), payloads);
        if (generated) tours.unshift(generated);
      }
      ensure(); return { tours, errors, pending: [...states.values()].some((entry) => !entry.snapshot) };
    },
    tick,
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); clearTimeout(timer); for (const entry of states.values()) entry.job?.reject(abortError()); states.clear(); queue.length = 0; gitQueue.length = 0; },
  };
}
