import * as C from './constants.js';
import { finalizeDiscovery } from './universe-core.js';
import { createSurveyUniverse } from './universe-reader.js';
import { readWorkspaceMetadata } from './workspace-metadata.js';

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor', '__pycache__', 'venv', 'env', 'tmp', 'temp', 'cache', 'Caches']);
const SECRET_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'keystore']);
let eventSequence = 0;

const extension = (name) => name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
const safeSegment = (name) => typeof name === 'string' && name.length > 0 && !name.startsWith('.') && !/[\0/\\]/.test(name) && !/^[a-z]:/i.test(name);
const ignored = (name, directory) => !safeSegment(name) || (directory && IGNORED_DIRECTORIES.has(name)) || SECRET_EXTENSIONS.has(extension(name));
const safePath = (value) => typeof value === 'string' && value.split('/').every(safeSegment);
// A hidden component is an intentional exclusion, while traversal/malformed
// components indicate an unreadable selection. Opening still uses safePath.
const structurallyValidPath = (value) => typeof value === 'string' && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..' && !/[\0\\]/.test(part) && !/^[a-z]:/i.test(part));
const abortError = () => Object.assign(new Error('Folder access was cancelled.'), { name: 'AbortError' });
const missingError = () => Object.assign(new Error('This file is no longer on the map. Refresh the folder and try again.'), { name: 'NotFoundError' });
const checkSignal = (signal) => { if (signal?.aborted) throw abortError(); };
class BudgetError extends Error {}

function limits(options) {
  const number = (key, fallback) => Number.isFinite(options[key]) ? Math.max(0, Math.floor(options[key])) : fallback;
  return { maxFiles: number('maxFiles', 2500), maxEntries: number('maxEntries', 25000), maxDepth: number('maxDepth', 32), maxDurationMs: number('maxDurationMs', 10000) };
}

/** Await browser operations without letting a stalled handle defeat cancellation. */
function guarded(promise, signal, deadline = Infinity) {
  const operation = Promise.resolve(promise);
  if (signal?.aborted || Date.now() >= deadline) {
    operation.catch(() => {});
    return Promise.reject(signal?.aborted ? abortError() : new BudgetError());
  }
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); reject(abortError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (Number.isFinite(deadline)) timer = setTimeout(() => { cleanup(); reject(new BudgetError()); }, Math.max(0, deadline - Date.now()));
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function metadata(file, relativePath) {
  const name = relativePath.split('/').at(-1);
  if (!file || file.name !== name || !Number.isFinite(file.size) || file.size < 0 || !Number.isFinite(file.lastModified)) return null;
  const modified = new Date(file.lastModified);
  if (!Number.isFinite(modified.getTime())) return null;
  return { id: relativePath, path: relativePath, name, parent: relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '.', size: file.size, modifiedAt: modified.toISOString(), extension: extension(name) };
}

function sample(candidates, maxFiles) {
  const groups = new Map();
  for (const candidate of candidates) {
    const key = candidate.path.includes('/') ? candidate.path.split('/')[0] : '.';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(candidate);
  }
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, files]) => files.sort((a, b) => a.path.localeCompare(b.path)));
  const selected = [];
  for (let round = 0; selected.length < Math.min(maxFiles, candidates.length); round += 1) {
    for (const files of ordered) {
      if (files[round]) selected.push(files[round]);
      if (selected.length >= maxFiles) break;
    }
  }
  return selected;
}

function changes(previous, current, at) {
  if (!previous) return [];
  const result = [];
  const emit = (type, filePath) => result.push({ id: `local-${++eventSequence}`, type, path: filePath, at });
  for (const [filePath, entry] of current.records) {
    const before = previous.records.get(filePath);
    if (before && (before.metadata.size !== entry.metadata.size || before.metadata.modifiedAt !== entry.metadata.modifiedAt)) emit('modified', filePath);
    else if (!before && previous.complete && current.complete) emit('created', filePath);
  }
  if (previous.complete && current.complete) {
    for (const filePath of previous.records.keys()) if (!current.records.has(filePath)) emit('deleted', filePath);
  }
  return result;
}

