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
export function createDirectorySource(handle, options = {}) {
  if (!handle || handle.kind !== 'directory' || typeof handle.entries !== 'function') throw new TypeError('Select a folder to explore.');
  const config = limits(options);
  const name = options.name || handle.name || 'Selected folder';
  const scan = async (signal) => {
    const deadline = Date.now() + config.maxDurationMs;
    const discoveryDeadline = Date.now() + config.maxDurationMs * .65;
    const queue = [{ handle, path: '', depth: 0 }];
    const candidates = [];
    const seen = new Set();
    const ambiguous = new Set();
    let inspected = 0;
    let truncated = false;
    let complete = true;
    let unreadable = 0;
    discovery: for (let cursor = 0; cursor < queue.length; cursor += 1) {
      checkSignal(signal);
      const folder = queue[cursor];
      try {
        const iterator = folder.handle.entries()[Symbol.asyncIterator]();
        while (true) {
          const { done, value } = await guarded(iterator.next(), signal, discoveryDeadline);
          if (done) break;
          inspected += 1;
          if (inspected > config.maxEntries) { truncated = true; complete = false; break discovery; }
          const [entryName, child] = value;
          const directory = child?.kind === 'directory';
          if (ignored(entryName, directory) || (child?.kind !== 'file' && !directory)) continue;
          const relativePath = folder.path ? `${folder.path}/${entryName}` : entryName;
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
    return { records, complete, truncated, omitted: eligible.length - records.size, omittedIsLowerBound: omittedIsLowerBound || unreadable > 0, unreadable };
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
export function createSnapshotSource(inputFiles, options = {}) {
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
