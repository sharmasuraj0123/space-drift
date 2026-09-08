import * as THREE from '/vendor/three.module.js';
import { buildWorld, stepShip, findNearestFile, findProbeTarget, createProbe, stepProbe, formatBytes, hash } from './model.js';
import { createFileViewer } from './viewer.js';
import { createDirectorySource, createSnapshotSource } from './folder-source.js';

const $ = (id) => document.getElementById(id);
const clamp = THREE.MathUtils.clamp;
const v = (p) => new THREE.Vector3(p.x, p.y, p.z);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const state = {
  world: null, snapshot: null, launched: false, paused: false, currents: true,
  ship: { position: { x: 0, y: 12, z: 70 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0 },
  charted: new Set(), visited: new Set(), destination: null, nearest: null,
  time: 0, fps: 60, signature: '', seenEvents: new Set(), loading: false,
  focusedFileId: null,
  reticle: { x: .5, y: .5 }, reticleTarget: null, probe: null, probeReadyAt: 0,
  disconnected: false,
  holding: false,
  source: null, sourceVersion: 0, loadAbort: null, choosing: false, connecting: false, selectionAbort: null,
  pickerVersion: 0, snapshotFallback: false,
};
const keys = new Set();
const tapUntil = new Map();
const fileViewer = createFileViewer({ getSource: () => state.source, onClose: () => { clearInput(); $('scene').focus({ preventScroll: true }); } });
const scene = new THREE.Scene();
scene.background = new THREE.Color('#080b18');
scene.fog = new THREE.FogExp2('#080b18', .00145);
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, .3, 2500);
camera.position.set(105, 103, 207);
camera.lookAt(0, 0, -100);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  $('scene').append(renderer.domElement);
} catch (error) {
  $('error').hidden = false;
  $('error-message').textContent = 'This game needs WebGL. Open it in a browser with hardware acceleration enabled.';
  throw error;
}
scene.add(new THREE.HemisphereLight(0xd3dcff, 0x1a1540, 2.5));
const sun = new THREE.DirectionalLight(0xf5f0ff, 3.2);
sun.position.set(-100, 200, 60); scene.add(sun);
const rim = new THREE.DirectionalLight(0xffad9b, 2.3);
rim.position.set(80, 40, -150); scene.add(rim);
const worldGroup = new THREE.Group(); scene.add(worldGroup);
let fileInstances, signalPoints, sectorLabels = [], lanes = [], ripples = [];
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const raycaster = new THREE.Raycaster();
let probeMesh;

function glowTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, '#fff'); gradient.addColorStop(.13, '#ffffffee');
  gradient.addColorStop(.35, '#ffffff55'); gradient.addColorStop(1, '#ffffff00');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
const glow = glowTexture();
function points(positions, colors, size, opacity = 1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({ size, map: glow, transparent: true, opacity, depthWrite: false, vertexColors: !!colors, color: 0xffffff, blending: THREE.AdditiveBlending }));
}

// The background is decoration; all solid islands and crystals are real metadata.
const stars = [], starColors = [];
for (let i = 0; i < 1350; i++) {
  const r = (salt) => hash(`${i}-${salt}`) / 4294967296;
  stars.push((r(1) - .5) * 1900, (r(2) - .28) * 680, (r(3) - .5) * 1900);
  color.setHSL(.57 + r(4) * .17, .4, .4 + r(5) * .45); starColors.push(color.r, color.g, color.b);
}
scene.add(points(stars, starColors, 1.8, .5));
const grid = new THREE.GridHelper(1700, 85, 0x394878, 0x202849);
grid.position.y = -55; grid.material.transparent = true; grid.material.opacity = .28; scene.add(grid);
const originRing = new THREE.Mesh(new THREE.RingGeometry(24, 24.2, 96), new THREE.MeshBasicMaterial({ color: 0x889bff, side: THREE.DoubleSide, transparent: true, opacity: .2 }));
originRing.rotation.x = -Math.PI / 2; originRing.position.set(0, -4, 60); scene.add(originRing);

function createShip() {
  const group = new THREE.Group();
  const ivory = new THREE.MeshStandardMaterial({ color: 0xf0f2ff, metalness: .35, roughness: .38 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x202c55, metalness: .5, roughness: .27 });
  const accent = new THREE.MeshStandardMaterial({ color: 0x68e4ef, emissive: 0x38bedc, emissiveIntensity: 1.3 });
  const positions = [0,.6,-5.4, -1,0,2.5, 1,0,2.5, 0,.6,-5.4, 1,0,2.5, 0,1.1,1.1, 0,.6,-5.4, 0,1.1,1.1, -1,0,2.5, -1,0,2.5, 0,1.1,1.1, 1,0,2.5];
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geo.computeVertexNormals();
  group.add(new THREE.Mesh(geo, ivory));
  for (const side of [-1, 1]) {
    const wingGeo = new THREE.BufferGeometry();
    const a = [side * .6, .15, -1.2], b = [side * 5.1, -.3, 2.4], c = [side * 1.4, .1, 1.9];
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute(side > 0 ? [...a, ...c, ...b, ...a, ...b, ...c] : [...a, ...b, ...c, ...a, ...c, ...b], 3)); wingGeo.computeVertexNormals();
    group.add(new THREE.Mesh(wingGeo, ivory));
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(.4, .5, 2, 5), dark);
    pod.rotation.x = Math.PI / 2; pod.position.set(side * 1.4, -.1, 1.8); group.add(pod);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(.15, 5, 5), accent); tip.position.set(side * 4.75, -.3, 2.18); group.add(tip);
  }
  const cockpit = new THREE.Mesh(new THREE.OctahedronGeometry(.85), dark); cockpit.scale.set(.58, .42, 1.6); cockpit.position.set(0, .8, -.7); group.add(cockpit);
  const engine = points([-1.4, -.1, 3, 1.4, -.1, 3], [.4, .83, 1, .4, .83, 1], 3.2, .9); group.add(engine);
  const plume = new THREE.Group();
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(.32, 4.5, 7), new THREE.MeshBasicMaterial({ color: 0x85dfff, transparent: true, opacity: .65, blending: THREE.AdditiveBlending, depthWrite: false }));
    mesh.rotation.x = Math.PI / 2; mesh.position.set(side * 1.4, -.1, 5.1); plume.add(mesh);
  }
  group.add(plume); group.userData = { plume, engine }; return group;
}
const shipMesh = createShip(); scene.add(shipMesh);
const shipTrailPositions = new Float32Array(70 * 3);
const trailGeometry = new THREE.BufferGeometry(); trailGeometry.setAttribute('position', new THREE.BufferAttribute(shipTrailPositions, 3));
const shipTrail = new THREE.Line(trailGeometry, new THREE.LineBasicMaterial({ color: 0x8fa7ff, transparent: true, opacity: .38 })); scene.add(shipTrail);
let trail = [];