function source({ kind, name, scan, resolveFile }) {
  let disposed = false;
  let previous = null;
  let events = [];
  let pending = null;
  const lifetime = new AbortController();
  const ensureActive = (signal) => { if (disposed) throw abortError(); checkSignal(signal); };
  return {
    kind, name, live: kind === 'directory',
    _scan: scan, _resolveFile: resolveFile,
    readWorld({ signal } = {}) {
      try { ensureActive(signal); } catch (error) { return Promise.reject(error); }
      if (pending) return guarded(pending, signal);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      const operation = (async () => {
        const current = await scan(controller.signal);
        ensureActive(controller.signal);
        const scannedAt = new Date().toISOString();
        events = [...changes(previous, current, scannedAt).reverse(), ...events].slice(0, 40);
        previous = current;
        return {
          root: { name, path: name }, scannedAt,
          files: [...current.records.values()].map((entry) => entry.metadata).sort((a, b) => a.path.localeCompare(b.path)),
          events: [...events], truncated: current.truncated,
          omitted: current.omitted, omittedIsLowerBound: current.omittedIsLowerBound, unreadable: current.unreadable,
        };
      })();
      pending = operation.finally(() => {
        signal?.removeEventListener('abort', cancel);
        lifetime.signal.removeEventListener('abort', cancel);
        pending = null;
      });
      return pending;
    },
    async getFile(filePath, { signal } = {}) {
      ensureActive(signal);
      if (!safePath(filePath) || !previous?.records.has(filePath)) throw missingError();
      const entry = previous.records.get(filePath);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      lifetime.signal.addEventListener('abort', cancel, { once: true });
      try {
        const file = await guarded(resolveFile(filePath, entry, controller.signal), controller.signal);
        ensureActive(controller.signal);
        if (!previous?.records.has(filePath) || !metadata(file, filePath)) throw missingError();
        return file;
      } finally {
        signal?.removeEventListener('abort', cancel);
        lifetime.signal.removeEventListener('abort', cancel);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      previous = null;
      events = [];
    },
  };
}

/** A browser directory handle is used with read permission only; no file bytes are read while mapping. */
function createRawDirectorySource(handle, options = {}) {
  if (!handle || handle.kind !== 'directory' || typeof handle.entries !== 'function') throw new TypeError('Select a folder to explore.');
  const config = limits(options);
  const name = options.name || handle.name || 'Selected folder';
  const scan = async (signal) => {
    const deadline = Date.now() + config.maxDurationMs;
    const discoveryDeadline = Date.now() + config.maxDurationMs * .65;
    const queue = [{ handle, path: '', depth: 0 }];
    const candidates = [];
    const directories = []; const repoDirectories = [];
    const seen = new Set();
    const ambiguous = new Set();
    let inspected = 0;
    let truncated = false;
    let complete = true;
    let unreadable = 0;
    discovery: for (let cursor = 0; cursor < queue.length; cursor += 1) {
      checkSignal(signal);
      const folder = queue[cursor];
      directories.push(folder.path || '.');
      try {
        const iterator = folder.handle.entries()[Symbol.asyncIterator]();
        while (true) {
          const { done, value } = await guarded(iterator.next(), signal, discoveryDeadline);
          if (done) break;
          inspected += 1;
          if (inspected > config.maxEntries) { truncated = true; complete = false; break discovery; }
          const [entryName, child] = value;
          const directory = child?.kind === 'directory';
          if (entryName === '.git' && folder.path && (directory || child?.kind === 'file')) repoDirectories.push({ path: folder.path, marker: directory ? 'dir' : 'file' });
          if (ignored(entryName, directory) || (child?.kind !== 'file' && !directory)) continue;
          const relativePath = folder.path ? `${folder.path}/${entryName}` : entryName;
          if (options.excludePaths?.some((excluded) => relativePath === excluded || relativePath.startsWith(excluded + '/'))) continue;
          if (seen.has(relativePath)) { ambiguous.add(relativePath); unreadable += 1; complete = false; continue; }
          seen.add(relativePath);
          if (directory) {
            if (folder.depth >= config.maxDepth) { truncated = true; complete = false; }
            else queue.push({ handle: child, path: relativePath, depth: folder.depth + 1 });
          } else candidates.push({ path: relativePath, handle: child });
        }
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (error instanceof BudgetError) { complete = false; truncated = true; break; }
        // Losing the selected root is a disconnected source, not an empty map.
        // Let the caller retain its last world and offer folder reconnection.
        if (folder.path === '') throw error;
        complete = false;
        unreadable += 1;
      }
    }
    const omittedIsLowerBound = !complete;
    const eligible = candidates.filter((candidate) => {
      const segments = candidate.path.split('/');
      return !segments.some((segment, index) => ambiguous.has(segments.slice(0, index + 1).join('/')));
    });
    const selected = sample(eligible, config.maxFiles);
    if (selected.length < eligible.length) { truncated = true; complete = false; }
    const records = new Map();
    for (const candidate of selected) {
      try {
        const file = await guarded(candidate.handle.getFile(), signal, deadline);
        const info = metadata(file, candidate.path);
        if (!info) throw missingError();
        records.set(candidate.path, { metadata: info });
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        complete = false;
        if (error instanceof BudgetError) { truncated = true; break; }
        unreadable += 1;
      }
    }
    return { records, complete, truncated, omitted: eligible.length - records.size, omittedIsLowerBound: omittedIsLowerBound || unreadable > 0, unreadable, directories, repoDirectories };
  };
  return source({ kind: 'directory', name, scan, resolveFile: async (filePath, entry, signal) => {
    let current = handle;
    const segments = filePath.split('/');
    for (const segment of segments.slice(0, -1)) current = await guarded(current.getDirectoryHandle(segment, { create: false }), signal);
    const leaf = await guarded(current.getFileHandle(segments.at(-1), { create: false }), signal);
    return guarded(leaf.getFile(), signal);
  } });
}

/** FileList selections are immutable snapshots. Reselect the folder to observe later changes. */
function createRawSnapshotSource(inputFiles, options = {}) {
  const config = limits(options);
  const selectedFiles = Array.from(inputFiles || []);
  const relativeRoots = selectedFiles.map((file) => typeof file.webkitRelativePath === 'string' ? file.webkitRelativePath : '');
  const proposedRoot = relativeRoots[0]?.split('/')[0];
  const validRoot = proposedRoot && proposedRoot !== '.' && proposedRoot !== '..' && !/[\0/\\]/.test(proposedRoot) && !/^[a-z]:/i.test(proposedRoot);
  const sharedRoot = validRoot && relativeRoots.length > 0 && relativeRoots.every((value) => value.includes('/') && value.split('/')[0] === proposedRoot) ? proposedRoot : '';
  const name = options.name || sharedRoot || 'Selected files';
  const scan = async (signal) => {
    const deadline = Date.now() + config.maxDurationMs;
    const byPath = new Map();
    const duplicates = new Set();
    let inspected = 0;
    let truncated = false;
    let complete = true;
    let unreadable = 0;
    for (const file of selectedFiles) {
      checkSignal(signal);
      inspected += 1;
      if (inspected > config.maxEntries || Date.now() >= deadline) { truncated = true; complete = false; break; }
      let relativePath = file.webkitRelativePath || file.name;
      if (sharedRoot) relativePath = relativePath.slice(sharedRoot.length + 1);
      if (!structurallyValidPath(relativePath)) { unreadable += 1; complete = false; continue; }
      const segments = relativePath.split('/');
      if (segments.some((part, index) => ignored(part, index < segments.length - 1))) continue;
      if (segments.length - 1 > config.maxDepth) { truncated = true; complete = false; continue; }
      const info = metadata(file, relativePath);
      if (!info) { unreadable += 1; complete = false; continue; }
      if (duplicates.has(relativePath) || byPath.has(relativePath)) {
        byPath.delete(relativePath);
        duplicates.add(relativePath);
        unreadable += 1;
        complete = false;
        continue;
      }
      byPath.set(relativePath, { path: relativePath, file, metadata: info });
    }
    const candidates = [...byPath.values()];
    const omittedIsLowerBound = !complete;
    const chosen = sample(candidates, config.maxFiles);
    if (chosen.length < candidates.length) { truncated = true; complete = false; }
    return { records: new Map(chosen.map((entry) => [entry.path, entry])), complete, truncated, omitted: candidates.length - chosen.length, omittedIsLowerBound, unreadable };
  };
  return source({ kind: 'snapshot', name, scan, resolveFile: async (filePath, entry) => entry.file });
}

async function directoryAt(root, relative, signal, deadline = Infinity) {
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) current = await guarded(current.getDirectoryHandle(part, { create: false }), signal, deadline);
  return current;
}

