import { createDirectorySource } from './folder-source.js';

export const SAMPLE_LANDING_PATH = 'observatory';
export const SAMPLE_FILE_PATH = `${SAMPLE_LANDING_PATH}/README.md`;

const NAME = 'Kepler sample';
const LIMITATION = 'Built-in sample files held in memory. This fixed example contains no personal files, live changes, or Git history.';
const HOUR = 3600000;
const TYPES = { md: 'text/markdown', txt: 'text/plain', js: 'text/javascript', json: 'application/json', csv: 'text/csv', svg: 'image/svg+xml' };

function directory(name) {
  const children = new Map();
  const missing = () => Object.assign(new Error('This sample entry does not exist.'), { name: 'NotFoundError' });
  const lookup = (name, kind, options) => {
    if (options?.create) throw Object.assign(new Error('Sample files are read-only.'), { name: 'NotAllowedError' });
    const entry = children.get(name);
    if (entry?.kind !== kind) throw missing();
    return entry;
  };
  return {
    kind: 'directory', name, children,
    async *entries() { yield* [...children].sort(([a], [b]) => a.localeCompare(b)); },
    async getDirectoryHandle(name, options) { return lookup(name, 'directory', options); },
    async getFileHandle(name, options) { return lookup(name, 'file', options); },
  };
}

