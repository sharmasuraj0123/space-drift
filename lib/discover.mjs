import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import * as C from '../public/constants.js';
import { finalizeDiscovery } from '../public/universe-core.js';
import { isIgnored } from './scan.mjs';

class DiscoveryBudget extends Error {}
async function beforeDeadline(operation, deadline) {
  let timeout;
  try {
    return await Promise.race([operation, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new DiscoveryBudget()), Math.max(0, deadline - Date.now())); })]);
  } finally { clearTimeout(timeout); }
}

export async function repositoryMarker(directory) {
  try {
    const metadata = await lstat(path.join(directory, '.git'));
    return metadata.isSymbolicLink() ? null : metadata.isDirectory() ? 'dir' : metadata.isFile() ? 'file' : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Read marker names and directory metadata only; gitdir targets are not traversed. */
export async function discoverPlanets(root, { depth = C.PLANET_SEARCH_DEPTH || 3, maxPlanets = C.MAX_PLANETS || 64, budgetMs = C.DISCOVERY_MS || 2000, maxEntries = 25000 } = {}) {
  const rootPath = path.resolve(root);
  const deadline = Date.now() + Math.max(0, budgetMs);
  const queue = [{ absolute: rootPath, relative: '', depth: 0 }];
  const repositories = [];
  let rootMarker = null; let truncated = false; let inspected = 0; let incomplete = false;
  discovery: for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (Date.now() >= deadline) { truncated = true; incomplete = true; break; }
    try {
      const state = await beforeDeadline(lstat(current.absolute), deadline);
      if (!state.isDirectory() || state.isSymbolicLink()) {
        if (cursor === 0) throw new Error('Select a directory, not a symbolic link.');
        continue;
      }
      const marker = await beforeDeadline(repositoryMarker(current.absolute), deadline);
      if (cursor === 0) rootMarker = marker;
      else if (marker) {
        repositories.push({ path: current.relative, name: path.basename(current.absolute), marker, depth: current.depth });
        continue;
      }
      const entries = await beforeDeadline(readdir(current.absolute, { withFileTypes: true }), deadline);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++inspected > maxEntries || Date.now() >= deadline) { truncated = true; incomplete = true; break discovery; }
        if (entry.isSymbolicLink() || !entry.isDirectory() || isIgnored(entry.name, true)) continue;
        if (current.depth >= depth) { truncated = true; continue; }
        queue.push({ absolute: path.join(current.absolute, entry.name), relative: current.relative ? `${current.relative}/${entry.name}` : entry.name, depth: current.depth + 1 });
      }
    } catch (error) {
      if (error instanceof DiscoveryBudget) { truncated = true; incomplete = true; break; }
      if (cursor === 0) throw error;
      truncated = true; incomplete = true;
    }
  }
  return { ...finalizeDiscovery({ rootName: path.basename(rootPath), rootIsRepo: !!rootMarker, rootMarker, repositories, truncated, maxPlanets, depth }), incomplete };
}