/** Marker discovery reads directory entries, including the name .git, never Git bytes. */
async function discoverHandles(root, name, options, signal, limitation) {
  const depth = options.depth ?? C.PLANET_SEARCH_DEPTH;
  const deadline = Date.now() + (options.budgetMs ?? C.DISCOVERY_MS);
  const maxEntries = options.maxEntries ?? 25000;
  const repositories = []; const queue = [{ handle: root, path: '', depth: 0 }];
  let rootMarker = null; let truncated = false; let inspected = 0; let incomplete = false;
  outer: for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const folder = queue[cursor]; const children = []; let marker = null;
    try {
      const iterator = folder.handle.entries()[Symbol.asyncIterator]();
      while (true) {
        const { done, value } = await guarded(iterator.next(), signal, deadline);
        if (done) break;
        if (++inspected > maxEntries) { truncated = true; incomplete = true; break outer; }
        const [entryName, entry] = value;
        if (entryName === '.git' && ['file', 'directory'].includes(entry?.kind)) marker = entry.kind === 'file' ? 'file' : 'dir';
        else if (entry?.kind === 'directory' && !ignored(entryName, true)) children.push({ name: entryName, handle: entry });
      }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error instanceof BudgetError) { truncated = true; incomplete = true; break; }
      if (cursor === 0) throw error;
      truncated = true; incomplete = true; continue;
    }
    if (!folder.path) rootMarker = marker;
    else if (marker) { repositories.push({ path: folder.path, name: folder.handle.name, marker, depth: folder.depth }); continue; }
    if (folder.depth >= depth) { truncated ||= children.length > 0; continue; }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) queue.push({ handle: child.handle, path: folder.path ? `${folder.path}/${child.name}` : child.name, depth: folder.depth + 1 });
  }
  return { ...finalizeDiscovery({ rootName: name, rootIsRepo: !!rootMarker, rootMarker, repositories, truncated, depth, maxPlanets: options.maxPlanets ?? C.MAX_PLANETS, limitation }), incomplete };
}

