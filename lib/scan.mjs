import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const IGNORED_DIRECTORIES = new Set([
  'node_modules', 'dist', 'build', 'coverage', 'out', 'target', 'vendor',
  '__pycache__', 'venv', 'env', 'tmp', 'temp', 'cache', 'Caches',
]);
const SECRET_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.keystore']);
class ScanBudget extends Error {}
function bounded(operation, deadline, signal, disposeLate) {
  const pending = Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { settled = true; cleanup(); reject(Object.assign(new Error('Scan cancelled.'), { name: 'AbortError' })); };
    const timer = setTimeout(() => { settled = true; cleanup(); reject(new ScanBudget()); }, Math.max(0, deadline - Date.now()));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    pending.then((value) => { if (settled) { disposeLate?.(value); return; } settled = true; cleanup(); resolve(value); }, (error) => { settled = true; cleanup(); reject(error); });
    if (signal?.aborted) abort();
  });
}

export function isIgnored(name, isDirectory) {
  return name.startsWith('.') || (isDirectory && IGNORED_DIRECTORIES.has(name)) ||
    SECRET_EXTENSIONS.has(path.extname(name).toLowerCase());
}

/** Read only names and stat metadata. Symlink entries are never traversed. */
export async function scanDirectory(directory, options = {}) {
  const rootPath = path.resolve(directory);
  const maxFiles = options.maxFiles ?? 2500;
  const maxEntries = options.maxEntries ?? 25000;
  const maxDepth = options.maxDepth ?? 32;
  const maxDurationMs = options.maxDurationMs ?? 10000;
  const discoveryBudgetMs = Math.max(1, maxDurationMs * 0.65);
  const startedAt = Date.now();
  const deadline = startedAt + maxDurationMs;
  const read = (operation) => bounded(operation, deadline, options.signal);
  const queue = [{ absolute: rootPath, relative: '.', depth: 0 }];
  const records = new Map();
  const candidates = [];
  const repoDirectories = [];
  const directories = [];
  const stopPaths = options.repoStopPaths ? new Set(options.repoStopPaths) : null;
  let inspected = 0;
  let truncated = false;
  let unreadable = 0;
  let complete = true;

  scan: for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const directoryEntry = queue[cursor];
    let handle;
    try {
      const directoryStat = await read(lstat(directoryEntry.absolute));
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        if (cursor === 0) throw new Error('The selected root must be a directory, not a symbolic link.');
        continue;
      }
      if (options.excludePaths?.some((excluded) => directoryEntry.relative === excluded || directoryEntry.relative.startsWith(excluded + '/'))) continue;
      if (directoryEntry.relative !== '.') {
        let marker;
        try { marker = await read(lstat(path.join(directoryEntry.absolute, '.git'))); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        if (marker && !marker.isSymbolicLink() && (marker.isDirectory() || marker.isFile())) {
          repoDirectories.push({ path: directoryEntry.relative, marker: marker.isDirectory() ? 'dir' : 'file' });
          if (options.stopAtRepos && (!stopPaths || stopPaths.has(directoryEntry.relative))) continue;
        }
      }
      directories.push(directoryEntry.relative);
      handle = await bounded(opendir(directoryEntry.absolute), deadline, options.signal, (late) => { late.close().catch(() => {}); });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error instanceof ScanBudget) { truncated = true; complete = false; break; }
      if (cursor === 0) throw error;
      unreadable += 1;
      complete = false;
      continue;
    }
    try {
    while (true) {
      const entry = await bounded(handle.read(), startedAt + discoveryBudgetMs, options.signal);
      if (!entry) break;
      inspected += 1;
      if (inspected > maxEntries || Date.now() - startedAt > discoveryBudgetMs) {
        truncated = true;
        complete = false;
        break scan;
      }
      if (entry.isSymbolicLink() || isIgnored(entry.name, entry.isDirectory())) continue;
      const absolute = path.join(directoryEntry.absolute, entry.name);
      const relative = path.relative(rootPath, absolute).split(path.sep).join('/');
      let metadata = entry;
      // Directory entries normally tell us the type without a per-file stat.
      // Stat directories again before enqueueing; stat selected files below.
      if (entry.isDirectory() || !entry.isFile()) {
        try {
          metadata = await read(lstat(absolute));
        } catch (error) {
          if (error.name === 'AbortError' || error instanceof ScanBudget) throw error;
          unreadable += 1;
          complete = false;
          continue;
        }
      }
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        if (isIgnored(entry.name, true)) continue;
        if (directoryEntry.depth >= maxDepth) {
          truncated = true;
          complete = false;
        } else {
          queue.push({ absolute, relative, depth: directoryEntry.depth + 1 });
        }
        continue;
      }
      if (!metadata.isFile()) continue;
      candidates.push({ absolute, relative, parent: directoryEntry.relative, name: entry.name });
    }
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error instanceof ScanBudget) { truncated = true; complete = false; break; }
      if (cursor === 0) throw error;
      unreadable += 1; complete = false;
    } finally { handle.close().catch(() => {}); }
  }

  // Share the file budget among top-level folders, so a large dependency-free
  // folder cannot consume all 2,500 map objects before its neighbors appear.
  const byDistrict = new Map();
  for (const candidate of candidates) {
    const district = candidate.relative.includes('/') ? candidate.relative.split('/')[0] : '.';
    if (!byDistrict.has(district)) byDistrict.set(district, []);
    byDistrict.get(district).push(candidate);
  }
  const districts = [...byDistrict].sort(([a], [b]) => a.localeCompare(b))
    .map(([, files]) => files.sort((a, b) => a.relative.localeCompare(b.relative)));
  const selected = [];
  for (let round = 0; selected.length < Math.min(maxFiles, candidates.length); round += 1) {
    for (const district of districts) {
      if (district[round]) selected.push(district[round]);
      if (selected.length >= maxFiles) break;
    }
  }
  let omittedIsLowerBound = !complete;
  const omitted = candidates.length - selected.length;
  if (omitted > 0) {
    truncated = true;
    complete = false;
  }
  for (const candidate of selected) {
    if (Date.now() - startedAt > maxDurationMs) {
      truncated = true;
      complete = false;
      break;
    }
    let stat;
    try {
      stat = await read(lstat(candidate.absolute));
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (error instanceof ScanBudget) { truncated = true; complete = false; break; }
      unreadable += 1;
      complete = false;
      omittedIsLowerBound = true;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const file = {
      id: candidate.relative,
      path: candidate.relative,
      name: candidate.name,
      parent: candidate.parent,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      extension: path.extname(candidate.name).toLowerCase().replace(/^\./, ''),
    };
    records.set(candidate.relative, {
      file,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      identity: stat.ino > 0 && stat.birthtimeMs > 0
        ? `${stat.dev}:${stat.ino}:${stat.birthtimeMs}` : null,
    });
  }
  const files = [...records.values()].map((record) => record.file)
    .sort((a, b) => a.path.localeCompare(b.path));
  const subtreeBytes = Object.fromEntries(directories.map((directory) => [directory, 0]));
  for (const file of files) {
    let parent = file.parent;
    while (true) {
      subtreeBytes[parent] = (subtreeBytes[parent] || 0) + file.size;
      if (parent === '.') break;
      parent = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '.';
    }
  }
  return {
    world: {
      root: { name: path.basename(rootPath) || rootPath, path: rootPath },
      scannedAt: new Date().toISOString(),
      files,
      truncated,
      omitted: candidates.length - records.size,
      omittedIsLowerBound,
      unreadable,
      directories, repoDirectories, subtreeBytes,
    },
    records,
    complete,
    directories, repoDirectories, subtreeBytes,
  };
}