const beacon = new THREE.Group();
const beaconMaterial = new THREE.MeshBasicMaterial({ color: 0xc4cfff, transparent: true, opacity: .7, side: THREE.DoubleSide });
for (let i = 0; i < 2; i++) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(4.6 + i * .7, 4.67 + i * .7, 48), beaconMaterial);
  ring.rotation.x = i === 0 ? Math.PI / 2 : 0; beacon.add(ring);
}
scene.add(beacon); beacon.visible = false;
const navigationLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineDashedMaterial({ color: 0xc4cfff, dashSize: 2, gapSize: 3, transparent: true, opacity: .4 }));
navigationLine.visible = false; scene.add(navigationLine);
// Use geometry, not line width: WebGL lines are only one pixel on many devices.
const shotEffect = new THREE.Group(); scene.add(shotEffect); shotEffect.visible = false;
const shotBeam = new THREE.Mesh(new THREE.CylinderGeometry(.16, .16, 1, 8), new THREE.MeshBasicMaterial({ color: 0x68e4ef, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
const shotGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xdafaff, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending }));
const muzzleFlash = new THREE.Sprite(shotGlow.material.clone());
for (const mesh of [shotBeam, shotGlow, muzzleFlash]) { mesh.renderOrder = 10; shotEffect.add(mesh); }
const beamAxis = new THREE.Vector3(0, 1, 0);
let shot = null;

function cancelShot() { shot = null; shotEffect.visible = false; document.body.classList.remove('shot-preview'); }
function fireBeam(file) {
  shot = { ...createFileShot(state.ship, file), sourceVersion: state.sourceVersion };
  document.body.classList.add('shot-preview'); shotEffect.visible = true;
  renderShot();
}
function renderShot() {
  const start = v(shot.start), end = v(shot.end);
  const head = start.clone().lerp(end, shot.progress);
  const tail = start.clone().lerp(end, Math.max(0, shot.progress - 18 / shot.distance));
  const delta = head.clone().sub(tail), length = delta.length();
  shotBeam.visible = shot.phase === 'flight' && length > .01;
  if (shotBeam.visible) {
    shotBeam.position.copy(tail).add(head).multiplyScalar(.5);
    shotBeam.quaternion.setFromUnitVectors(beamAxis, delta.divideScalar(length));
    shotBeam.scale.set(1, length, 1);
  }
  shotGlow.position.copy(head);
  shotGlow.scale.setScalar(shot.phase === 'impact' ? 5 + shot.age * 35 : 3.5);
  shotGlow.material.opacity = shot.phase === 'impact' ? Math.max(0, 1 - shot.age / .2) : 1;
  muzzleFlash.position.copy(start); muzzleFlash.scale.setScalar(4 + shot.age * 20);
  muzzleFlash.visible = shot.phase === 'flight' && shot.age < .15;
  muzzleFlash.material.opacity = Math.max(0, 1 - shot.age / .15);
}
function updateShot(dt) {
  if (!shot) return;
  // An interrupted flight must not open a stale file when the shot would land.
  if (!state.launched || state.paused || anyDialog() || document.hidden || shot.sourceVersion !== state.sourceVersion) { cancelShot(); return; }
  const file = state.world?.files.find((file) => file.id === shot.file.id);
  if (!file) { cancelShot(); toast('That signal is no longer in this folder.'); return; }
  const event = stepFileShot(shot, dt);
  if (event === 'impact') addRipple(shot.end, file.color);
  if (event === 'open') {
    cancelShot();
    openFile(file, true);
  } else renderShot();
}

function disposeGroup(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse((child) => { if (child.geometry) geometries.add(child.geometry); if (child.material) (Array.isArray(child.material) ? child.material : [child.material]).forEach((m) => materials.add(m)); });
  geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); group.clear();
}

function renderWorld(world) {
  disposeGroup(worldGroup); $('labels').replaceChildren(); sectorLabels = []; lanes = [];
  for (const sector of world.sectors) {
    const island = new THREE.Group(); island.position.copy(v(sector.position));
    const rockGeometry = new THREE.ConeGeometry(sector.radius, 25 + sector.radius * .3, 7, 1);
    rockGeometry.rotateX(Math.PI); rockGeometry.rotateY(hash(sector.id) / 1e8);
    const rock = new THREE.Mesh(rockGeometry, new THREE.MeshStandardMaterial({ color: 0x192346, roughness: .95, flatShading: true }));
    rock.position.y = -21; island.add(rock);
    const plateau = new THREE.Mesh(new THREE.CylinderGeometry(sector.radius, sector.radius * .92, 1.5, 7), new THREE.MeshStandardMaterial({ color: new THREE.Color(sector.color).multiplyScalar(.3), metalness: .15, roughness: .8, flatShading: true }));
    plateau.position.y = -3; plateau.rotation.y = hash(sector.id) / 1e8; island.add(plateau);
    const rimMesh = new THREE.LineSegments(new THREE.EdgesGeometry(plateau.geometry), new THREE.LineBasicMaterial({ color: sector.color, transparent: true, opacity: .22 }));
    rimMesh.position.copy(plateau.position); rimMesh.rotation.copy(plateau.rotation); island.add(rimMesh);
    const orbit = new THREE.Mesh(new THREE.RingGeometry(sector.radius + 4, sector.radius + 4.13, 96), new THREE.MeshBasicMaterial({ color: sector.color, transparent: true, opacity: .33, side: THREE.DoubleSide }));
    orbit.rotation.x = -Math.PI / 2; orbit.position.y = -2; island.add(orbit);
    // A central obelisk anchors each folder visually without pretending to be a file.
    const spire = new THREE.Mesh(new THREE.OctahedronGeometry(3.4, 0), new THREE.MeshStandardMaterial({ color: sector.color, metalness: .5, roughness: .25, emissive: sector.color, emissiveIntensity: .35, flatShading: true }));
    spire.scale.set(.65, 2.1, .65); spire.position.y = 5; island.add(spire);
    const beam = new THREE.Mesh(new THREE.CylinderGeometry(.04, .14, 44, 5), new THREE.MeshBasicMaterial({ color: sector.color, transparent: true, opacity: .28, depthWrite: false })); beam.position.y = 30; island.add(beam);
    worldGroup.add(island);
    const line = document.createElement('div'); line.className = 'sector-label'; line.style.setProperty('--sector-color', `#${sector.color.toString(16).padStart(6, '0')}`);
    const name = document.createTextNode(sector.name.toUpperCase()); const small = document.createElement('small'); small.textContent = `${sector.fileCount} FILES`;
    line.append(name, small); $('labels').append(line); sectorLabels.push({ element: line, sector });
    const from = new THREE.Vector3(0, -3, 60), to = v(sector.position).add(new THREE.Vector3(0, -2, 0));
    const middle = from.clone().lerp(to, .5); middle.y -= 17;
    middle.x += (hash(sector.id) % 2 ? 1 : -1) * 22;
    const curve = new THREE.QuadraticBezierCurve3(from, middle, to);
    worldGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(70)), new THREE.LineBasicMaterial({ color: sector.color, transparent: true, opacity: .13 })));
    const flow = points(new Float32Array(24 * 3), null, 2.3, .52); color.set(sector.color); flow.material.color.copy(color); worldGroup.add(flow);
    lanes.push({ curve, flow, phase: (hash(sector.id) % 100) / 100, activity: sector.activity });
  }
  if (world.files.length) {
    fileInstances = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: .37, metalness: .32, emissive: 0x323360, emissiveIntensity: .42, flatShading: true }), world.files.length);
    const positions = [], colors = [];
    world.files.forEach((file, i) => {
      dummy.position.copy(v(file.position)); dummy.scale.set(file.radius * .62, file.radius * (1.3 + file.mass * .08), file.radius * .62); dummy.rotation.set(0, file.phase, .12); dummy.updateMatrix(); fileInstances.setMatrixAt(i, dummy.matrix);
      color.set(file.color); color.lerp(new THREE.Color(0xebeaff), .22); fileInstances.setColorAt(i, color);
      positions.push(file.position.x, file.position.y, file.position.z); colors.push(color.r, color.g, color.b);
    });
    fileInstances.instanceMatrix.needsUpdate = true; fileInstances.instanceColor.needsUpdate = true; worldGroup.add(fileInstances);
    signalPoints = points(positions, colors, 5, .42); worldGroup.add(signalPoints);
  } else { fileInstances = null; signalPoints = null; }
}