function asSnapshot(raw, name) {
  const files = [...raw.records.values()].map((entry) => entry.metadata).sort((a, b) => a.path.localeCompare(b.path));
  return { ...raw, world: { root: { name, path: name }, scannedAt: new Date().toISOString(), files, truncated: raw.truncated, omitted: raw.omitted, unreadable: raw.unreadable, omittedIsLowerBound: raw.omittedIsLowerBound }, records: new Map(files.map((file) => [file.path, { file, mtimeMs: Date.parse(file.modifiedAt) }])) };
}

function attachUniverse(raw, rootHandle, options = {}, limitation = null) {
  let disposed = false; let layered = false;
  const lifetime = new AbortController();
  const readLeaf = async (relative, signal, deadline = Infinity) => {
    const parts = relative.split('/');
    const parent = await directoryAt(rootHandle, parts.slice(0, -1).join('/'), signal, deadline);
    const handle = await guarded(parent.getFileHandle(parts.at(-1), { create: false }), signal, deadline);
    return guarded(handle.getFile(), signal, deadline);
  };
  const scanBody = async (body, topology, { signal }) => {
    const config = { ...options, maxDurationMs: options.maxDurationMs ?? C.PLANET_SCAN_MS };
    if (body.kind !== 'overflow') {
      const handle = await directoryAt(rootHandle, body.path, signal, Date.now() + config.maxDurationMs);
      const excludePaths = body.kind === 'belt' ? [...topology.planets, ...topology.overflow].map((repo) => repo.path) : [];
      const temporary = createRawDirectorySource(handle, { ...config, excludePaths });
      try { return asSnapshot(await temporary._scan(signal), body.name); } finally { temporary.dispose(); }
    }
    const result = { records: new Map(), directories: ['.'], repoDirectories: [], complete: true, truncated: false, omitted: 0, unreadable: 0, omittedIsLowerBound: false };
    const deadline = Date.now() + config.maxDurationMs; let remaining = config.maxFiles ?? 2500;
    const members = topology.overflow;
    for (let i = 0; i < members.length; i += 1) {
      const member = members[i];
      result.directories.push(member.path); result.repoDirectories.push({ path: member.path, marker: member.marker });
      if (Date.now() >= deadline || remaining <= 0) { result.complete = false; result.truncated = true; result.omittedIsLowerBound = true; continue; }
      const handle = await directoryAt(rootHandle, member.path, signal, deadline);
      const temporary = createRawDirectorySource(handle, { ...config, maxDurationMs: Math.max(1, (deadline - Date.now()) / (members.length - i)), maxFiles: Math.ceil(remaining / (members.length - i)), maxEntries: Math.ceil((config.maxEntries ?? 25000) / members.length) });
      let current;
      try { current = await temporary._scan(signal); } finally { temporary.dispose(); }
      remaining -= current.records.size;
      for (const [relative, value] of current.records) {
        const id = `${member.path}/${relative}`;
        result.records.set(id, { ...value, metadata: { ...value.metadata, id, path: id, parent: value.metadata.parent === '.' ? member.path : `${member.path}/${value.metadata.parent}` } });
      }
      result.directories.push(...current.directories.filter((value) => value !== '.').map((value) => `${member.path}/${value}`));
      result.repoDirectories.push(...current.repoDirectories.map((repo) => ({ ...repo, path: `${member.path}/${repo.path}` })));
      result.complete &&= current.complete; result.truncated ||= current.truncated;
      result.omitted += current.omitted; result.unreadable += current.unreadable; result.omittedIsLowerBound ||= current.omittedIsLowerBound;
    }
    return asSnapshot(result, body.name);
  };
  const universe = createSurveyUniverse({ root: { name: raw.name, path: raw.name }, live: raw.live, now: options.now, options,
    discover: ({ signal }) => discoverHandles(rootHandle, raw.name, options.discoveryOptions || {}, signal, limitation),
    scanBody,
    readMetadata: (bodies, { signal }) => {
      const metadataDeadline = Date.now() + 10000;
      const operationDeadline = () => Math.min(metadataDeadline, Date.now() + C.DISCOVERY_MS);
      return readWorkspaceMetadata(bodies, { signal,
      list: async (relative) => {
        const folder = await directoryAt(rootHandle, relative, signal, operationDeadline());
        const names = []; const iterator = folder.entries()[Symbol.asyncIterator](); const deadline = operationDeadline();
        for (let inspected = 0; inspected < 256; inspected += 1) {
          const value = await guarded(iterator.next(), signal, deadline); if (value.done) break;
          if (value.value[1].kind === 'file' && !value.value[0].startsWith('.') && /\.json$/i.test(value.value[0])) names.push(value.value[0]);
          if (names.length === 64 || inspected === 255) { names.truncated = true; break; }
        }
        return names;
      },
      read: async (relative, limit) => {
        const file = await readLeaf(relative, signal, operationDeadline());
        if (file.size > limit) throw new Error('Metadata is too large.');
        const text = await guarded(file.text(), signal, operationDeadline());
        return { text, size: file.size };
      },
    });
    },
  });
  const { _scan, _resolveFile, ...legacy } = raw;
  return { ...legacy, ...universe,
    async readWorld(options) { const world = await raw.readWorld(options); layered = false; return world; },
    async readSpace(options) { const space = await universe.readSpace(options); layered = true; return space; },
    async readPlanet(id, options) { const planet = await universe.readPlanet(id, options); layered = true; return planet; },
    async getFile(relative, { signal } = {}) {
      checkSignal(signal); if (disposed) throw abortError();
      if (!safePath(relative)) throw missingError();
      if (!layered) return raw.getFile(relative, { signal });
      if (!universe.mappedAtoms().files.some((file) => file.path === relative)) throw missingError();
      const controller = new AbortController(); const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true }); lifetime.signal.addEventListener('abort', abort, { once: true });
      try {
        const file = await readLeaf(relative, controller.signal);
        if (disposed || controller.signal.aborted) throw abortError();
        if (!universe.mappedAtoms().files.some((value) => value.path === relative) || !metadata(file, relative)) throw missingError();
        return file;
      } finally { signal?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', abort); }
    },
    dispose() { if (disposed) return; disposed = true; lifetime.abort(); universe.dispose(); raw.dispose(); },
  };
}

