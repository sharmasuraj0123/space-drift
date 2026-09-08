import * as C from './constants.js';
import { bodyColor, emissionColor } from './light.js';

const SOURCE = new Set('js mjs cjs ts tsx jsx py rb rs go java kt kts c h cc cpp hpp cs swift sh bash zsh fish vue svelte astro sql r css scss sass less'.split(' '));
const MARKUP = new Set('md mdx markdown rst adoc html htm xml tex txt'.split(' '));
const DATA = new Set('json jsonl ndjson geojson csv tsv yaml yml toml ini conf cfg log graphql gql proto'.split(' '));
const IMAGE = new Set('png jpg jpeg gif webp avif bmp ico svg'.split(' '));
const MEDIA = new Set('pdf mp3 wav ogg opus flac m4a aac mp4 webm mov ogv'.split(' '));
const BINARY = new Set('docx xlsx pptx odt zip gz tgz tar 7z wasm exe dll dylib so bin o class jar'.split(' '));
const TEXT_NAMES = new Set('readme license licence notice authors changelog makefile dockerfile procfile gemfile rakefile'.split(' '));
const FALLBACK_COLORS = { source: 0x68e4ef, markup: 0xffad9b, data: 0xc4a5ff, image: 0xf29bd3, media: 0x77b9ff, binary: 0xaab8ff, other: 0xd0d6e6 };
export const timeMs = (value) => typeof value === 'number' ? value : Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const nonnegative = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const halfLife = () => C.HALF_LIFE_MS || 259200000;
export const canonicalAtomId = (bodyPath, relativePath) => bodyPath ? `${bodyPath}/${relativePath}` : relativePath;
export const repositoryId = (relativePath) => relativePath === '__belt__' || relativePath === '__overflow__' || relativePath.startsWith('~') ? `~${relativePath}` : relativePath;

export function classifyElement(name) {
  const base = String(name || '').split('/').at(-1).toLowerCase();
  const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (TEXT_NAMES.has(base) || MARKUP.has(ext)) return 'markup';
  for (const [table, element] of [[SOURCE, 'source'], [DATA, 'data'], [IMAGE, 'image'], [MEDIA, 'media'], [BINARY, 'binary']]) if (table.has(ext)) return element;
  return 'other';
}