function signature(snapshot) { return snapshot.files.map((f) => `${f.path}:${f.size}:${f.modifiedAt}`).join('|'); }
function applySnapshot(snapshot) {
    const nextSignature = signature(snapshot);
    const firstLoad = !state.world;
    if (state.disconnected) $('activity-line').textContent = 'Connection restored. The map is listening for changes again.';
    state.disconnected = false;
    const nextWorld = buildWorld(snapshot);
    // Preserve established districts when a new folder enters the live snapshot.
    if (state.world) {
      const occupied = state.world.sectors.map((s) => s.position);
      for (const sector of nextWorld.sectors) {
        const previous = state.world.sectors.find((s) => s.id === sector.id);
        let target = previous?.position;
        if (!target && occupied.some((p) => distance(p, sector.position) < 95)) {
          const angle = hash(sector.id) / 4294967296 * Math.PI * 2;
          let radius = 300;
          do { target = { x: Math.sin(angle) * radius, y: sector.position.y, z: Math.cos(angle) * radius }; radius += 110; } while (occupied.some((p) => distance(p, target) < 100));
        }
        if (target) {
          const shift = v(target).sub(v(sector.position));
          for (const file of sector.files) { file.position.x += shift.x; file.position.y += shift.y; file.position.z += shift.z; }
          sector.position = { ...target };
        }
        occupied.push(sector.position);
      }
    }
    state.snapshot = snapshot; state.world = nextWorld;
    if (nextSignature !== state.signature || firstLoad) { renderWorld(state.world); state.signature = nextSignature; }
    else {
      // Keep the newest activity values without reallocating GPU geometry.
      sectorLabels.forEach((entry) => { entry.sector = nextWorld.sectors.find((s) => s.id === entry.sector.id) || entry.sector; });
      lanes.forEach((lane, i) => { lane.activity = nextWorld.sectors[i]?.activity || 0; });
    }
    for (const event of [...snapshot.events].reverse()) {
      if (state.seenEvents.has(event.id)) continue;
      state.seenEvents.add(event.id);
      const file = state.world.files.find((f) => f.path === event.path);
      if (file) addRipple(file.position, file.color);
      $('activity-line').textContent = `${event.type.charAt(0).toUpperCase() + event.type.slice(1)} · ${event.path}`;
    }
    if (state.seenEvents.size > 400) state.seenEvents = new Set(snapshot.events.map((e) => e.id));
    if (state.destination) {
      const updated = state.destination.kind === 'file' ? nextWorld.files.find((f) => f.id === state.destination.id) : nextWorld.sectors.find((s) => s.id === state.destination.id);
      if (updated) state.destination = { ...updated, kind: state.destination.kind };
      else { state.destination = null; toast('That destination is no longer in this folder.'); }
    }
    $('connection').textContent = `${snapshot.root.name} / ${state.source.live ? 'connected' : 'snapshot'}`;
    document.querySelector('.status-dot').style.background = '';
    $('world-name').textContent = snapshot.root.name;
    $('root-name').textContent = snapshot.root.name.toUpperCase();
    $('file-count').textContent = snapshot.files.length.toLocaleString();
    $('district-count').textContent = nextWorld.sectors.length.toString().padStart(2, '0');
    $('world-size').textContent = formatBytes(snapshot.files.reduce((sum, f) => sum + f.size, 0));
    $('scan-time').textContent = `${state.source.live ? 'SYNCED' : 'SNAPSHOT'} ${new Date(snapshot.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    $('privacy-note').textContent = snapshot.truncated ? 'PARTIAL MAP · SCAN LIMIT' : snapshot.unreadable ? 'PARTIAL MAP · SOME UNREADABLE' : 'FILES STAY LOCAL';
    $('launch').disabled = false; $('launch').hidden = false; $('choose-folder').hidden = true; $('map-button').disabled = false; $('launch').replaceChildren(document.createTextNode('Launch expedition'), Object.assign(document.createElement('span'), { textContent: '↗' }));
    $('error').hidden = true;
    if (firstLoad && !nextWorld.files.length) toast(state.source.live ? 'No eligible files in this folder yet. Add a file or choose another folder.' : 'No eligible files in this snapshot. Choose another folder to explore.');
    if (firstLoad && !state.source.live) $('activity-line').textContent = 'Folder snapshot. Reselect this folder to include changes.';
    updateFolderUI();
    updateMission();
    if ($('atlas').open) renderAtlas();
}

async function loadWorld() {
  const source = state.source, version = state.sourceVersion;
  if (!source || state.loading || state.connecting) return false;
  const request = new AbortController();
  state.loadAbort = request; state.loading = true;
  const timeout = setTimeout(() => request.abort(), 12000);
  try {
    const snapshot = await source.readWorld({ signal: request.signal });
    if (source !== state.source || version !== state.sourceVersion || request.signal.aborted) return false;
    if (!Array.isArray(snapshot.files)) throw new Error('The folder map was not in the expected format.');
    applySnapshot(snapshot);
    return true;
  } catch (error) {
    if (source !== state.source || version !== state.sourceVersion) return false;
    state.disconnected = true;
    $('connection').textContent = 'Folder connection interrupted';
    document.querySelector('.status-dot').style.background = '#ffad9b';
    const message = source.kind === 'server' ? 'Check your local server or choose a folder in this browser.' : 'Choose the folder again to reconnect. Your last map is still here.';
    $('activity-line').textContent = message;
    $('source-note').textContent = message;
    if (!state.world) showFolderError(message);
    return false;
  } finally {
    clearTimeout(timeout);
    if (state.loadAbort === request) { state.loadAbort = null; state.loading = false; }
  }
}

function updateFolderUI() {
  const busy = state.choosing || state.connecting;
  const connected = !!state.source;
  $('folder-button').disabled = busy;
  $('choose-folder').disabled = busy;
  $('snapshot-picker').disabled = busy;
  $('folder-button').textContent = busy ? 'Reading folder…' : state.snapshotFallback ? 'Choose snapshot' : connected ? 'Change folder' : 'Connect folder';
  $('launch').disabled = busy || !state.world;
  $('choose-folder').replaceChildren(document.createTextNode(busy ? 'Mapping your folder…' : 'Choose a folder'), Object.assign(document.createElement('span'), { textContent: '↗' }));
  $('disconnect-folder').hidden = !connected;
  $('refresh-folder').hidden = !connected;
  $('refresh-folder').disabled = busy;
  $('refresh-folder').textContent = state.source?.live ? 'Refresh' : 'Reselect to refresh';
  $('snapshot-picker').hidden = connected;
  if (connected) {
    const count = state.snapshot?.files.length || 0;
    $('folder-note').textContent = `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'} mapped. Ready when you are.`;
    $('source-note').textContent = state.source.kind === 'server' ? 'Local server · live refresh every 5 seconds.' : state.source.live ? 'Connected on this device · refreshes every 5 seconds.' : 'Snapshot · reselect the folder to see changes.';
  }
}