/** An incomplete scan never manufactures creation, deletion, or move events. */
export function diffSnapshots(previous, current) {
  if (!previous) return [];
  const events = [];
  const at = current.world.scannedAt;
  const event = (type, filePath, extra = {}) => ({
    id: randomUUID(), type, path: filePath, ...extra, at,
  });
  for (const [filePath, record] of current.records) {
    const before = previous.records.get(filePath);
    if (before && (before.mtimeMs !== record.mtimeMs || before.ctimeMs !== record.ctimeMs || before.file.size !== record.file.size || before.identity !== record.identity)) {
      events.push(event('modified', filePath, { beforeSize: before.file.size, afterSize: record.file.size }));
    }
  }
  if (!previous.complete || !current.complete) return events;
  const removed = new Map([...previous.records].filter(([key]) => !current.records.has(key)));
  const added = new Map([...current.records].filter(([key]) => !previous.records.has(key)));
  const identityCounts = (records) => {
    const counts = new Map();
    for (const record of records.values()) {
      if (record.identity) counts.set(record.identity, (counts.get(record.identity) ?? 0) + 1);
    }
    return counts;
  };
  const beforeCounts = identityCounts(previous.records);
  const afterCounts = identityCounts(current.records);
  const removedByIdentity = new Map([...removed].map(([key, record]) => [record.identity, key]));
  for (const [filePath, record] of added) {
    const previousPath = record.identity && removedByIdentity.get(record.identity);
    if (previousPath && beforeCounts.get(record.identity) === 1 && afterCounts.get(record.identity) === 1) {
      events.push(event('moved', filePath, { previousPath, beforeSize: removed.get(previousPath).file.size, afterSize: record.file.size }));
      removed.delete(previousPath);
    } else {
      events.push(event('created', filePath, { beforeSize: 0, afterSize: record.file.size }));
    }
  }
  for (const [filePath, record] of removed) events.push(event('deleted', filePath, { beforeSize: record.file.size, afterSize: 0 }));
  return events;
}

/** Concurrent browser requests share one scan; history exists only in memory. */
export function createWorldReader(directory, options = {}) {
  let previous = null;
  let events = [];
  let pending = null;
  return function readWorld() {
    if (pending) return pending;
    pending = (async () => {
      const current = await scanDirectory(directory, options);
      events = [...diffSnapshots(previous, current).reverse(), ...events].slice(0, 40);
      previous = current;
      return { ...current.world, events };
    })().finally(() => { pending = null; });
    return pending;
  };
}