function illustration(label, accent, phase) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400" role="img" aria-label="${label}">
<rect width="640" height="400" rx="24" fill="#080b18"/>
<g fill="none" stroke="#526680"><ellipse cx="320" cy="185" rx="210" ry="80" transform="rotate(-18 320 185)"/><ellipse cx="320" cy="185" rx="140" ry="120" transform="rotate(30 320 185)"/></g>
<circle cx="320" cy="185" r="60" fill="${accent}"/><circle cx="${440 + phase * 16}" cy="${128 + phase * 17}" r="13" fill="#e5eaff"/>
<g fill="#aab8ff"><circle cx="105" cy="75" r="2"/><circle cx="555" cy="270" r="2"/><circle cx="160" cy="310" r="3"/></g>
<text x="36" y="365" fill="#eef2ff" font-family="sans-serif" font-size="21">${label}</text>
</svg>`;
}

/** A private, fresh File tree: no picker, permission request, disk, or network. */
function sampleTree() {
  const root = directory(NAME);
  const createdAt = Date.now();
  const folder = relative => relative.split('/').reduce((parent, name) => {
    if (!parent.children.has(name)) parent.children.set(name, directory(name));
    return parent.children.get(name);
  }, root);
  const add = (relative, content, ageHours = 0) => {
    const parts = relative.split('/');
    const name = parts.pop();
    const parent = parts.length ? folder(parts.join('/')) : root;
    const file = new File([content], name, { type: TYPES[name.split('.').at(-1)] || 'text/plain', lastModified: createdAt - ageHours * HOUR });
    parent.children.set(name, { kind: 'file', name, async getFile() { return file; } });
  };
  for (const name of ['observatory', 'orbital-engine', 'field-notes']) folder(`${name}/.git`);

  add('flight-plan.md', '# Kepler flight plan\n\n1. Visit the observatory.\n2. Land and open its README.md.\n3. Explore a folder of signals.\n4. Lift off and visit the other worlds.\n\nThis built-in workspace is a fictional example. Your own folders are connected separately.\n', 2);
  add('field-guide.txt', 'A workspace in miniature\n\nRepositories become planets. Folders become molecules. Files become atoms.\nMass follows file size. This fixed sample has no live edits or Git history.\nOpen a file to read its contents; close the viewer to continue flying.\n', 24);
  add('mission.json', JSON.stringify({ name: 'Kepler', synthetic: true, worlds: ['observatory', 'orbital-engine', 'field-notes'], firstLanding: SAMPLE_LANDING_PATH }, null, 2), 8);

  add(SAMPLE_FILE_PATH, '# Welcome to the observatory\n\nYou have opened your first file in the Kepler sample.\n\n> A folder is a world. Every file is a place worth exploring.\n\nUse **Preview** to read, or **Source** to see the original text. Press **Escape** to return to your ship.\n\n## A map you can read\n\nEvery object here comes from a small, fictional workspace held in memory. No personal folder was opened to create this world.\n\n- signals contains synthetic spectra: CSV files with wavelength and intensity.\n- observations contains field notes from imaginary nights under the stars.\n- gallery contains original SVG illustration source files.\n- instruments contains small JSON descriptions of the equipment.\n\n| On your map | In your folder |\n| --- | --- |\n| Planet | A project or repository |\n| Molecule | A folder |\n| Atom | A file you can open |\n\n### Your next discovery\n\n- [x] Open the observatory README\n- [ ] Explore a signal table\n- [ ] Read an observation\n\nClose this file to return to your ship. Explore a folder, or lift off to visit orbital-engine and field-notes.\n\nWhen you are ready, connect your own folder to explore its map. Your files stay on your device.\n', .5);
  for (const [index, name] of ['first-light', 'quiet-moon', 'blue-hour'].entries()) {
    add(`observatory/observations/${name}.md`, `# ${name.replaceAll('-', ' ')}\n\nFictional observation ${index + 1}.\n\n` + [
      'The telescope settled on a quiet patch of sky. We recorded a reference spectrum before opening the shutter.\n',
      'A pale moon crossed the field. The guide star remained steady, and the crew marked the clearest interval.\n',
      'At the edge of dawn, the last exposure captured a blue band above the horizon. We saved the chart for comparison.\n',
    ][index].repeat(index + 1) + '\nThese notes belong to the built-in sample; they are not real observations.\n', 12 + index * 36);
  }
  for (let index = 0; index < 4; index++) {
    const rows = Array.from({ length: 36 + index * 24 }, (_, step) => `${380 + step * 3},${(.52 + Math.sin(step / 8 + index) * .31).toFixed(4)}`);
    add(`observatory/signals/spectrum-${String(index + 1).padStart(2, '0')}.csv`, 'wavelength_nm,synthetic_intensity\n' + rows.join('\n') + '\n', 1 + index * 18);
  }
  add('observatory/gallery/blue-planet.svg', illustration('Blue planet · sample illustration', '#68e4ef', 0), 48);
  add('observatory/gallery/lunar-orbit.svg', illustration('Lunar orbit · sample illustration', '#aab8ff', 1), 120);
  add('observatory/instruments/telescope.json', JSON.stringify({ name: 'Kepler reference telescope', synthetic: true, apertureMm: 240, mode: 'wide field', filters: ['clear', 'blue', 'red'] }, null, 2), 72);
  add('observatory/instruments/spectrometer.json', JSON.stringify({ name: 'Prism bench', synthetic: true, rangeNm: [380, 740], calibration: 'illustrative only' }, null, 2), 96);

  add('orbital-engine/README.md', '# Orbital engine\n\nA few small, readable navigation experiments. These sample modules contain pure calculations; opening them only displays their text.\n\nExplore src for code, routes for waypoint data, docs for design notes, and assets for a flight diagram.\n', 3);
  add('orbital-engine/package.json', JSON.stringify({ name: 'kepler-navigation-sample', private: true, type: 'module', main: 'src/vector.js', description: 'Fictional, dependency-free example source files for Space Drift.' }, null, 2), 20);
  add('orbital-engine/src/vector.js', '// A small vector toolkit for the fictional Kepler mission.\nexport const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });\nexport const length = v => Math.hypot(v.x, v.y, v.z);\nexport const scale = (v, amount) => ({ x: v.x * amount, y: v.y * amount, z: v.z * amount });\n', 6);
  add('orbital-engine/src/orbit.js', '// Sample circular path in a horizontal plane.\nexport function orbitPoint(radius, phase) {\n  return { x: Math.cos(phase) * radius, y: 0, z: Math.sin(phase) * radius };\n}\n\nexport function lapTime(radius, speed) {\n  return speed > 0 ? 2 * Math.PI * radius / speed : Infinity;\n}\n', 18);
  add('orbital-engine/src/approach.js', '// Ease toward a landing site; this sample is displayed, never executed.\nexport function approachSpeed(distance, cruiseSpeed = 24) {\n  const fraction = Math.max(0, Math.min(1, distance / 60));\n  return cruiseSpeed * fraction * fraction;\n}\n', 42);
  add('orbital-engine/src/compass.js', '// Heading to a point in the Kepler coordinate system.\nexport function heading(position, target) {\n  return Math.atan2(position.x - target.x, position.z - target.z);\n}\n\nexport const degrees = radians => radians * 180 / Math.PI;\n', 64);
  for (const [index, name] of ['arrival', 'survey-loop', 'homeward'].entries()) {
    add(`orbital-engine/routes/${name}.json`, JSON.stringify({ name, synthetic: true, waypoints: Array.from({ length: 5 + index * 4 }, (_, step) => ({ x: step * 8, y: 12 + step % 3, z: Math.round(Math.sin(step / 3) * 28) })) }, null, 2), 10 + index * 30);
  }
  add('orbital-engine/docs/coordinates.md', '# Coordinates\n\nThe example routes use a flat local frame. X and Z describe position across the map; Y is altitude. Distances are game units.\n\nWaypoint lists are deliberately short so they remain easy to read in flight.\n', 84);
  add('orbital-engine/docs/landing.md', '# A gentle arrival\n\nApproach a destination, leave room to turn, and reduce speed before landing. On the surface, stop near an atom to open its file.\n\nThese are notes for exploring the sample game, not instructions for a real vehicle.\n', 156);
  add('orbital-engine/assets/flight-path.svg', illustration('Flight path · sample illustration', '#c4a5ff', 2), 32);

  add('field-notes/README.md', '# Field notes\n\nA tiny expedition library: imaginary travel journals, synthetic catalogue tables, illustrations, and checklists.\n\nTry comparing the shapes and sizes of document, data, and image atoms. Every file is safe to open in the viewer.\n', 4);
  for (const [index, name] of ['copper-dunes', 'frozen-bay', 'violet-ridge', 'return-at-dawn'].entries()) {
    add(`field-notes/expeditions/${name}.md`, `# ${name.replaceAll('-', ' ')}\n\nEntry ${index + 1} from a fictional expedition.\n\n` + [
      'Copper-colored dunes stretched toward a low ridge. The team sketched the horizon and recorded a quiet wind.\n',
      'At the frozen bay, shallow fractures caught the light. We followed a marked path and drew the shore from above.\n',
      'Violet shadows filled the valley. The field notebook held a map, a few color studies, and a route home.\n',
      'The crew returned at dawn with a small collection of notes. Each observation became another point on the workspace map.\n',
    ][index].repeat(index + 1) + '\nAll locations and events in this sample are invented.\n', 30 + index * 50);
  }
  for (const [index, name] of ['horizons', 'minerals', 'waypoints'].entries()) {
    add(`field-notes/catalogue/${name}.csv`, 'sample_id,x,z,relative_brightness\n' + Array.from({ length: 28 + index * 20 }, (_, step) => `K${String(step + 1).padStart(3, '0')},${step * 4},${Math.round(Math.cos(step / 5) * 30)},${(.3 + (step % 9) / 15).toFixed(2)}`).join('\n') + '\n', 40 + index * 24);
  }
  add('field-notes/illustrations/distant-moon.svg', illustration('Distant moon · sample illustration', '#ffad9b', 3), 100);
  add('field-notes/illustrations/ice-world.svg', illustration('Ice world · sample illustration', '#bec9e6', 4), 168);
  add('field-notes/checklists/departure.txt', 'SAMPLE EXPEDITION — DEPARTURE\n\n[ ] Choose a destination in the atlas\n[ ] Leave room for the approach\n[ ] Land and inspect a file\n[ ] Mark the next place to explore\n', 14);
  add('field-notes/checklists/return.txt', 'SAMPLE EXPEDITION — RETURN\n\n[ ] Close the file viewer\n[ ] Lift off from the surface\n[ ] Visit another world\n[ ] Connect your own folder when ready\n\nNo sample files are written to your disk.\n', 58);
  return root;
}

/** Adapt the ordinary directory survey/viewer pipeline to an immutable example. */
export function createSampleSource() {
  const source = createDirectorySource(sampleTree(), { name: NAME, live: false });
  const spaceMetadata = space => ({ ...space, discovery: { ...space.discovery, limitation: LIMITATION }, bodies: space.bodies.map(body => ({ ...body, git: { ...body.git, reason: 'sample' } })) });
  return {
    ...source, kind: 'sample', live: false,
    async readSpace(options) {
      const space = await source.readSpace(options);
      // The fixed sample has no refresh timer: finish its tiny survey before
      // presenting the atlas, so every world and file is immediately reachable.
      await Promise.all(space.bodies.map(body => source.readPlanet(body.id, options)));
      return spaceMetadata(await source.readSpace(options));
    },
    async readPlanet(id, options) { const planet = await source.readPlanet(id, options); return { ...planet, git: { ...planet.git, reason: 'sample' } }; },
    async tick(options) { return spaceMetadata(await source.tick(options)); },
  };
}