export function elementColor(element) {
  const value = (C.ELEMENT_COLORS || FALLBACK_COLORS)[element] ?? FALLBACK_COLORS.other;
  return Array.isArray(value) ? [...value] : [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
}

/** Pure hierarchy construction; molecule ids are body-relative, atom ids root-relative. */
export function groupIntoMolecules(files = [], repoDirectories = [], { directories = [], at = 0 } = {}) {
  const byId = new Map();
  const ensure = (id) => {
    if (byId.has(id)) return byId.get(id);
    const parentId = id === '.' ? null : id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '.';
    const entry = { id, path: id, name: id === '.' ? 'Root' : id.split('/').at(-1), parentId, moleculeIds: [], atomIds: [], atomCount: 0, elements: {}, molecularMass: 0, excitation: 0, excitationAt: new Date(timeMs(at)).toISOString(), xi: 0, repo: false, worktree: false };
    byId.set(id, entry);
    if (parentId !== null) ensure(parentId).moleculeIds.push(id);
    return entry;
  };
  ensure('.');
  for (const directory of directories) ensure(typeof directory === 'string' ? directory : directory.path);
  for (const repository of repoDirectories) {
    const id = typeof repository === 'string' ? repository : repository.path;
    if (!id || id === '.') continue;
    const molecule = ensure(id); molecule.repo = true; molecule.worktree = repository.marker === 'file';
  }
  const seen = new Set();
  const atoms = [];
  for (const file of [...files].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    const filePath = file.path;
    const id = file.id || filePath;
    if (!filePath || seen.has(id)) continue;
    seen.add(id);
    const moleculeId = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
    const mass = nonnegative(file.atomicMass ?? file.size);
    const excitation = nonnegative(file.excitation);
    const name = file.name || filePath.split('/').at(-1);
    const atom = { ...file, id, path: filePath, name, moleculeId, atomicMass: mass, element: file.element || classifyElement(name), excitation, excitationAt: file.excitationAt || new Date(timeMs(at)).toISOString(), xi: excitation / Math.max(mass, 1), lines: file.lines ?? Math.ceil(mass / (C.BYTES_PER_LINE || 40)), linesExact: !!file.linesExact, delta: nonnegative(file.delta), rho: Math.min(1, nonnegative(file.rho)), changedAt: file.changedAt || null, status: file.status || 'unknown' };
    atoms.push(atom);
    const molecule = ensure(moleculeId);
    molecule.atomIds.push(id); molecule.molecularMass += mass; molecule.excitation += excitation;
    molecule.atomCount += 1; molecule.elements[atom.element] = (molecule.elements[atom.element] || 0) + 1;
  }
  const reverse = [...byId.values()].sort((a, b) => b.id.split('/').length - a.id.split('/').length || (a.id === '.' ? 1 : b.id === '.' ? -1 : b.id.localeCompare(a.id)));
  for (const molecule of reverse) {
    molecule.atomIds.sort(); molecule.moleculeIds.sort();
    molecule.xi = molecule.excitation / Math.max(molecule.molecularMass, 1);
    if (molecule.parentId !== null) {
      const parent = byId.get(molecule.parentId);
      parent.molecularMass += molecule.molecularMass; parent.excitation += molecule.excitation;
      parent.atomCount += molecule.atomCount;
      for (const [element, count] of Object.entries(molecule.elements)) parent.elements[element] = (parent.elements[element] || 0) + count;
    }
  }
  return { atoms, molecules: [...byId.values()].sort((a, b) => a.id === '.' ? -1 : b.id === '.' ? 1 : a.id.localeCompare(b.id)) };
}

export function aggregateBody(molecules, atoms) {
  const root = molecules.find((molecule) => molecule.id === '.');
  const restMass = root?.molecularMass || 0;
  const excitation = root?.excitation || 0;
  const elements = Object.fromEntries(Object.keys(FALLBACK_COLORS).map((key) => [key, 0]));
  let color = [0, 0, 0]; let weight = 0;
  for (const atom of atoms) {
    elements[atom.element] = (elements[atom.element] || 0) + 1;
    const contribution = excitation > 0 ? atom.excitation : atom.atomicMass || 1;
    const rgb = elementColor(atom.element);
    color = color.map((value, index) => value + rgb[index] * contribution); weight += contribution;
  }
  color = weight ? color.map((value) => value / weight) : elementColor('other');
  const at = timeMs(root?.excitationAt);
  color = bodyColor({ color }, atoms, at);
  return { restMass, excitation, excitationAt: root?.excitationAt || new Date(0).toISOString(), xi: excitation / Math.max(restMass, 1), fileCount: atoms.length, moleculeCount: molecules.length, nestedRepos: molecules.filter((molecule) => molecule.repo).length, elements, color,
    hot: [...atoms].filter((atom) => atom.excitation > 0).sort((a, b) => b.excitation - a.excitation || a.id.localeCompare(b.id)).slice(0, 5).map(({ id, excitation: x }) => ({ id, excitation: x })),
    patches: molecules.filter((molecule) => molecule.parentId === '.').map((molecule) => ({ moleculeId: molecule.id, share: molecule.molecularMass / Math.max(restMass, 1), xi: molecule.xi, color: bodyColor({ color }, atoms.filter((atom) => atom.path.startsWith(molecule.id + '/')), at) })),
    crystals: [...atoms].sort((a, b) => b.atomicMass - a.atomicMass || a.id.localeCompare(b.id)).slice(0, 32).map((atom) => ({ id: atom.id, element: atom.element, atomicMass: atom.atomicMass, excitation: atom.excitation, excitationAt: atom.excitationAt, color: emissionColor(atom, at) })),
  };
}

/** Excitation is excess mass in bytes; chronological saturation precedes decay. */
export function replayLedger(atom, excitations = [], now = Date.now()) {
  const currentTime = timeMs(now);
  const mass = nonnegative(atom.atomicMass ?? atom.size);
  const lines = Math.max(nonnegative(atom.lines ?? Math.ceil(mass / (C.BYTES_PER_LINE || 40))), 1);
  let x = nonnegative(atom.excitation);
  let at = atom.excitationAt ? Math.min(currentTime, timeMs(atom.excitationAt)) : 0;
  let delta = excitations.length ? 0 : nonnegative(atom.delta); let rho = excitations.length ? 0 : Math.min(1, nonnegative(atom.rho)); let changedAt = atom.changedAt || null;
  for (const event of [...excitations].sort((a, b) => timeMs(a.at) - timeMs(b.at))) {
    const t = Math.min(currentTime, Math.max(at, timeMs(event.at)));
    const amount = nonnegative(event.delta);
    const ratio = Math.min(1, nonnegative(event.rho ?? amount / lines));
    x = Math.min(mass, x * 2 ** (-(t - at) / halfLife()) + mass * ratio);
    at = t; delta += amount; rho = ratio; changedAt = new Date(t).toISOString();
  }
  x *= 2 ** (-Math.max(0, currentTime - at) / halfLife());
  return { excitation: x, excitationAt: new Date(currentTime).toISOString(), delta, rho, changedAt };
}

/** Convert observed metadata changes to explicit estimates without reading content. */
export function snapshotExcitations(events = [], previousRecords = new Map()) {
  const lookup = (key) => previousRecords instanceof Map ? previousRecords.get(key) : previousRecords[key];
  return events.map((event) => {
    const before = lookup(event.previousPath || event.path);
    const previousSize = nonnegative(event.beforeSize ?? before?.atomicMass ?? before?.size ?? before?.file?.size);
    const currentSize = nonnegative(event.afterSize ?? previousSize);
    let rho = event.type === 'created' ? 1 : event.type === 'modified' ? Math.min(1, Math.max(Math.abs(currentSize - previousSize) / Math.max(previousSize, 1), C.RHO_TOUCH || .05)) : C.RHO_TOUCH || .05;
    if (event.type === 'deleted') rho = 0;
    return { ...event, delta: Math.abs(currentSize - previousSize), rho, cooling: event.type === 'deleted', carryFrom: event.type === 'moved' ? event.previousPath : null };
  });
}

/** Apply the root/belt/overflow ownership policy to discovered non-nested repos. */
export function finalizeDiscovery({ rootName, rootIsRepo = false, rootMarker = 'dir', repositories = [], truncated = false, maxPlanets = C.MAX_PLANETS || 64, depth = C.PLANET_SEARCH_DEPTH || 3, limitation = null }) {
  const ordered = [...repositories].sort((a, b) => a.path.localeCompare(b.path));
  const descriptor = (item) => ({ ...item, id: repositoryId(item.path), kind: 'planet', name: item.name || item.path.split('/').at(-1), constellation: item.path.includes('/') ? item.path.split('/')[0] : null });
  const planets = ordered.slice(0, maxPlanets).map(descriptor);
  const overflow = ordered.slice(maxPlanets).map(descriptor);
  let bodies;
  if (!ordered.length) bodies = [rootIsRepo ? { id: '.', kind: 'planet', path: '', name: rootName, marker: rootMarker, depth: 0, constellation: null } : { id: '__belt__', kind: 'belt', path: '', name: rootName, constellation: null }];
  else bodies = [...planets, ...(overflow.length ? [{ id: '__overflow__', kind: 'overflow', path: '', name: 'Other repositories', constellation: null, members: overflow }] : []), { id: '__belt__', kind: 'belt', path: '', name: 'Loose files', constellation: null, provisional: true }];
  return { planets, overflow, bodies, rootIsRepo, truncated, depth, maxPlanets, limitation };
}