function showFolderError(message) {
  $('folder-error').textContent = message;
  $('folder-error').hidden = false;
  toast(message);
}

function clearFolderWorld() {
  fileViewer.close();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  state.sourceVersion++; state.loadAbort?.abort(); state.loadAbort = null; state.loading = false;
  state.source?.dispose(); state.source = null;
  state.world = null; state.snapshot = null; state.launched = false; state.paused = false;
  state.charted.clear(); state.visited.clear(); state.seenEvents.clear(); state.signature = '';
  state.destination = null; state.nearest = null; state.focusedFileId = null; state.holding = false; state.disconnected = false;
  state.ship = { position: { x: 0, y: 12, z: 70 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0 };
  clearInput(); trail = []; cancelShot(); $('reticle').hidden = true;
  for (const ripple of ripples) { scene.remove(ripple.mesh); ripple.mesh.geometry.dispose(); ripple.mesh.material.dispose(); }
  ripples = [];
  renderWorld(buildWorld({ files: [] }));
  $('intro').hidden = false; $('mission').hidden = true; $('file-panel').hidden = true; $('destination').hidden = true;
  $('launch').hidden = true; $('launch').disabled = true; $('choose-folder').hidden = false;
  $('folder-error').hidden = true; $('error').hidden = true; $('map-button').disabled = true;
  $('connection').textContent = 'No folder connected'; $('world-name').textContent = 'Your next destination'; $('root-name').textContent = 'LOCAL WORKSPACE';
  for (const id of ['file-count', 'district-count', 'world-size']) $(id).textContent = '—';
  $('source-note').textContent = 'Connect a folder to create your world.';
  $('folder-note').textContent = 'Your files stay on this device. Nothing is uploaded.';
  $('scan-time').textContent = 'CHOOSE A FOLDER'; $('privacy-note').textContent = 'FILES STAY LOCAL';
  $('activity-line').textContent = 'Choose a folder to see your files take shape.';
  $('pause-button').textContent = 'Ⅱ'; $('pause-button').setAttribute('aria-label', 'Pause flight');
  $('speed').textContent = '000'; $('speed-bar').style.width = '0%'; $('flight-state').textContent = 'AWAITING PILOT'; $('view-label').textContent = 'FREE EXPLORATION';
  $('coordinates').textContent = 'X 0000   Y 0012   Z 0070';
  document.querySelector('.status-dot').style.background = '';
  updateFolderUI();
}

async function connectSource(source) {
  state.connecting = true; $('folder-error').hidden = true; updateFolderUI();
  const request = new AbortController(); state.selectionAbort?.abort(); state.selectionAbort = request;
  const timeout = setTimeout(() => request.abort(), 12000);
  try {
    const snapshot = await source.readWorld({ signal: request.signal });
    if (request.signal.aborted || state.selectionAbort !== request) { source.dispose(); return; }
    if (!Array.isArray(snapshot.files)) throw new Error('This folder could not be mapped.');
    clearFolderWorld(); state.source = source; state.snapshotFallback = false; applySnapshot(snapshot);
    toast(source.live ? `Connected to ${snapshot.root.name}. Launch your expedition.` : `Snapshot of ${snapshot.root.name} ready. Files stay on this device.`);
  } catch (error) {
    source.dispose();
    if (state.selectionAbort === request) showFolderError(error.name === 'AbortError' ? 'Reading the folder took too long. Try a smaller folder.' : `Could not connect: ${error.message}`);
  } finally {
    clearTimeout(timeout);
    if (state.selectionAbort === request) { state.selectionAbort = null; state.connecting = false; state.choosing = false; updateFolderUI(); }
  }
}

function chooseSnapshot() {
  if (state.connecting || state.choosing) return;
  clearInput(); state.choosing = true; state.pickerVersion++; $('folder-error').hidden = true; updateFolderUI();
  // A FileList is kept only in this tab. No form submission or upload occurs.
  $('folder-input').value = '';
  $('folder-input').click();
}

async function chooseFolder() {
  if (state.connecting || state.choosing) return;
  if (state.snapshotFallback || typeof window.showDirectoryPicker !== 'function' || !window.isSecureContext) { chooseSnapshot(); return; }
  const pickerVersion = ++state.pickerVersion;
  clearInput(); state.choosing = true; $('folder-error').hidden = true; updateFolderUI();
  try {
    const handle = await window.showDirectoryPicker({ mode: 'read', id: 'space-drift-folder' });
    if (pickerVersion !== state.pickerVersion) return;
    await connectSource(createDirectorySource(handle));
  } catch (error) {
    if (pickerVersion === state.pickerVersion && error.name !== 'AbortError') {
      state.snapshotFallback = true;
      showFolderError('Folder access was not granted. Click Choose snapshot to use the standard folder picker.');
    }
  } finally { if (pickerVersion === state.pickerVersion) { state.choosing = false; updateFolderUI(); } }
}

function disconnectFolder() {
  state.pickerVersion++; state.snapshotFallback = false;
  state.selectionAbort?.abort(); state.selectionAbort = null; state.choosing = false; state.connecting = false;
  clearFolderWorld(); toast('Folder disconnected. Choose another world to explore.');
}

$('choose-folder').addEventListener('click', chooseFolder);
$('folder-button').addEventListener('click', chooseFolder);
$('snapshot-picker').addEventListener('click', chooseSnapshot);
$('folder-input').addEventListener('change', () => {
  const files = [...$('folder-input').files];
  $('folder-input').value = '';
  if (!state.choosing) return;
  state.choosing = false; updateFolderUI();
  if (files.length) connectSource(createSnapshotSource(files));
});
$('folder-input').addEventListener('cancel', () => { state.choosing = false; updateFolderUI(); });
$('disconnect-folder').addEventListener('click', disconnectFolder);
$('refresh-folder').addEventListener('click', () => state.source?.live ? loadWorld() : chooseSnapshot());

async function initializeSource() {
  const version = state.sourceVersion;
  try {
    const response = await fetch('/runtime.json');
    const runtime = response.ok ? await response.json() : {};
    if (!runtime.localServer || state.source || state.choosing || state.connecting || version !== state.sourceVersion) return;
    const source = {
      kind: 'server', name: 'Local server', live: true,
      async readWorld({ signal } = {}) {
        const result = await fetch('/api/world', { signal });
        if (!result.ok) throw new Error(`The local server returned ${result.status}.`);
        return result.json();
      },
      dispose() {},
    };
    await connectSource(source);
  } catch { /* Static hosting starts at the folder picker without a local API. */ }
}

function addRipple(position, tint = 0xaab8ff) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(.95, 1, 80), new THREE.MeshBasicMaterial({ color: tint, side: THREE.DoubleSide, transparent: true, opacity: .8, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.copy(v(position)); scene.add(ring); ripples.push({ mesh: ring, age: 0 });
}
function updateReticleTarget() {
  if (!state.launched || !state.world) { state.reticleTarget = null; return; }
  camera.updateMatrixWorld();
  raycaster.setFromCamera({ x: state.reticle.x * 2 - 1, y: 1 - state.reticle.y * 2 }, camera);
  state.reticleTarget = findProbeTarget(state.world.files, raycaster.ray.origin, raycaster.ray.direction);
  if (state.reticleTarget) state.focusedFileId = state.reticleTarget.file.id;
  $('reticle').classList.toggle('locked', !!state.reticleTarget);
}
function moveReticle(clientX, clientY) {
  state.reticle.x = clamp(clientX / innerWidth, .03, .97); state.reticle.y = clamp(clientY / innerHeight, .08, .93);
  $('reticle').style.left = `${state.reticle.x * 100}%`; $('reticle').style.top = `${state.reticle.y * 100}%`;
  updateReticleTarget();
}
function recenterReticle() { moveReticle(innerWidth / 2, innerHeight / 2); toast('Reticle centered on your forward vector.'); }
function removeProbeMesh() {
  if (!probeMesh) return;
  scene.remove(probeMesh); probeMesh.geometry.dispose(); probeMesh.material.dispose(); probeMesh = null;
}
function fireProbe() {
  if (!state.launched || state.paused || anyDialog()) return;
  if (state.probe || performance.now() < state.probeReadyAt) { toast('Probe systems recharging.'); return; }
  updateReticleTarget();
  const target = state.reticleTarget?.file;
  if (!target) { toast('No file signal under the reticle.'); return; }
  const probe = createProbe(state.ship.position, target);
  if (!probe) { toast('Target out of probe range.'); return; }
  state.destination = null; state.holding = false; state.probe = probe; state.probeReadyAt = performance.now() + 550;
  probeMesh = new THREE.Mesh(new THREE.SphereGeometry(.42, 12, 12), new THREE.MeshBasicMaterial({ color: 0x68e4ef, transparent: true, opacity: .9 }));
  probeMesh.position.copy(v(probe.position)); scene.add(probeMesh);
  toast(`Probe launched toward ${target.name}.`);
}
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4300); }
function launch() {
  if (!state.world || state.choosing || state.connecting) return;
  state.launched = true; state.paused = false; $('intro').hidden = true; $('mission').hidden = false; $('pause-button').textContent = 'Ⅱ';
  $('reticle').hidden = false; updateReticleTarget();
  $('scene').focus({ preventScroll: true });
  toast('W to thrust · A / D to steer · E to open a file · M to choose a destination');
}
function updateMission() {
  if (!state.world) return;
  const total = Math.min(5, state.world.files.length);
  const currentFiles = new Set(state.world.files.map((f) => f.id));
  const scanned = [...state.charted].filter((id) => currentFiles.has(id)).length;
  const progress = total ? Math.min(1, scanned / total) : 0;
  $('charted-count').textContent = String(scanned).padStart(2, '0');
  $('mission-total').textContent = `/ ${String(total).padStart(2, '0')} files charted`;
  $('mission-progress').style.width = `${progress * 100}%`;
  $('progress-arc').style.strokeDashoffset = String(82 * (1 - progress));
  $('mission-percent').textContent = `${Math.round(progress * 100)}%`;
  $('sector-count').textContent = `${state.visited.size} district${state.visited.size === 1 ? '' : 's'} visited`;
  $('mission-state').textContent = !total ? 'AWAITING FILES' : progress === 1 ? 'COMPLETE' : 'IN PROGRESS';
}
async function scanFile(file, { ripple = true } = {}) {
  if (!state.launched || state.paused || anyDialog()) return;
  file ||= scanCandidate();
  if (!file) { toast('Move within 18 units of a file to open it. Use the atlas to set a course.'); return; }
  clearInput(); state.destination = null; state.focusedFileId = file.id;
  const ranged = distance(file.position, state.ship.position) > SCAN_RANGE;
  if (!ranged) {
    state.holding = true;
    state.ship.velocity = { x: 0, y: 0, z: 0 };
    openFile(file, false);
  } else {
    fireBeam(file);
    // Remove course/miss toasts so the launch and target stay visible.
    clearTimeout(toastTimer); $('toast').classList.remove('show');
  }
}
async function openFile(file, ranged) {
  clearInput();
  const sourceVersion = state.sourceVersion;
  const opened = await fileViewer.open(file);
  if (!opened || sourceVersion !== state.sourceVersion) return;
  const firstVisit = !state.charted.has(file.id);
  state.charted.add(file.id); state.visited.add(file.sectorId); updateMission();
  if (firstVisit && !ranged) addRipple(file.position, file.color);
  if (firstVisit) {
    if (ripple) addRipple(file.position, file.color);
    if (state.charted.size === Math.min(5, state.world.files.length)) toast('Expedition complete. Your first signals are charted. Keep exploring.');
  }
}
function scanCandidate() {
  return findScanCandidate(state.world, state.ship, state.focusedFileId);
}
function setCourse(target, kind) {
  cancelShot();
  if (!state.launched) launch();
  state.paused = false; state.holding = false; state.destination = { ...target, kind }; state.focusedFileId = kind === 'file' ? target.id : null; $('atlas').close();
  toast(`Course set for ${target.name}. Aim and press E from range, or open nearby. Steering keys return control to you.`);
}
function renderAtlas() {
  if (!state.world) return;
  const query = $('atlas-search').value.toLowerCase().trim();
  const results = query ? state.world.files.filter((f) => f.path.toLowerCase().includes(query)).slice(0, 60).map((file) => ({ target: file, kind: 'file' })) : state.world.sectors.map((sector) => ({ target: sector, kind: 'sector' }));
  $('atlas-results').replaceChildren();
  if (!results.length) { const p = document.createElement('p'); p.textContent = query ? 'No files match that search.' : 'No folders mapped yet.'; $('atlas-results').append(p); }
  for (const { target, kind } of results) {
    const button = document.createElement('button'); button.className = 'atlas-row';
    const dot = document.createElement('i'); dot.style.background = `#${target.color.toString(16).padStart(6, '0')}`;
    const text = document.createElement('div'), title = document.createElement('strong'), detail = document.createElement('small');
    title.textContent = target.name;
    detail.textContent = kind === 'file' ? `${target.path} · ${formatBytes(target.size)}` : `${target.fileCount.toLocaleString()} files · ${formatBytes(target.bytes)} · ${Math.round(distance(target.position, state.ship.position))} u away`;
    const arrow = document.createElement('span'); arrow.textContent = '↗'; text.append(title, detail); button.append(dot, text, arrow);
    button.addEventListener('click', () => setCourse(target, kind)); $('atlas-results').append(button);
  }
}
function anyDialog() { return state.choosing || state.connecting || $('atlas').open || $('manual').open || fileViewer.isOpen; }
function clearInput() { keys.clear(); tapUntil.clear(); }
function openAtlas() { if (!state.world) return; clearInput(); $('atlas-search').value = ''; renderAtlas(); $('atlas').showModal(); }
function showManual() { clearInput(); $('manual').showModal(); }
function togglePause() {
  if (!state.launched) return;
  state.paused = !state.paused; clearInput();
  $('pause-button').textContent = state.paused ? '▷' : 'Ⅱ'; $('pause-button').setAttribute('aria-label', state.paused ? 'Resume flight' : 'Pause flight');
  toast(state.paused ? 'Flight paused. Press Escape to resume.' : 'Flight resumed.');
}
function resetShip() { cancelShot(); state.ship.position = { x: 0, y: 12, z: 70 }; state.ship.velocity = { x: 0, y: 0, z: 0 }; state.ship.yaw = 0; state.destination = null; state.holding = false; trail = []; toast('Returned to the launch point.'); }
$('launch').addEventListener('click', launch);
$('scan').addEventListener('click', scanFile);
$('map-button').addEventListener('click', openAtlas);
$('atlas-search').addEventListener('input', renderAtlas);
$('help-button').addEventListener('click', showManual); $('all-controls').addEventListener('click', showManual);
$('pause-button').addEventListener('click', togglePause);
$('cancel-course').addEventListener('click', () => { state.destination = null; toast('Manual flight.'); });
$('retry').addEventListener('click', () => location.reload());
$('currents-toggle').addEventListener('click', () => { state.currents = !state.currents; $('currents-toggle').setAttribute('aria-pressed', String(state.currents)); $('currents-state').textContent = state.currents ? 'ON' : 'OFF'; });
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelector('.close-manual').addEventListener('click', () => $('manual').close());
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });
  dialog.addEventListener('close', clearInput);
}
const movementKeys = ['KeyW','KeyS','KeyA','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyR','KeyF','ShiftLeft','ShiftRight','Space'];
addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || anyDialog()) return;
  if (movementKeys.includes(event.code)) { if (state.launched && !state.paused) { event.preventDefault(); keys.add(event.code); tapUntil.set(event.code, performance.now() + 90); state.destination = null; state.holding = false; } return; }
  if (event.repeat) return;
  if (event.code === 'KeyE') scanFile();
  if (event.code === 'KeyQ') fireProbe();
  if (event.code === 'KeyC') recenterReticle();
  if (event.code === 'KeyM') { event.preventDefault(); openAtlas(); }
  if (event.code === 'KeyH') showManual();
  if (event.code === 'Escape') togglePause();
  if (event.code === 'Home') { event.preventDefault(); resetShip(); }
  if (event.code === 'Enter' && !state.launched) launch();
});
addEventListener('keyup', (event) => keys.delete(event.code));
addEventListener('blur', () => { clearInput(); cancelShot(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { clearInput(); cancelShot(); } });
for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('pointerdown', (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); if (!state.launched) launch(); if (button.dataset.key === 'KeyE') scanFile(); else if (button.dataset.key === 'KeyQ') fireProbe(); else if (button.dataset.key === 'KeyC') recenterReticle(); else { keys.add(button.dataset.key); state.destination = null; state.holding = false; } });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, () => keys.delete(button.dataset.key));
}
renderer.domElement.addEventListener('pointermove', (event) => {
  if (!state.launched || anyDialog() || (event.pointerType !== 'mouse' && !renderer.domElement.hasPointerCapture(event.pointerId))) return;
  moveReticle(event.clientX, event.clientY);
});
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!state.launched || anyDialog()) return;
  $('scene').focus({ preventScroll: true });
  if (event.pointerType === 'touch') { renderer.domElement.setPointerCapture(event.pointerId); return; }
  if (event.button === 0) { moveReticle(event.clientX, event.clientY); fireProbe(); }
});