export function createDirectorySource(handle, options = {}) {
  return attachUniverse(createRawDirectorySource(handle, options), handle, options, 'Repository discovery depends on .git names exposed by the browser. Git history is unavailable.');
}

export function createSnapshotSource(inputFiles, options = {}) {
  const files = Array.from(inputFiles || []);
  const raw = createRawSnapshotSource(files, options);
  const roots = files.map((file) => file.webkitRelativePath || ''); const candidate = roots[0]?.split('/')[0];
  const shared = candidate && candidate !== '.' && candidate !== '..' && !/[\\\0:]/.test(candidate) && roots.every((value) => value.includes('/') && value.split('/')[0] === candidate) ? candidate : '';
  const notFound = () => { throw missingError(); };
  const folder = (name) => {
    const entries = new Map();
    return { kind: 'directory', name, children: entries, async *entries() { yield* [...entries.entries()].sort(([a], [b]) => a.localeCompare(b)); },
      async getDirectoryHandle(name) { const entry = entries.get(name); return entry?.kind === 'directory' ? entry : notFound(); },
      async getFileHandle(name) { const entry = entries.get(name); return entry?.kind === 'file' ? entry : notFound(); } };
  };
  const root = folder(raw.name); const duplicates = new Set();
  for (const file of files) {
    let relative = file.webkitRelativePath || file.name;
    if (shared) relative = relative.slice(shared.length + 1);
    if (!structurallyValidPath(relative)) continue;
    const parts = relative.split('/'); let parent = root;
    for (const part of parts.slice(0, -1)) {
      if (!parent.children.has(part)) parent.children.set(part, folder(part));
      parent = parent.children.get(part); if (parent.kind !== 'directory') break;
    }
    if (parent.kind !== 'directory') continue;
    const name = parts.at(-1);
    if (parent.children.has(name) || duplicates.has(relative)) { parent.children.delete(name); duplicates.add(relative); continue; }
    parent.children.set(name, { kind: 'file', name, getFile: async () => file });
  }
  return attachUniverse(raw, root, options, 'This selection is a fixed snapshot. Empty folders and omitted .git markers cannot be discovered; Git history is unavailable. Reselect to refresh.');
}
