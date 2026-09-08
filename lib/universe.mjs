import path from 'node:path';
import { lstat, opendir, open } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import * as C from '../public/constants.js';
import { createSurveyUniverse } from '../public/universe-reader.js';
import { readWorkspaceMetadata } from '../public/workspace-metadata.js';
import { discoverPlanets, repositoryMarker } from './discover.mjs';
import { scanDirectory } from './scan.mjs';
import { readRepoChurn } from './git.mjs';

const join = (base, relative) => relative ? `${base}/${relative}` : base;
const within = (file, directory) => file === directory || file.startsWith(directory + '/');
const aborted = (signal) => { if (signal?.aborted) throw Object.assign(new Error('Disconnected workspace.'), { name: 'AbortError' }); };

/** Local filesystem adapter. All public IDs remain relative to the selected root. */
export function createUniverseReader(root, options = {}) {
  const rootPath = path.resolve(root);
  const scanOptions = { ...options.scannerOptions, maxDurationMs: options.scannerOptions?.maxDurationMs ?? C.PLANET_SCAN_MS };
  const scanner = options.scanDirectory || scanDirectory;
  const scanBody = async (body, topology, { signal }) => {
    aborted(signal);
    if (body.kind !== 'overflow') {
      const excluded = body.kind === 'belt' ? [...topology.planets, ...topology.overflow].map((repo) => repo.path) : [];
      return scanner(path.join(rootPath, body.path), { ...scanOptions, signal, stopAtRepos: body.kind === 'belt', repoStopPaths: excluded, excludePaths: excluded });
    }
    const deadline = Date.now() + scanOptions.maxDurationMs;
    const members = topology.overflow;
    const result = { world: { root: { name: body.name, path: rootPath }, scannedAt: new Date().toISOString(), files: [], truncated: false, omitted: 0, unreadable: 0, omittedIsLowerBound: false }, records: new Map(), complete: true, directories: ['.'], repoDirectories: [] };
    let remaining = scanOptions.maxFiles ?? 2500;
    let entries = scanOptions.maxEntries ?? 25000;
    for (let i = 0; i < members.length; i += 1) {
      aborted(signal);
      const member = members[i];
      result.directories.push(member.path); result.repoDirectories.push({ path: member.path, marker: member.marker });
      if (Date.now() >= deadline || remaining <= 0 || entries <= 0) { result.complete = false; result.world.truncated = true; result.world.omittedIsLowerBound = true; continue; }
      const budget = Math.max(1, Math.floor((deadline - Date.now()) / (members.length - i)));
      const fileQuota = Math.ceil(remaining / (members.length - i));
      const entryQuota = Math.ceil(entries / (members.length - i));
      const current = await scanner(path.join(rootPath, member.path), { ...scanOptions, signal, maxFiles: fileQuota, maxEntries: entryQuota, maxDurationMs: budget });
      remaining -= current.world.files.length; entries -= entryQuota;
      for (const file of current.world.files) {
        const relative = join(member.path, file.path);
        const translated = { ...file, id: relative, path: relative, parent: file.parent === '.' ? member.path : join(member.path, file.parent) };
        result.world.files.push(translated); result.records.set(relative, { ...current.records.get(file.path), file: translated });
      }
      result.directories.push(...current.directories.filter((value) => value !== '.').map((value) => join(member.path, value)));
      result.repoDirectories.push(...current.repoDirectories.map((repo) => ({ ...repo, path: join(member.path, repo.path) })));
      result.complete &&= current.complete;
      result.world.truncated ||= current.world.truncated;
      result.world.omitted += current.world.omitted; result.world.unreadable += current.world.unreadable;
      result.world.omittedIsLowerBound ||= current.world.omittedIsLowerBound;
    }
    return result;
  };

  const readGit = async (body, snapshot, topology, { signal, now }) => {
    const bodyRoot = path.join(rootPath, body.path);
    const rootMarker = body.kind === 'planet' ? body.marker || await repositoryMarker(bodyRoot) : body.kind === 'belt' && topology.rootIsRepo;
    const nested = [...(snapshot.repoDirectories || [])].sort((a, b) => a.path.localeCompare(b.path));
    const scopes = [...(rootMarker ? [{ path: '', marker: rootMarker }] : []), ...nested.map((repo) => ({ ...repo, path: repo.path === '.' ? '' : repo.path }))];
    if (!scopes.length) return { ok: false, reason: 'not-a-work-tree', collectedAt: now };
    const deepest = [...scopes].sort((a, b) => b.path.length - a.path.length);
    const primary = body.kind === 'overflow' ? new Set(topology.overflow.map((repo) => repo.path)) : new Set(rootMarker ? [''] : []);
    let nestedCount = 0;
    const selected = scopes.filter((scope) => primary.has(scope.path) || nestedCount++ < C.MAX_NESTED_REPOS);
    const deadline = Date.now() + (options.gitBudgetMs ?? C.GIT_BUDGET_MS);
    const merged = { ok: false, head: null, branch: null, dirty: 0, lastCommitAt: null, lines: new Map(), files: new Map(), tracked: new Set(), collectedAt: now, partial: selected.length < scopes.length, reason: 'unavailable' };
    for (const [scopeIndex, scope] of selected.entries()) {
      aborted(signal);
      const budgetMs = Math.floor((deadline - Date.now()) / (selected.length - scopeIndex));
      if (budgetMs <= 0) { merged.partial = true; break; }
      const files = snapshot.world.files.filter((file) => deepest.find((candidate) => !candidate.path || within(file.path, candidate.path)) === scope);
      if (!files.length) continue;
      const metadata = new Map(files.map((file) => [scope.path ? file.path.slice(scope.path.length + 1) : file.path, file]));
      const git = await (options.readRepoChurn || readRepoChurn)(path.join(bodyRoot, scope.path), { now, signal, budgetMs, metadata, execute: options.gitExecutor });
      if (!git.ok) { merged.partial = true; merged.reason = git.reason; continue; }
      merged.ok = true; merged.reason = null;
      if (!merged.head) { merged.head = git.head; merged.branch = git.branch; }
      for (const [relative, meta] of metadata) {
        const local = scope.path ? join(scope.path, relative) : relative;
        if (git.lines.has(relative)) merged.lines.set(local, git.lines.get(relative));
        if (git.tracked.has(relative)) merged.tracked.add(local);
        const value = git.files.get(relative);
        if (value) {
          merged.files.set(local, value);
          if (value.status !== 'clean') merged.dirty += 1;
          if (value.lastCommitAt && (!merged.lastCommitAt || value.lastCommitAt > merged.lastCommitAt)) merged.lastCommitAt = value.lastCommitAt;
        }
      }
    }
    return merged;
  };

  async function checkedMetadataPath(relative, directory = false, read = (operation) => operation) {
    if (typeof relative !== 'string' || relative.split('/').some((part) => !part || part === '..' || part === '.' || /[\\\0]/.test(part))) throw new Error('Unavailable metadata path.');
    const selected = await read(lstat(rootPath));
    if (!selected.isDirectory() || selected.isSymbolicLink()) throw new Error('Unavailable metadata root.');
    let current = rootPath;
    const parts = relative.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      current = path.join(current, parts[i]); const state = await read(lstat(current));
      if (state.isSymbolicLink() || ((i < parts.length - 1 || directory) && !state.isDirectory())) throw new Error('Unavailable metadata path.');
      if (i === parts.length - 1 && !directory && !state.isFile()) throw new Error('Metadata must be a regular file.');
    }
    return current;
  }
  const readMetadata = (bodies, { signal }) => {
    const deadline = Date.now() + 10000;
    const read = (operation, closeLate) => new Promise((resolve, reject) => {
      let done = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      const fail = (error) => { if (done) return; done = true; cleanup(); reject(error); };
      const cancel = () => fail(Object.assign(new Error('Metadata cancelled.'), { name: 'AbortError' }));
      const timer = setTimeout(() => fail(Object.assign(new Error('Metadata time limit reached.'), { name: 'BudgetError' })), Math.max(0, deadline - Date.now()));
      signal?.addEventListener('abort', cancel, { once: true });
      Promise.resolve(operation).then((value) => { if (done) { closeLate?.(value); return; } done = true; cleanup(); resolve(value); }, fail);
      if (signal?.aborted) cancel();
      else if (Date.now() >= deadline) fail(Object.assign(new Error('Metadata time limit reached.'), { name: 'BudgetError' }));
    });
    return readWorkspaceMetadata(bodies, {
    signal,
    list: async (relative) => {
      const absolute = await checkedMetadataPath(relative, true, read);
      const directory = await read(opendir(absolute), (late) => { late.close().catch(() => {}); });
      const names = [];
      try {
        for (let inspected = 0; inspected < 256; inspected += 1) {
          const entry = await read(directory.read()); if (!entry) break;
          if (entry.isFile() && !entry.isSymbolicLink() && !entry.name.startsWith('.') && /\.json$/i.test(entry.name)) names.push(entry.name);
          if (names.length === 64 || inspected === 255) { names.truncated = true; break; }
        }
        return names;
      } finally { directory.close().catch(() => {}); }
    },
    read: async (relative, limit) => {
      aborted(signal); const absolute = await checkedMetadataPath(relative, false, read);
      const before = await read(lstat(absolute));
      const handle = await read(open(absolute, FS.O_RDONLY | (FS.O_NOFOLLOW || 0) | (FS.O_NONBLOCK || 0)), (late) => { late.close().catch(() => {}); });
      try {
        const state = await read(handle.stat());
        if (!state.isFile() || state.size > limit) throw new Error('Metadata is too large.');
        await checkedMetadataPath(relative, false, read);
        const after = await read(lstat(absolute));
        if (before.dev !== state.dev || before.ino !== state.ino || after.dev !== state.dev || after.ino !== state.ino) throw new Error('Metadata changed while opening.');
        const buffer = Buffer.alloc(state.size); const { bytesRead } = await read(handle.read(buffer, 0, buffer.length, 0));
        aborted(signal); return { text: buffer.subarray(0, bytesRead).toString('utf8'), size: bytesRead };
      } finally { handle.close().catch(() => {}); }
    },
  });
  };
  return createSurveyUniverse({ root: { name: path.basename(rootPath), path: rootPath }, discover: options.discover || (({ signal }) => { aborted(signal); return discoverPlanets(rootPath, options.discoveryOptions); }), scanBody: options.scanBody || scanBody, readGit: options.git === false ? undefined : readGit, readMetadata, now: options.now, options });
}