function playerInput() {
  const has = (...codes) => codes.some((code) => keys.has(code) || (tapUntil.get(code) || 0) > performance.now());
  const input = { thrust: Number(has('KeyW','ArrowUp')) - Number(has('KeyS','ArrowDown')), turn: Number(has('KeyA','ArrowLeft')) - Number(has('KeyD','ArrowRight')), lift: Number(has('KeyR')) - Number(has('KeyF')), boost: has('ShiftLeft','ShiftRight'), brake: has('Space') };
  if (state.holding) return { thrust: 0, turn: 0, lift: 0, brake: true };
  const target = state.destination;
  if (!target) return input;
  const delta = v(target.position).sub(v(state.ship.position));
  const length = delta.length();
  const stopDistance = target.kind === 'file' ? 11 : 24;
  if (length < stopDistance) {
    state.destination = null; state.holding = true; state.ship.velocity = { x: 0, y: 0, z: 0 };
    toast(target.kind === 'file' ? `Arrived at ${target.name}. Press E to open a file.` : `Arrived in ${target.name}. Aim at a crystal and press E, or open one nearby.`);
    return { ...input, brake: true };
  }
  const desired = Math.atan2(-delta.x, -delta.z);
  const angle = Math.atan2(Math.sin(desired - state.ship.yaw), Math.cos(desired - state.ship.yaw));
  input.turn = clamp(angle * 2.1, -1, 1);
  input.thrust = Math.abs(angle) > 1 ? .12 : clamp((length - stopDistance) / 35, .14, 1);
  input.lift = clamp(delta.y / 30, -1, 1); input.boost = length > 145 && Math.abs(angle) < .25;
  return input;
}

let hudElapsed = 0;
function updateHUD(dt) {
  const candidate = state.launched ? scanCandidate() : null;
  $('reticle').hidden = !state.launched || state.paused || anyDialog();
  $('reticle').classList.toggle('locked', !!candidate || !!shot);
  $('reticle-target').textContent = shot ? `${shot.file.name} · ${shot.phase === 'flight' ? 'FIRING' : 'HIT'}` : candidate ? `${candidate.name} · E` : 'Aim at a signal · E';
  hudElapsed += dt; if (hudElapsed < .09) return; hudElapsed = 0;
  $('scene').dataset.telemetry = JSON.stringify(window.__SPACE_DRIFT__?.getState());
  if (!state.world) return;
  const ship = state.ship;
  const speed = Math.hypot(ship.velocity.x, ship.velocity.y, ship.velocity.z);
  $('speed').textContent = String(Math.round(speed)).padStart(3, '0'); $('speed-bar').style.width = `${Math.min(speed / 120, 1) * 100}%`;
  const paused = state.paused || anyDialog();
  $('flight-state').textContent = !state.launched ? 'AWAITING PILOT' : paused ? 'FLIGHT PAUSED' : state.destination ? 'FOLLOWING COURSE' : state.holding ? 'HOLDING POSITION' : speed > 65 ? 'BOOST ENGAGED' : speed > 2 ? 'CRUISING' : 'DRIFTING';
  $('view-label').textContent = paused ? 'FLIGHT PAUSED' : state.destination ? 'GUIDED FLIGHT' : 'FREE EXPLORATION';
  $('coordinates').textContent = `X ${Math.round(ship.position.x).toString().padStart(4, '0')}   Y ${Math.round(ship.position.y).toString().padStart(4, '0')}   Z ${Math.round(ship.position.z).toString().padStart(4, '0')}`;
  const nearest = state.reticleTarget?.file || scanCandidate() || findNearestFile(state.world, ship.position, 90); state.nearest = nearest;
  $('file-panel').hidden = !state.launched || !nearest;
  if (nearest) {
    const range = distance(nearest.position, ship.position), scanned = state.charted.has(nearest.id);
    $('file-status').textContent = shot ? (shot.phase === 'flight' ? 'SHOT IN FLIGHT' : 'SIGNAL HIT') : range > SCAN_RANGE && candidate ? 'IN YOUR SIGHTS' : scanned ? 'CHARTED SIGNAL' : range <= SCAN_RANGE ? 'WITHIN SCAN RANGE' : 'SIGNAL DETECTED';
    $('file-distance').textContent = `${Math.round(range)} u`;
    $('file-name').textContent = nearest.name; $('file-path').textContent = nearest.path;
    $('file-type').textContent = nearest.extension ? nearest.extension.toUpperCase() : 'FILE';
    $('file-size').textContent = formatBytes(nearest.size);
    const hours = Math.max(0, (Date.now() - Date.parse(nearest.modifiedAt)) / 3600000);
    $('file-age').textContent = !Number.isFinite(hours) ? 'Unknown age' : hours < 1 ? 'Changed <1h ago' : hours < 48 ? `Changed ${Math.floor(hours)}h ago` : `Changed ${Math.floor(hours / 24)}d ago`;
    $('scan').disabled = !candidate || paused || !!shot;
    $('scan').firstChild.textContent = shot ? 'Firing… ' : !candidate ? 'Aim or approach to open ' : distance(candidate.position, ship.position) > SCAN_RANGE ? 'Fire to open ' : 'Open file ';
  }
  const region = state.world.sectors.find((s) => distance(s.position, ship.position) < s.radius + 20);
  if (state.launched && region && !state.visited.has(region.id)) { state.visited.add(region.id); updateMission(); }
  $('destination').hidden = !state.destination;
  if (state.destination) { $('destination-name').textContent = state.destination.name; $('destination-distance').textContent = `${Math.round(distance(ship.position, state.destination.position))} units to arrival`; }
  $('scene').dataset.telemetry = JSON.stringify(window.__SPACE_DRIFT__?.getState());
}

function animate(time) {
  requestAnimationFrame(animate);
  const now = time / 1000, dt = Math.min(.05, now - (animate.last || now)); animate.last = now;
  updateShot(dt);
  // Keep cruising during the visible shot; only the viewer pauses flight.
  const paused = state.paused || anyDialog() || document.hidden;
  if (!paused) state.time += dt;
  state.fps += ((dt ? 1 / dt : 60) - state.fps) * .02;
  if (state.world && state.launched && !paused) stepShip(state.ship, playerInput(), state.world, dt, { currents: state.currents });
  if (state.launched) {
    const p = v(state.ship.position), yaw = state.ship.yaw;
    const behind = new THREE.Vector3(Math.sin(yaw) * 32, 15, Math.cos(yaw) * 32);
    const desiredCamera = p.clone().add(behind);
    camera.position.lerp(desiredCamera, 1 - Math.exp(-dt * 3.5));
    camera.lookAt(p.clone().add(new THREE.Vector3(-Math.sin(yaw) * 15, 2, -Math.cos(yaw) * 15)));
  } else {
    const orbit = state.time * .025;
    camera.position.set(100 + Math.sin(orbit) * 12, 103 + Math.sin(orbit * .7) * 5, 207);
    camera.lookAt(0, 0, -80);
  }
  updateReticleTarget();
  if (state.probe && !paused) {
    if (stepProbe(state.probe, dt)) {
      const target = state.world.files.find((file) => file.id === state.probe.id);
      removeProbeMesh(); state.probe = null;
      if (target) { addRipple(target.position, target.color); toast(`Probe reached ${target.name}.`); scanFile(target, { ripple: false }); }
      else toast('Probe signal was lost.');
    } else if (probeMesh) probeMesh.position.copy(v(state.probe.position));
  }
  shipMesh.position.copy(v(state.ship.position)); shipMesh.rotation.y = state.ship.yaw;
  shipMesh.rotation.z = THREE.MathUtils.lerp(shipMesh.rotation.z, (keys.has('KeyA') ? -.25 : keys.has('KeyD') ? .25 : 0), .06);
  const speed = Math.hypot(state.ship.velocity.x, state.ship.velocity.y, state.ship.velocity.z);
  shipMesh.userData.plume.scale.z = .2 + speed / 40; shipMesh.userData.plume.visible = speed > 2;
  shipMesh.userData.engine.material.size = 2.5 + speed / 50;
  if (!paused) {
    trail.unshift(v(state.ship.position)); if (trail.length > 70) trail.pop();
    for (let i = 0; i < 70; i++) { const p = trail[Math.min(i, trail.length - 1)]; if (p) p.toArray(shipTrailPositions, i * 3); }
    trailGeometry.attributes.position.needsUpdate = true; shipTrail.visible = speed > 4;
  }
  for (const lane of lanes) {
    lane.flow.visible = state.currents;
    if (!state.currents) continue;
    const attribute = lane.flow.geometry.attributes.position;
    for (let i = 0; i < 24; i++) { const t = (i / 24 + state.time * (.025 + lane.activity * .05) + lane.phase) % 1; const p = lane.curve.getPoint(t); attribute.setXYZ(i, p.x, p.y, p.z); }
    attribute.needsUpdate = true;
  }
  for (const ripple of ripples) {
    if (!paused || fileViewer.isOpen) ripple.age += dt;
    const scale = 1 + ripple.age * 25; ripple.mesh.scale.setScalar(scale); ripple.mesh.material.opacity = Math.max(0, .8 - ripple.age / 3);
  }
  ripples = ripples.filter((r) => { if (r.age < 2.4) return true; scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); return false; });
  const highlighted = state.destination?.kind === 'file' ? state.destination : state.reticleTarget?.file || state.nearest;
  beacon.visible = state.launched && !!highlighted;
  if (highlighted) { beacon.position.copy(v(highlighted.position)); beacon.rotation.y = state.time * .4; }
  navigationLine.visible = !!state.destination;
  if (state.destination) { const attr = navigationLine.geometry.attributes.position; attr.setXYZ(0, state.ship.position.x, state.ship.position.y, state.ship.position.z); attr.setXYZ(1, state.destination.position.x, state.destination.position.y, state.destination.position.z); attr.needsUpdate = true; navigationLine.computeLineDistances(); }
  const width = innerWidth, height = innerHeight;
  for (const { element, sector } of sectorLabels) {
    const projected = v(sector.position).add(new THREE.Vector3(0, 49, 0)).project(camera);
    const x = (projected.x * .5 + .5) * width, y = (-projected.y * .5 + .5) * height;
    const blockedByHUD = x < (state.launched ? 300 : 330) && y < 450 || x > width - 300 && y < 445;
    element.style.display = projected.z < 1 && projected.z > -1 && y > 140 && y < height - 125 && x > 20 && x < width - 20 && !blockedByHUD ? '' : 'none';
    element.style.left = `${x}px`; element.style.top = `${y}px`;
  }
  updateHUD(dt); renderer.render(scene, camera);
}
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });
renderer.domElement.addEventListener('webglcontextlost', (event) => { event.preventDefault(); state.paused = true; $('error').hidden = false; $('error-message').textContent = 'The graphics context was interrupted. Reload to return to the launch point.'; });

// Read-only diagnostics support real-control browser tests without teleport hooks.
window.__SPACE__ = Object.freeze({ getState: () => ({ ready: !!state.world, launched: state.launched, paused: state.paused, currents: state.currents, position: { ...state.ship.position }, velocity: { ...state.ship.velocity }, yaw: state.ship.yaw, files: state.world?.files.length || 0, sectors: state.world?.sectors.length || 0, charted: [...state.charted], visited: [...state.visited], destination: state.destination ? { id: state.destination.id, name: state.destination.name, kind: state.destination.kind } : null, nearest: state.nearest ? { id: state.nearest.id, distance: distance(state.ship.position, state.nearest.position) } : null, reticleTarget: state.reticleTarget ? { id: state.reticleTarget.file.id, distance: state.reticleTarget.distance } : null, probe: state.probe ? { id: state.probe.id, position: { ...state.probe.position }, duration: state.probe.duration, elapsed: state.probe.elapsed } : null, fps: Math.round(state.fps), drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, liveEvents: state.snapshot?.events.length || 0, viewerOpen: fileViewer.isOpen, openedFile: fileViewer.path }) });
window.__DATA_DRIFT__ = window.__SPACE__; // Preserve the original diagnostics name.
loadWorld(); setInterval(loadWorld, 5000); requestAnimationFrame(animate);
