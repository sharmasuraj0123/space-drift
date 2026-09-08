import * as THREE from "/vendor/three.module.js";
import * as C from "./constants.js";
import {
  stepShip,
  formatBytes,
  findScanCandidate,
  createFileShot,
  stepFileShot,
  SHOT_RANGE,
} from "./model.js";
import { resolveShotAtom } from "./file-shots.js";
import { createShotRenderer } from "./render-shot.js";
import {
  buildSpaceWorld,
  buildPlanetWorld,
  refreshWorldPhysics,
} from "./bodies.js";
import { captureState } from "./field.js";
import { guideShip } from "./navigation.js";
import { excitationAt } from "./energy.js";
import {
  createLayerState,
  layerReducer,
  landable,
  spawnAfterLanding,
  spawnAfterTakeoff,
  altitudeTakeoff,
  planRoute,
  nextLeg,
} from "./layers.js";
import {
  createTourState,
  tourReducer,
  exportTour,
  refreshTourState,
} from "./tours.js";
import { createPlanetLoader } from "./planet-loader.js";
import {
  selectTarget,
  createProbe,
  stepProbe,
  PROBE_RANGE,
  PROBE_COOLDOWN,
} from "./probes.js";
import {
  readInstruments,
  environmentalNotices,
  distance,
} from "./instruments.js";
import { createFileViewer } from "./viewer.js";
import {
  createDirectorySource,
  createSnapshotSource,
} from "./folder-source.js";
import { createServerSource } from "./server-source.js";
import { createSpaceRenderer } from "./render-space.js";
import { createPlanetRenderer } from "./render-planet.js";

const $ = (id) => document.getElementById(id),
  v = (p) => new THREE.Vector3(p.x, p.y, p.z);
const clamp = THREE.MathUtils.clamp,
  length = (p) => Math.hypot(p.x, p.y, p.z),
  zero = () => ({ x: 0, y: 0, z: 0 });
const state = {
  source: null,
  sourceVersion: 0,
  selectionAbort: null,
  choosing: false,
  connecting: false,
  pickerVersion: 0,
  snapshotFallback: false,
  loader: null,
  loading: false,
  layerGeneration: 0,
  layer: createLayerState({}),
  spacePayload: null,
  planetPayload: null,
  lastTakeoffAt: 0,
  spaceWorld: null,
  planetWorld: null,
  launched: false,
  paused: false,
  fieldEnabled: true,
  holding: false,
  ship: {
    position: { x: 0, y: 12, z: 70 },
    velocity: zero(),
    yaw: 0,
    simulationTime: 0,
  },
  route: null,
  destination: null,
  tour: null,
  tours: [],
  tourErrors: [],
  queue: [],
  charted: new Set(),
  landed: new Set(),
  focusedFileId: null,
  reticle: { x: 0, y: 0, target: null },
  probe: null,
  shot: null,
  lastFired: -Infinity,
  time: 0,
  fps: 60,
  input: {},
  atlasMode: "local",
  light: { emitters: 0, illumination: C.AMBIENT, flashes: 0, cooling: 0 },
  seenEvents: new Set(),
  transitionBody: null,
  overlays: { space: savedOverlay("space"), planet: savedOverlay("planet") },
  previousInstruments: null,
};
function savedOverlay(layer) {
  try {
    const value = localStorage.getItem(`space-drift-overlay-${layer}`);
    return (layer === "space"
      ? ["off", "curvature", "energy", "light"]
      : ["off", "bonds", "temperature", "light"]
    ).includes(value)
      ? value
      : "off";
  } catch {
    return "off";
  }
}
const keys = new Set(),
  tapUntil = new Map();
let resetting = false;
const fileViewer = createFileViewer({
  getSource: () => state.source,
  onClose: () => {
    clearInput();
    if (!resetting) dispatchTour({ type: "viewerClosed" });
    $("scene").focus({ preventScroll: true });
  },
});
const scene = new THREE.Scene();
scene.background = new THREE.Color("#080b18");
scene.fog = new THREE.FogExp2("#080b18", 0.00145);
const camera = new THREE.PerspectiveCamera(
  52,
  innerWidth / innerHeight,
  0.3,
  50000,
);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.7));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.2;
  $("scene").append(renderer.domElement);
} catch (error) {
  $("error").hidden = false;
  $("error-message").textContent =
    "This game needs WebGL. Enable hardware acceleration and reload.";
  throw error;
}
const spaceRenderer = createSpaceRenderer({ THREE, scene }),
  planetRenderer = createPlanetRenderer({ THREE, scene });
function glowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "#fff");
  gradient.addColorStop(0.13, "#ffffffee");
  gradient.addColorStop(0.35, "#ffffff55");
  gradient.addColorStop(1, "#ffffff00");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(canvas);
}
const glow = glowTexture();
function points(positions, colors, size, opacity = 1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  if (colors)
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      size,
      map: glow,
      transparent: true,
      opacity,
      depthWrite: false,
      vertexColors: !!colors,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
    }),
  );
}

function createShip() {
  const group = new THREE.Group();
  const ivory = new THREE.MeshStandardMaterial({
    color: 0xf0f2ff,
    metalness: 0.35,
    roughness: 0.38,
    emissive: 0x4d526d,
    emissiveIntensity: 0.6,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x202c55,
    metalness: 0.5,
    roughness: 0.27,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x68e4ef,
    emissive: 0x38bedc,
    emissiveIntensity: 1.3,
  });
  const positions = [
    0, 0.6, -5.4, -1, 0, 2.5, 1, 0, 2.5, 0, 0.6, -5.4, 1, 0, 2.5, 0, 1.1, 1.1,
    0, 0.6, -5.4, 0, 1.1, 1.1, -1, 0, 2.5, -1, 0, 2.5, 0, 1.1, 1.1, 1, 0, 2.5,
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  group.add(new THREE.Mesh(geo, ivory));
  for (const side of [-1, 1]) {
    const wingGeo = new THREE.BufferGeometry();
    const a = [side * 0.6, 0.15, -1.2],
      b = [side * 5.1, -0.3, 2.4],
      c = [side * 1.4, 0.1, 1.9];
    wingGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        side > 0
          ? [...a, ...c, ...b, ...a, ...b, ...c]
          : [...a, ...b, ...c, ...a, ...c, ...b],
        3,
      ),
    );
    wingGeo.computeVertexNormals();
    group.add(new THREE.Mesh(wingGeo, ivory));
    const pod = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 0.5, 2, 5),
      dark,
    );
    pod.rotation.x = Math.PI / 2;
    pod.position.set(side * 1.4, -0.1, 1.8);
    group.add(pod);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.15, 5, 5), accent);
    tip.position.set(side * 4.75, -0.3, 2.18);
    group.add(tip);
  }
  const cockpit = new THREE.Mesh(new THREE.OctahedronGeometry(0.85), dark);
  cockpit.scale.set(0.58, 0.42, 1.6);
  cockpit.position.set(0, 0.8, -0.7);
  group.add(cockpit);
  const engine = points(
    [-1.4, -0.1, 3, 1.4, -0.1, 3],
    [0.4, 0.83, 1, 0.4, 0.83, 1],
    3.2,
    0.9,
  );
  group.add(engine);
  const plume = new THREE.Group();
  for (const side of [-1, 1]) {
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(0.32, 4.5, 7),
      new THREE.MeshBasicMaterial({
        color: 0x85dfff,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(side * 1.4, -0.1, 5.1);
    plume.add(mesh);
  }
  group.add(plume);
  group.userData = { plume, engine };
  return group;
}

const shipMesh = createShip();
scene.add(shipMesh);
const navigationLine = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(),
    new THREE.Vector3(),
  ]),
  new THREE.LineDashedMaterial({
    color: 0xc4cfff,
    dashSize: 2,
    gapSize: 3,
    transparent: true,
    opacity: 0.45,
  }),
);
scene.add(navigationLine);
navigationLine.visible = false;
const beacon = new THREE.Mesh(
  new THREE.TorusGeometry(4.5, 0.065, 5, 48),
  new THREE.MeshBasicMaterial({
    color: 0x68e4ef,
    transparent: true,
    opacity: 0.85,
  }),
);
scene.add(beacon);
beacon.visible = false;
const probeMesh = new THREE.Mesh(
  new THREE.SphereGeometry(0.65, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xaffcff }),
);
scene.add(probeMesh);
probeMesh.visible = false;
const shotRenderer = createShotRenderer({ THREE, scene, glow });
let trail = [];
const trailPositions = new Float32Array(70 * 3),
  trailGeometry = new THREE.BufferGeometry();
trailGeometry.setAttribute(
  "position",
  new THREE.BufferAttribute(trailPositions, 3),
);
const shipTrail = new THREE.Line(
  trailGeometry,
  new THREE.LineBasicMaterial({
    color: 0x8fa7ff,
    transparent: true,
    opacity: 0.35,
  }),
);
scene.add(shipTrail);
const raycaster = new THREE.Raycaster();
let toastTimer,
  toastProtectedUntil = 0,
  atlasRequest = 0,
  tourRequest = 0,
  hudElapsed = 0;
function toast(message, ambient = false) {
  if (ambient && performance.now() < toastProtectedUntil) return;
  toastProtectedUntil = performance.now() + 3000;
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 5000);
}
function clearInput() {
  keys.clear();
  tapUntil.clear();
}
function transition() {
  return ["descending", "ascending"].includes(state.layer.name);
}
function surface() {
  return ["planet", "ascending"].includes(state.layer.name);
}
function activeWorld() {
  return surface() ? state.planetWorld : state.spaceWorld;
}
function anyDialog() {
  return (
    state.choosing ||
    state.connecting ||
    !!document.querySelector("dialog[open]")
  );
}
function closePanels() {
  cancelShot();
  for (const dialog of document.querySelectorAll("dialog[open]"))
    if (dialog.id !== "file-viewer") dialog.close();
}
function nameOf(id) {
  return (
    state.spaceWorld?.bodies.find((b) => b.id === id)?.name ||
    (state.transitionBody?.id === id ? state.transitionBody.name : null) ||
    id
  );
}
function text(id, value) {
  if ($(id)) $(id).textContent = value;
}
function dl(id, rows) {
  const fragment = document.createDocumentFragment();
  for (const [label, value] of rows) {
    const dt = document.createElement("dt"),
      dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = value;
    fragment.append(dt, dd);
  }
  $(id).replaceChildren(fragment);
}
const number = (n, precision = 2) =>
  Number.isFinite(n)
    ? n.toLocaleString(undefined, { maximumFractionDigits: precision })
    : "—";
const formula = (elements) =>
  Object.entries(elements || {})
    .filter(([, count]) => count)
    .map(
      ([key, count]) =>
        `${{ source: "src", markup: "mk", data: "dat", image: "img", media: "med", binary: "bin", other: "etc" }[key] || key} ${count}`,
    )
    .join(" · ") || "No represented atoms";
function addButton(parent, label, action, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", action);
  parent.append(button);
  return button;
}

function updateFolderUI() {
  const connected = !!state.source,
    busy = state.connecting || state.choosing;
  $("choose-folder").hidden = connected;
  $("choose-folder").disabled = busy;
  $("folder-button").disabled = busy;
  $("choose-folder").firstChild.textContent = state.connecting
    ? "Mapping your system… "
    : state.snapshotFallback
      ? "Choose snapshot "
      : "Choose a folder ";
  text("folder-button", connected ? "Switch folder" : "Connect folder");
  $("launch").hidden = !connected;
  $("launch").disabled =
    busy ||
    !activeWorld() ||
    (state.layer.name === "planet" && !state.layer.payloadReady);
  $("refresh-folder").hidden = !connected;
  $("refresh-folder").disabled = busy;
  text("refresh-folder", state.source?.live ? "Refresh" : "Reselect snapshot");
  $("disconnect-folder").hidden = !connected;
  $("map-button").disabled = !connected;
  $("snapshot-picker").hidden = connected;
  if (connected) {
    text(
      "connection",
      `${state.spacePayload?.root?.name || state.source.name} · ${state.source.live ? "connected" : "snapshot"}`,
    );
    text(
      "folder-note",
      `${state.spaceWorld?.bodies.length || 0} bodies discovered. ${state.layer.name === "planet" && !state.layer.payloadReady ? "Surveying the surface…" : "Ready when you are."}`,
    );
    text(
      "source-note",
      state.source.kind === "server"
        ? "Local server · per-repository Git · 5-second refresh."
        : state.source.live
          ? "Local folder · snapshot physics · 5-second refresh."
          : "Local snapshot · reselect to see changes. Repository markers may be omitted by the picker.",
    );
  }
}
function showFolderError(message) {
  text("folder-error", message);
  $("folder-error").hidden = false;
  toast(message);
}
function clearFolderWorld() {
  cancelShot();
  resetting = true;
  fileViewer.close();
  closePanels();
  resetting = false;
  state.sourceVersion++;
  state.layerGeneration++;
  state.loader?.dispose();
  state.loader = null;
  state.source?.dispose();
  state.source = null;
  state.loading = false;
  state.spaceWorld = null;
  state.planetWorld = null;
  state.spacePayload = null;
  state.planetPayload = null;
  state.layer = createLayerState({});
  state.route = null;
  state.destination = null;
  state.tour = null;
  state.tours = [];
  state.queue = [];
  state.probe = null;
  state.lastFired = -Infinity;
  state.charted.clear();
  state.landed.clear();
  state.seenEvents.clear();
  openingTour = null;
  state.focusedFileId = null;
  state.holding = false;
  state.previousInstruments = null;
  state.launched = false;
  state.paused = false;
  state.transitionBody = null;
  state.ship = {
    position: { x: 0, y: 12, z: 70 },
    velocity: zero(),
    yaw: 0,
    simulationTime: 0,
  };
  clearInput();
  trail = [];
  atlasRequest++;
  tourRequest++;
  state.reticle = { x: 0, y: 0, target: null };
  spaceRenderer.reset();
  planetRenderer.reset();
  $("labels").replaceChildren();
  $("intro").hidden = false;
  $("mission").hidden = true;
  $("file-panel").hidden = true;
  $("destination").hidden = true;
  $("folder-error").hidden = true;
  $("error").hidden = true;
  text("connection", "No folder connected");
  text("world-name", "Your next destination");
  text("root-name", "LOCAL WORKSPACE");
  for (const id of ["file-count", "district-count", "world-size"])
    text(id, "—");
  text("folder-note", "Your files stay on this device. Nothing is uploaded.");
  text("source-note", "Connect a folder to create your world.");
  text("activity-line", "Choose a folder to discover its system.");
  text("pause-button", "Ⅱ");
  updateFolderUI();
}
async function connectSource(source) {
  state.connecting = true;
  $("folder-error").hidden = true;
  updateFolderUI();
  const request = new AbortController();
  state.selectionAbort?.abort();
  state.selectionAbort = request;
  const timer = setTimeout(() => request.abort(), 12000);
  try {
    const payload = await source.readSpace({ signal: request.signal });
    if (request.signal.aborted || request !== state.selectionAbort) {
      source.dispose();
      return;
    }
    if (!Array.isArray(payload.bodies))
      throw new Error("This folder could not be discovered.");
    clearFolderWorld();
    state.source = source;
    state.loader = createPlanetLoader({
      read: (id, options) => source.readPlanet(id, options),
    });
    state.snapshotFallback = false;
    applySpace(payload, true);
    if (state.layer.name === "planet") await loadPlanet(state.layer.planetId);
    else
      toast(
        `You are in the ${payload.root.name} system: ${payload.bodies.length} bodies. Fly to a planet and press L inside its landing ring. M lists them.`,
      );
  } catch (error) {
    if (state.source !== source) source.dispose();
    if (state.selectionAbort === request)
      showFolderError(
        error.name === "AbortError"
          ? "Reading the folder took too long. Try a smaller folder."
          : `Could not connect: ${error.message}`,
      );
  } finally {
    clearTimeout(timer);
    if (state.selectionAbort === request) {
      state.selectionAbort = null;
      state.connecting = false;
      state.choosing = false;
      updateFolderUI();
    }
  }
}
function applySpace(payload, first = false) {
  const oldBodies = state.spacePayload?.bodies || [];
  // Keep the currently loaded body at one survey revision until its next surface refresh.
  if (
    !first &&
    state.planetPayload &&
    ["planet", "descending"].includes(state.layer.name)
  ) {
    payload = {
      ...payload,
      bodies: payload.bodies.map((b) =>
        b.id === state.planetPayload.id
          ? { ...b, ...bodyRow(state.planetPayload) }
          : b,
      ),
    };
  }
  state.spacePayload = payload;
  state.spaceWorld = buildSpaceWorld(payload, Date.now(), state.spaceWorld);
  state.loader?.prune(payload.bodies.map((b) => b.id));
  spaceRenderer.setWorld(state.spaceWorld);
  if (first) {
    state.layer = createLayerState(payload);
    state.ship.position = { ...state.spaceWorld.launch };
  } else if (
    !state.launched &&
    state.layer.name === "space" &&
    payload.bodies.length === 1 &&
    !payload.bodies[0].survey?.pending
  ) {
    // Discovery can remove a provisional empty belt after its first survey.
    state.layerGeneration++;
    state.layer = createLayerState(payload);
  }
  if (
    state.layer.name === "space" &&
    state.layer.capture.bodyId &&
    !payload.bodies.some((b) => b.id === state.layer.capture.bodyId)
  ) {
    state.layer = layerReducer(state.layer, { type: "escaped" });
  }
  if (
    ["planet", "descending"].includes(state.layer.name) &&
    !payload.bodies.some((b) => b.id === state.layer.planetId)
  ) {
    toast(
      `${nameOf(state.layer.planetId)} is no longer in this workspace. Lifting off.`,
    );
    beginTakeoff("planetLost");
  }
  for (const body of payload.bodies) {
    const old = oldBodies.find((b) => b.id === body.id);
    if (
      old?.git?.head &&
      body.git?.head &&
      old.git.head !== body.git.head &&
      excitationAt(body, Date.now()) > excitationAt(old, Date.now())
    )
      toast(`${body.name} brightened: a commit landed.`);
  }
  for (const event of [...(payload.events || [])].reverse())
    if (!state.seenEvents.has(event.id)) {
      state.seenEvents.add(event.id);
      text(
        "activity-line",
        `${event.type} · ${event.path || nameOf(event.planetId)}`,
      );
      if (!first && event.type === "modified")
        toast(`${event.path} changed. Its molecule heats up.`);
    }
  if (state.seenEvents.size > 800)
    state.seenEvents = new Set((payload.events || []).map((e) => e.id));
  updateFolderUI();
}
function bodyRow(payload) {
  return Object.fromEntries(
    [
      "id",
      "kind",
      "path",
      "name",
      "restMass",
      "excitation",
      "excitationAt",
      "xi",
      "git",
      "survey",
      "elements",
      "color",
      "hot",
      "patches",
      "crystals",
      "revision",
      "nestedRepos",
    ]
      .filter((key) => payload[key] !== undefined)
      .map((key) => [key, payload[key]])
      .concat([
        ["fileCount", payload.atoms.length],
        ["moleculeCount", payload.molecules.length],
      ]),
  );
}
function applyPlanet(payload) {
  state.planetPayload = payload;
  state.spacePayload = {
    ...state.spacePayload,
    bodies: state.spacePayload.bodies.map((b) =>
      b.id === payload.id ? { ...b, ...bodyRow(payload) } : b,
    ),
  };
  const now = Date.now();
  state.spaceWorld = buildSpaceWorld(state.spacePayload, now, state.spaceWorld);
  spaceRenderer.setWorld(state.spaceWorld);
  state.planetWorld = buildPlanetWorld(payload, state.spaceWorld, now);
  planetRenderer.setWorld(state.planetWorld);
}
async function loadPlanet(id, fresh = false) {
  const version = state.sourceVersion,
    generation = state.layerGeneration,
    loader = state.loader;
  if (!loader) return;
  try {
    const payload = await loader.load(id, { fresh });
    if (
      version !== state.sourceVersion ||
      generation !== state.layerGeneration ||
      state.layer.planetId !== id ||
      !["descending", "planet"].includes(state.layer.name)
    )
      return;
    const initial = !state.layer.payloadReady;
    applyPlanet(payload);
    const before = state.layer.name;
    state.layer = layerReducer(state.layer, {
      type: "planetLoaded",
      bodyId: id,
    });
    if (initial && state.layer.name === "planet") finishLanding(before);
    updateFolderUI();
  } catch (error) {
    if (
      version !== state.sourceVersion ||
      generation !== state.layerGeneration ||
      state.layer.planetId !== id ||
      !["planet", "descending"].includes(state.layer.name)
    )
      return;
    toast(`Could not survey ${nameOf(id)}. Lifting off.`);
    beginTakeoff("planetFailed");
  }
}
async function loadWorld() {
  if (!state.source || state.loading) return;
  const source = state.source,
    version = state.sourceVersion;
  state.loading = true;
  try {
    const payload = await source.readSpace({
      signal: AbortSignal.timeout(10000),
    });
    if (source !== state.source || version !== state.sourceVersion) return;
    applySpace(payload);
    if (["planet", "descending"].includes(state.layer.name))
      await loadPlanet(state.layer.planetId, true);
    refreshTours();
    if ($("atlas").open) renderAtlas();
  } catch (error) {
    if (source === state.source)
      text(
        "activity-line",
        `Refresh paused: ${error.message}. Use Refresh to reconnect.`,
      );
  } finally {
    if (version === state.sourceVersion) state.loading = false;
  }
}
function chooseSnapshot() {
  if (state.connecting || state.choosing) return;
  cancelShot();
  clearInput();
  state.choosing = true;
  state.pickerVersion++;
  $("folder-error").hidden = true;
  updateFolderUI();
  $("folder-input").value = "";
  $("folder-input").click();
}
async function chooseFolder() {
  if (state.connecting || state.choosing) return;
  cancelShot();
  if (
    state.snapshotFallback ||
    typeof window.showDirectoryPicker !== "function" ||
    !window.isSecureContext
  )
    return chooseSnapshot();
  const version = ++state.pickerVersion;
  clearInput();
  state.choosing = true;
  $("folder-error").hidden = true;
  updateFolderUI();
  try {
    const handle = await window.showDirectoryPicker({
      mode: "read",
      id: "space-drift-folder",
    });
    if (version === state.pickerVersion)
      await connectSource(createDirectorySource(handle));
  } catch (error) {
    if (version === state.pickerVersion && error.name !== "AbortError") {
      state.snapshotFallback = true;
      showFolderError(
        "Folder access was not granted. Click Choose snapshot to use the standard folder picker.",
      );
    }
  } finally {
    if (version === state.pickerVersion) {
      state.choosing = false;
      updateFolderUI();
    }
  }
}
function disconnectFolder() {
  state.pickerVersion++;
  state.selectionAbort?.abort();
  state.selectionAbort = null;
  state.choosing = false;
  state.connecting = false;
  clearFolderWorld();
  toast("Folder disconnected. Choose another system to explore.");
}
async function initializeSource() {
  const version = state.sourceVersion;
  try {
    const response = await fetch("/runtime.json");
    const runtime = response.ok ? await response.json() : {};
    if (
      runtime.localServer &&
      !state.source &&
      !state.choosing &&
      !state.connecting &&
      version === state.sourceVersion
    )
      await connectSource(createServerSource());
  } catch {
    /* Static hosting starts at the folder picker. */
  }
}

function launch() {
  if (
    transition() ||
    !activeWorld() ||
    state.connecting ||
    state.choosing ||
    (state.layer.name === "planet" && !state.layer.payloadReady)
  )
    return;
  state.launched = true;
  state.paused = false;
  $("intro").hidden = true;
  $("mission").hidden = false;
  $("scene").focus({ preventScroll: true });
  toast(
    state.layer.name === "space"
      ? `You are in the ${state.spacePayload.root.name} system: ${state.spaceWorld.bodies.length} bodies. Fly to a planet and press L inside its landing ring. M lists them.`
      : `Landed on ${nameOf(state.layer.planetId)}: ${state.planetWorld.molecules.length} molecules, ${state.planetWorld.atoms.length} atoms. E opens an atom, L lifts off.`,
  );
}
function pauseTour() {
  const before = state.tour?.status;
  state.tour = tourReducer(state.tour, { type: "steer" });
  if (state.tour?.status === "paused" && before !== "paused")
    toast("Tour paused. Press T to resume.");
}
function manualControl() {
  pauseTour();
  state.route = null;
  state.destination = null;
  state.holding = false;
  state.layer = layerReducer(state.layer, { type: "released" });
}
function beginLanding(body = landable(state.spaceWorld, state.ship.position)) {
  if (state.layer.name !== "space") return;
  if (!body) {
    toast("No body in landing range.");
    return;
  }
  const next = layerReducer(state.layer, {
    type: "land",
    bodyId: body.id,
    world: state.spaceWorld,
    position: state.ship.position,
  });
  if (next === state.layer) return;
  state.paused = false;
  text("pause-button", "Ⅱ");
  $("pause-button").setAttribute("aria-label", "Pause flight");
  state.layerGeneration++;
  state.transitionBody = body;
  state.transitionStart = {
    position: { ...state.ship.position },
    camera: camera.position.clone(),
  };
  state.layer = next;
  state.holding = false;
  state.probe = null;
  clearInput();
  closePanels();
  loadPlanet(body.id);
}
function finishLanding() {
  state.ship = spawnAfterLanding(state.planetWorld);
  state.holding = true;
  state.focusedFileId = state.planetWorld.landingTargetId;
  state.landed.add(state.layer.planetId);
  trail = [];
  state.previousInstruments = null;
  toast(
    `Landed on ${nameOf(state.layer.planetId)}: ${state.planetWorld.molecules.length} molecules, ${state.planetWorld.atoms.length} atoms. E opens an atom, L lifts off.`,
  );
}
function beginTakeoff(type = "takeoff") {
  if (type === "takeoff" && state.layer.name !== "planet") return;
  const next = layerReducer(state.layer, { type });
  if (next === state.layer) return;
  state.paused = false;
  text("pause-button", "Ⅱ");
  $("pause-button").setAttribute("aria-label", "Pause flight");
  state.transitionBody =
    state.spaceWorld?.bodies.find((b) => b.id === state.layer.planetId) ||
    state.planetWorld?.body ||
    state.transitionBody;
  state.transitionStart = {
    position: { ...state.ship.position },
    camera: camera.position.clone(),
  };
  state.layerGeneration++;
  state.layer = next;
  state.probe = null;
  state.holding = false;
  clearInput();
  fileViewer.close();
  closePanels();
  if (type === "takeoff")
    toast(
      `Lifting off from ${state.transitionBody?.name || state.layer.planetId}.`,
    );
  else {
    state.route = null;
    state.destination = null;
    state.tour = tourReducer(state.tour, { type: "steer" });
  }
}
function landOrTakeoff() {
  if (!state.launched || transition() || anyDialog()) return;
  manualControl();
  if (state.layer.name === "space") beginLanding();
  else beginTakeoff();
}
function advanceLayer(dt) {
  if (!transition()) return;
  const before = state.layer.name;
  state.layer = layerReducer(state.layer, { type: "tick", dt });
  if (before === "descending" && state.layer.name === "planet") finishLanding();
  if (
    state.layer.name === "ascending" &&
    state.layer.transition.progress >= 1
  ) {
    state.ship = spawnAfterTakeoff(
      state.spaceWorld,
      state.transitionBody,
      state.layer.approach,
    );
    state.layer = layerReducer(state.layer, { type: "ascended" });
    state.lastTakeoffAt = Date.now();
    state.previousInstruments = null;
    trail = [];
  }
}
function updateCapture() {
  if (state.layer.name !== "space") return;
  const capture = state.layer.capture,
    heldBody =
      state.spaceWorld.bodies.find((b) => b.id === capture.bodyId) ||
      state.transitionBody;
  if (
    !capture.armed &&
    heldBody &&
    distance(state.ship.position, heldBody.center) >
      C.ESCAPE_K * heldBody.landingRadius
  ) {
    state.layer = layerReducer(state.layer, { type: "escaped" });
    toast(`Escaped ${heldBody.name}.`);
  }
  const body = landable(state.spaceWorld, state.ship.position);
  if (
    body &&
    state.layer.capture.armed &&
    captureState(body, state.ship, state.spaceWorld.system).captured &&
    !state.route
  ) {
    state.layer = layerReducer(state.layer, {
      type: "captured",
      bodyId: body.id,
    });
    state.ship.velocity = zero();
    toast(`Captured by ${body.name}. Press L to land, thrust to break free.`);
  }
}
function resetShip() {
  if (!activeWorld() || transition()) return;
  cancelShot();
  manualControl();
  state.probe = null;
  trail = [];
  state.ship = surface()
    ? spawnAfterLanding(state.planetWorld)
    : {
        position: { ...state.spaceWorld.launch },
        velocity: zero(),
        yaw: 0,
        simulationTime: 0,
      };
  state.holding = surface();
  state.focusedFileId = surface() ? state.planetWorld.landingTargetId : null;
  state.layer.capture = { armed: true, bodyId: null, held: false };
  toast(
    surface()
      ? "Returned to the landing site."
      : "Returned to the system launch point.",
  );
}

function scanCandidate() {
  if (state.layer.name !== "planet" || !state.planetWorld) return null;
  return findScanCandidate(
    { files: state.planetWorld.atoms },
    state.ship,
    state.focusedFileId,
  );
}
async function openAtom(atom, via = "manual") {
  if (!atom || state.layer.name !== "planet" || transition()) return false;
  cancelShot();
  if (
    via === "tour" &&
    distance(atom.position, state.ship.position) > C.OPEN_RANGE
  ) {
    // A refresh can repack a stop between arrival and opening; fly to it again.
    if (state.tour) state.tour = { ...state.tour, status: "travelling" };
    state.route = null;
    state.destination = null;
    return false;
  }
  const source = state.source,
    version = state.sourceVersion,
    id = state.layer.planetId,
    generation = state.layerGeneration;
  const currentStop = state.tour?.stops[state.tour.index];
  const tourArrival =
    via === "tour" ||
    (currentStop?.id === atom.id && state.tour?.status === "travelling");
  if (tourArrival) {
    state.route = null;
    state.destination = null;
    dispatchTour({ type: "arrived" });
  } else {
    pauseTour();
    state.route = null;
    state.destination = null;
  }
  state.focusedFileId = atom.id;
  if (via !== "ranged") {
    state.holding = true;
    state.ship.velocity = zero();
  }
  clearInput();
  const opened = await fileViewer.open({
    ...atom,
    path: atom.id,
    size: atom.atomicMass,
  });
  if (
    source !== state.source ||
    version !== state.sourceVersion ||
    id !== state.layer.planetId ||
    generation !== state.layerGeneration ||
    state.layer.name !== "planet"
  )
    return false;
  if (opened) {
    state.charted.add(atom.id);
    if (tourArrival) dispatchTour({ type: "opened" });
  } else if (tourArrival) dispatchTour({ type: "openFailed" });
  return opened;
}
function scanFile() {
  if (
    !state.launched ||
    state.paused ||
    anyDialog() ||
    transition() ||
    state.shot ||
    state.probe
  )
    return;
  if (state.layer.name === "space")
    return toast("Land first. Press L inside a planet's landing ring.");
  const atom = scanCandidate();
  if (!atom)
    return toast(
      "Aim the ship at an atom within 90 units, or approach within 18 units. M sets a course.",
    );
  if (distance(atom.position, state.ship.position) <= C.OPEN_RANGE)
    return openAtom(atom);
  pauseTour();
  state.route = null;
  state.destination = null;
  state.focusedFileId = atom.id;
  clearInput();
  state.shot = {
    ...createFileShot(state.ship, atom),
    sourceVersion: state.sourceVersion,
    planetId: state.layer.planetId,
    generation: state.layerGeneration,
  };
  document.body.classList.add("shot-preview");
  clearTimeout(toastTimer);
  $("toast").classList.remove("show");
  shotRenderer.update(state.shot);
}
function cancelShot() {
  state.shot = null;
  shotRenderer.update(null);
  document.body.classList.remove("shot-preview");
}
function updateShot(dt) {
  if (!state.shot) return;
  const atom = resolveShotAtom(state.shot, {
    ...state,
    atoms: state.planetWorld?.atoms,
    dialogOpen: anyDialog(),
    hidden: document.hidden,
  });
  if (!atom) return cancelShot();
  if (stepFileShot(state.shot, dt) === "open") {
    cancelShot();
    openAtom(atom, "ranged");
  } else shotRenderer.update(state.shot);
}
function updateReticle() {
  if (!state.launched || !activeWorld() || transition()) {
    state.reticle.target = null;
    return;
  }
  raycaster.setFromCamera(
    new THREE.Vector2(state.reticle.x, state.reticle.y),
    camera,
  );
  state.reticle.target = selectTarget(
    surface() ? state.planetWorld.atoms : state.spaceWorld.bodies,
    camera.position,
    raycaster.ray.direction,
    state.ship.position,
    { range: surface() ? Infinity : C.PROBE_RANGE_SPACE },
  );
}
function fire() {
  if (!state.launched || state.paused || anyDialog() || transition()) return;
  cancelShot();
  updateReticle();
  const target = state.reticle.target;
  if (state.time - state.lastFired < PROBE_COOLDOWN)
    return toast("Probe recharging.");
  if (!target) return toast("No target under the reticle.");
  if (state.layer.name === "space") {
    if (target.distance > C.PROBE_RANGE_SPACE)
      return toast("Target out of probe range.");
    state.lastFired = state.time;
    setCourse({
      kind: "body",
      planetId: target.id,
      id: target.id,
      land: true,
      name: target.object.name,
    });
    return;
  }
  const result = createProbe(state.ship, target, state.time, state.lastFired);
  if (result.error) return toast(result.error);
  state.probe = {
    ...result.probe,
    planetId: state.layer.planetId,
    version: state.sourceVersion,
  };
  state.lastFired = state.time;
  $("reticle").classList.add("fired");
  setTimeout(() => $("reticle").classList.remove("fired"), 200);
}
function recenter() {
  const point = v(state.ship.position)
    .add(
      new THREE.Vector3(
        -Math.sin(state.ship.yaw) * 60,
        0,
        -Math.cos(state.ship.yaw) * 60,
      ),
    )
    .project(camera);
  state.reticle.x = clamp(point.x, -0.9, 0.9);
  state.reticle.y = clamp(point.y, -0.9, 0.9);
}
function updateProbe() {
  if (!state.probe) return;
  state.probe = stepProbe(state.probe, state.time);
  if (state.probe.arrived) {
    const probe = state.probe;
    state.probe = null;
    const atom = state.planetWorld?.atoms.find((a) => a.id === probe.id);
    if (
      atom &&
      probe.version === state.sourceVersion &&
      probe.planetId === state.layer.planetId
    )
      openAtom(atom, "probe");
    else toast("That atom is no longer mapped.");
  }
}

function setCourse(target, { tour = false } = {}) {
  if (transition() || !state.spaceWorld) return;
  cancelShot();
  if (!state.launched) launch();
  if (!state.launched) return;
  if (!tour) pauseTour();
  state.focusedFileId =
    target.kind === "atom" && target.planetId === state.layer.planetId
      ? target.id
      : null;
  state.route = planRoute(
    { layer: state.layer.name, planetId: state.layer.planetId },
    target,
  );
  state.destination = null;
  state.holding = false;
  state.paused = false;
  state.layer = layerReducer(state.layer, { type: "released" });
  clearInput();
  closePanels();
  if (state.route.legs.length === 0) {
    completeRoute();
    return;
  }
  const label = target.name || target.path || nameOf(target.planetId);
  toast(
    state.route.legs[0]?.type === "takeoff"
      ? `Route: lift off, land on ${nameOf(target.planetId)}, fly to ${target.path || label}.`
      : `Course set for ${label}. Steering keys return control to you.`,
  );
}
function completeRoute() {
  const target = state.route?.target;
  state.route = null;
  state.destination = null;
  state.holding = true;
  state.ship.velocity = zero();
  if (target?.kind === "atom") state.focusedFileId = target.id;
  if (state.tour?.status === "travelling") dispatchTour({ type: "arrived" });
  else if (target)
    toast(
      target.kind === "body" && state.layer.name === "space"
        ? `Arrived at ${nameOf(target.planetId)}. Press L to land.`
        : `Arrived at ${target.name || target.path || target.id}. E opens a nearby atom.`,
    );
}
function advanceRoute() {
  const next = nextLeg(state.route);
  if (!next) completeRoute();
  else {
    state.route = next;
    state.destination = null;
  }
}
function missingRoute() {
  const target = state.route?.target;
  state.route = null;
  state.destination = null;
  state.holding = true;
  toast(
    `${target?.path || target?.id || "That destination"} is no longer mapped. Skipping this stop.`,
  );
  if (state.tour) dispatchTour({ type: "missing" });
}
function resolveDestination(leg) {
  if (leg.kind === "body") {
    const body = state.spaceWorld.bodies.find((b) => b.id === leg.planetId);
    if (!body || body.survey?.pending) return null;
    let approach = leg.approach;
    if (!approach) {
      const delta = v(state.ship.position).sub(v(body.center));
      if (delta.length() < 1) delta.set(0, 0, 1);
      approach = delta.normalize();
      leg.approach = { x: approach.x, y: approach.y, z: approach.z };
    }
    const radius =
      leg.mode === "flyby"
        ? 2 * body.landingRadius
        : Math.max(body.radius + C.SHIP_RADIUS + 5, 0.9 * body.landingRadius);
    return {
      ...body,
      kind: "body",
      position: {
        x: body.center.x + approach.x * radius,
        y: body.center.y + approach.y * radius,
        z: body.center.z + approach.z * radius,
      },
      stopDistance: 4,
    };
  }
  if (leg.planetId !== state.layer.planetId || !state.planetWorld) return null;
  const item =
    leg.kind === "atom"
      ? state.planetWorld.atoms.find((a) => a.id === leg.id)
      : state.planetWorld.molecules.find((m) => m.id === leg.id);
  if (!item) return null;
  const point = item.position || item.center;
  return {
    ...item,
    kind: leg.kind,
    name: item.name || item.path || item.id,
    position: {
      ...point,
      y: leg.kind === "atom" ? Math.max(6, point.y + 2) : 9,
    },
    stopDistance: leg.kind === "atom" ? 11 : Math.max(12, item.clusterRadius),
  };
}
function routeInput() {
  if (!state.route || transition()) return null;
  const leg = state.route.legs[state.route.index];
  if (leg.type === "takeoff") {
    if (state.layer.name === "planet") beginTakeoff();
    else if (state.layer.name === "space") advanceRoute();
    return { hold: true };
  }
  if (leg.type === "land") {
    if (state.layer.name === "planet" && state.layer.planetId === leg.planetId)
      advanceRoute();
    else if (state.layer.name === "space") {
      const body = landable(state.spaceWorld, state.ship.position);
      if (body?.id === leg.planetId) beginLanding(body);
      else {
        state.route.index = Math.max(0, state.route.index - 1);
        state.destination = null;
      }
    }
    return { hold: true };
  }
  const target = resolveDestination(leg);
  if (!target) {
    if (
      leg.kind === "body" &&
      state.spaceWorld.bodies.find((b) => b.id === leg.planetId)?.survey
        ?.pending
    )
      return { hold: true };
    missingRoute();
    return { hold: true };
  }
  state.destination = target;
  const delta = v(target.position).sub(v(state.ship.position)),
    d = delta.length();
  if (d < target.stopDistance) {
    state.ship.velocity = zero();
    advanceRoute();
    return { hold: true };
  }
  state.holding = false;
  state.layer = layerReducer(state.layer, { type: "released" });
  const input = guideShip(state.ship, target, activeWorld(), {
    fieldEnabled: state.fieldEnabled,
  });
  target.waypoint = input.waypoint;
  return input;
}
function playerInput() {
  const has = (...codes) =>
    codes.some(
      (code) => keys.has(code) || (tapUntil.get(code) || 0) > performance.now(),
    );
  if (state.route) return routeInput() || { hold: true };
  if (state.holding || state.layer.capture.held) return { hold: true };
  return {
    thrust: Number(has("KeyW", "ArrowUp")) - Number(has("KeyS", "ArrowDown")),
    turn: Number(has("KeyA", "ArrowLeft")) - Number(has("KeyD", "ArrowRight")),
    lift: Number(has("KeyR")) - Number(has("KeyF")),
    boost: has("ShiftLeft", "ShiftRight"),
    brake: has("Space"),
  };
}

function dispatchTour(event) {
  const old = state.tour;
  state.tour = tourReducer(state.tour, event);
  if (
    old !== state.tour &&
    state.tour?.status === "complete" &&
    old?.status !== "complete"
  ) {
    state.route = null;
    state.destination = null;
    state.holding = true;
    showTourSummary();
  }
  if ($("tours").open) renderTourPanel();
}
function startTour(tour) {
  if (transition()) return;
  if (!state.launched) launch();
  if (!state.launched) return;
  state.tour = createTourState(tour);
  state.route = null;
  state.destination = null;
  state.holding = false;
  closePanels();
  driveTour(0);
}
let openingTour = null;
function driveTour(dt) {
  const tour = state.tour;
  if (
    !tour ||
    transition() ||
    tour.status === "paused" ||
    tour.status === "complete"
  )
    return;
  if (tour.status === "dwelling") {
    dispatchTour({ type: "tick", dt });
    return;
  }
  const stop = tour.stops[tour.index];
  if (!stop) return;
  if (tour.status === "travelling" && !state.route) {
    if (stop.missing) {
      toast(
        `${stop.path || stop.molecule || stop.planet} is not mapped. Skipping this stop.`,
      );
      dispatchTour({ type: "missing" });
      return;
    }
    setCourse(
      {
        kind:
          stop.kind ||
          (stop.path ? "atom" : stop.molecule ? "molecule" : "body"),
        planetId: stop.planet,
        id: stop.id || stop.planet,
        path: stop.path,
        name: stop.path || stop.molecule || nameOf(stop.planet),
        mode: !stop.path && !stop.molecule ? "flyby" : "land",
      },
      { tour: true },
    );
  }
  if (tour.status === "opening" && !openingTour) {
    const atom = state.planetWorld?.atoms.find((a) => a.id === stop.id);
    if (!atom) {
      dispatchTour({ type: "missing" });
      return;
    }
    const token = {};
    openingTour = token;
    openAtom(atom, "tour").finally(() => {
      if (openingTour === token) openingTour = null;
    });
  }
}
async function refreshTours() {
  const source = state.source,
    request = ++tourRequest;
  if (!source) return;
  try {
    const result = await source.tours();
    if (source !== state.source || request !== tourRequest) return;
    state.tours = result.tours || [];
    state.tourErrors = result.errors || [];
    if (state.tour) {
      const updated = state.tours.find(
        (t) => (t.key || t.id) === state.tour.key,
      );
      state.tour = refreshTourState(state.tour, updated);
    }
    renderTourPanel();
  } catch (error) {
    if (source === state.source) {
      state.tourErrors = [{ error: error.message }];
      renderTourPanel();
    }
  }
}
function openTours() {
  if (!state.spaceWorld || transition()) return;
  clearInput();
  closePanels();
  $("tours").showModal();
  renderTourPanel();
  refreshTours();
}
function renderTourPanel() {
  $("tour-list").replaceChildren();
  $("tour-stops").replaceChildren();
  const sorted = [...state.tours].sort(
    (a, b) =>
      Number(b.planet === state.layer.planetId && !!b.planet) -
        Number(a.planet === state.layer.planetId && !!a.planet) ||
      Number(!!a.planet) - Number(!!b.planet) ||
      (a.planet || "").localeCompare(b.planet || "") ||
      a.title.localeCompare(b.title),
  );
  let group = null;
  for (const tour of sorted) {
    const next = tour.planet || "system";
    if (next !== group) {
      const h = document.createElement("h3");
      const body = state.spaceWorld?.bodies.find((b) => b.id === tour.planet);
      h.textContent = tour.planet
        ? body?.path || nameOf(tour.planet)
        : "System tours";
      $("tour-list").append(h);
      group = next;
    }
    const button = addButton(
      $("tour-list"),
      `${tour.title} · ${tour.stops.length} stops`,
      () => startTour(tour),
      "atlas-row",
    );
    button.title = tour.description || "";
  }
  for (const error of state.tourErrors) {
    const p = document.createElement("p");
    p.className = "folder-error";
    p.textContent = `${error.path || error.id || "Tour"}: ${error.error || error.message || error}`;
    $("tour-list").append(p);
  }
  if (!sorted.length && !state.tourErrors.length) {
    const p = document.createElement("p");
    p.textContent = "Surveying tour destinations…";
    $("tour-list").append(p);
  }
  const tour = state.tour;
  text(
    "tour-status",
    tour
      ? tour.status === "complete"
        ? `Tour complete: ${tour.visited.length} stops visited, ${tour.opened.length} files opened, ${number(tour.distance, 0)} units flown.`
        : `${tour.title} · ${tour.status} · stop ${Math.min(tour.index + 1, tour.stops.length)} of ${tour.stops.length}`
      : "Choose a tour, or build a queue in the atlas.",
  );
  for (const [index, stop] of (tour?.stops || []).entries()) {
    const li = document.createElement("li");
    li.textContent = `${nameOf(stop.planet)} / ${stop.path || stop.molecule || "Fly by"}${stop.missing ? " · missing" : ""}`;
    li.classList.toggle("current", index === tour.index);
    if (index === tour.index) li.setAttribute("aria-current", "step");
    $("tour-stops").append(li);
  }
  for (const id of ["tour-back", "tour-next", "tour-exit", "tour-export"])
    $(id).disabled = !tour;
  $("tour-resume").disabled = !tour;
  text(
    "tour-resume",
    tour?.status === "complete"
      ? "Fly again"
      : tour?.status === "paused"
        ? "Resume tour"
        : "Continue tour",
  );
  text(
    "tour-exit",
    tour?.status === "complete" ? "Explore freely" : "Exit tour",
  );
}
function showTourSummary() {
  clearInput();
  closePanels();
  $("tours").showModal();
  renderTourPanel();
}
function resumeTour() {
  if (!state.tour) return;
  if (state.tour.status === "complete") dispatchTour({ type: "restart" });
  else if (state.tour.status === "paused") dispatchTour({ type: "resume" });
  state.route = null;
  state.destination = null;
  closePanels();
  driveTour(0);
}
function skipTour(direction) {
  if (!state.tour) return;
  fileViewer.close();
  state.route = null;
  state.destination = null;
  dispatchTour({ type: "skip", direction });
  if (state.tour.status !== "complete") {
    closePanels();
    driveTour(0);
  }
}
function exitTour() {
  state.tour = null;
  state.route = null;
  state.destination = null;
  state.holding = true;
  closePanels();
  toast("Explore freely.");
}
async function copyTour() {
  if (!state.tour) return;
  try {
    await navigator.clipboard.writeText(exportTour(state.tour));
    toast("Tour JSON copied. Paste it into .space/tours to share it.");
  } catch {
    const area = document.createElement("textarea");
    area.value = exportTour(state.tour);
    area.setAttribute("aria-label", "Tour JSON to copy");
    $("tour-stops").replaceChildren(area);
    area.select();
    toast("Select and copy the tour JSON.");
  }
}
function queueAtom(atom, planetId) {
  const key = `${planetId}:${atom.id}`,
    existing = state.queue.findIndex((s) => s.key === key);
  if (existing >= 0) state.queue.splice(existing, 1);
  else if (state.queue.length < 64)
    state.queue.push({
      key,
      planet: planetId,
      path: atom.path || atom.id,
      kind: "atom",
      id: atom.id,
      open: true,
      note: "",
      dwellSeconds: 2,
    });
  renderQueue();
}
function renderQueue() {
  const parent = $("atlas-route-actions");
  parent.replaceChildren();
  if (!state.queue.length) return;
  const info = document.createElement("span");
  info.textContent = `${state.queue.length} atoms queued`;
  parent.append(info);
  addButton(parent, "Fly this route", () =>
    startTour({
      id: "my-route",
      key: "adhoc",
      title: "My route",
      stops: state.queue.map(({ key, ...stop }) => stop),
    }),
  );
  addButton(parent, "Clear", () => {
    state.queue = [];
    renderAtlas();
  });
}

function openAtlas() {
  if (!state.spaceWorld || transition()) return;
  clearInput();
  closePanels();
  state.atlasMode = "local";
  $("atlas-search").value = "";
  $("atlas").showModal();
  renderAtlas();
}
async function renderAtlas() {
  if (!state.spaceWorld) return;
  const request = ++atlasRequest,
    source = state.source,
    query = $("atlas-search").value.trim().toLowerCase(),
    onSurface = state.layer.name === "planet";
  text(
    "atlas-title",
    onSurface
      ? `${nameOf(state.layer.planetId)} / surface`
      : `${state.spacePayload.root.name} / system`,
  );
  text(
    "atlas-note",
    onSurface
      ? "Explore molecules and atoms. Other bodies plans a lift-off and landing route."
      : "Repositories are planets. Land to explore their atoms, or fly by a body.",
  );
  $("atlas-mode").replaceChildren();
  $("atlas-rankings").replaceChildren();
  $("atlas-results").replaceChildren();
  renderQueue();
  if (onSurface) {
    addButton($("atlas-mode"), "This body", () => {
      state.atlasMode = "local";
      renderAtlas();
    });
    addButton($("atlas-mode"), "Other bodies", () => {
      state.atlasMode = "bodies";
      renderAtlas();
    });
    addButton($("atlas-mode"), "Lift off", () => {
      closePanels();
      manualControl();
      beginTakeoff();
    });
  }
  if (query) {
    let atoms;
    if (onSurface && state.atlasMode === "local")
      atoms = state.planetWorld.atoms
        .filter((a) => a.path.toLowerCase().includes(query))
        .slice(0, 60)
        .map((a) => ({ ...a, planetId: state.layer.planetId }));
    else {
      text("atlas-results", "Searching surveyed atoms…");
      try {
        const result = await source.search(query);
        atoms = Array.isArray(result) ? result : result.results || [];
      } catch (error) {
        if (request === atlasRequest) text("atlas-results", error.message);
        return;
      }
    }
    if (request !== atlasRequest || source !== state.source) return;
    $("atlas-results").replaceChildren();
    for (const atom of atoms) {
      const body = state.spaceWorld.bodies.find((b) => b.id === atom.planetId);
      const relative =
        atom.path || atom.id.slice(body?.path ? body.path.length + 1 : 0);
      const a = { ...atom, path: relative };
      const row = atlasRow(
        atom.name || relative,
        `${nameOf(atom.planetId)} / ${relative} · ${formatBytes(atom.atomicMass ?? atom.bytes ?? 0)}`,
      );
      addButton(row, "Fly there", () =>
        setCourse({
          kind: "atom",
          planetId: atom.planetId,
          id: atom.id,
          path: relative,
          name: atom.name,
        }),
      );
      const queue = addButton(row, "Queue", () => {
        queueAtom(a, atom.planetId);
        queue.setAttribute(
          "aria-pressed",
          String(state.queue.some((s) => s.id === atom.id)),
        );
      });
      queue.setAttribute(
        "aria-pressed",
        String(state.queue.some((s) => s.id === atom.id)),
      );
    }
    if (!atoms.length)
      text(
        "atlas-results",
        "No mapped atoms match. Pending surveys will appear as they finish.",
      );
    return;
  }
  if (onSurface && state.atlasMode === "local") {
    for (const molecule of state.planetWorld.molecules) {
      const count = state.planetWorld.atoms.filter(
        (a) =>
          a.moleculeId === molecule.id || a.path.startsWith(`${molecule.id}/`),
      ).length;
      const row = atlasRow(
        molecule.id === "."
          ? "Landing site / root files"
          : molecule.path || molecule.id,
        `${formatBytes(molecule.molecularMass)} · ${count} atoms · T ${number(molecule.temperature)}${molecule.repo ? " · nested repository" : ""}${molecule.worktree ? " · worktree" : ""}`,
      );
      row.style.setProperty("--depth", molecule.depth);
      addButton(row, "Fly there", () =>
        setCourse({
          kind: "molecule",
          planetId: state.layer.planetId,
          id: molecule.id,
          name: molecule.path || "Landing site",
        }),
      );
    }
  } else {
    const bodies = state.spaceWorld.bodies;
    for (const [label, sort] of [
      ["Heaviest", (a, b) => b.restMass - a.restMass],
      ["Brightest", (a, b) => b.luminosity - a.luminosity],
    ]) {
      const group = document.createElement("div");
      const h = document.createElement("h3");
      h.textContent = label;
      group.append(h);
      for (const body of [...bodies]
        .filter((b) => !b.survey?.pending)
        .sort((a, b) => sort(a, b) || a.id.localeCompare(b.id))
        .slice(0, 5))
        addButton(group, body.name, () =>
          setCourse({
            kind: "body",
            planetId: body.id,
            id: body.id,
            land: true,
            name: body.name,
          }),
        );
      $("atlas-rankings").append(group);
    }
    for (const body of bodies) {
      const row = atlasRow(
        body.name,
        `${body.kind}${body.constellation ? " · " + body.constellation : ""} · ${body.partial ? "≥ " : ""}${formatBytes(body.restMass)} · ×${number(body.effMass / Math.max(body.restMass, 1))} · L ${number(body.luminosity)} bytes/day · ${body.git?.branch || "snapshot"} · ${number(distance(state.ship.position, body.center), 0)} units${body.survey?.pending ? " · surveying" : ""}`,
      );
      const land = addButton(row, "Land", () =>
        setCourse({
          kind: "body",
          planetId: body.id,
          id: body.id,
          land: true,
          name: body.name,
        }),
      );
      const fly = addButton(row, "Fly by", () =>
        setCourse({
          kind: "body",
          planetId: body.id,
          id: body.id,
          mode: "flyby",
          name: body.name,
        }),
      );
      land.disabled = fly.disabled = !!body.survey?.pending;
      if (body.kind === "overflow") {
        const details = document.createElement("details"),
          summary = document.createElement("summary");
        summary.textContent = "Overflow members";
        details.append(summary);
        const p = document.createElement("p");
        p.textContent = (body.members || [])
          .map((m) => (typeof m === "string" ? m : m.path || m.name || m.id))
          .join(", ");
        details.append(p);
        row.append(details);
      }
    }
  }
}
function atlasRow(title, detail) {
  const row = document.createElement("div");
  row.className = "atlas-row";
  const description = document.createElement("div"),
    strong = document.createElement("strong"),
    small = document.createElement("small");
  strong.textContent = title;
  small.textContent = detail;
  description.append(strong, small);
  row.append(description);
  $("atlas-results").append(row);
  return row;
}

function cycleOverlay() {
  const layer = surface() ? "planet" : "space",
    modes =
      layer === "space"
        ? ["off", "curvature", "energy", "light"]
        : ["off", "bonds", "temperature", "light"];
  state.overlays[layer] =
    modes[(modes.indexOf(state.overlays[layer]) + 1) % modes.length];
  try {
    localStorage.setItem(`space-drift-overlay-${layer}`, state.overlays[layer]);
  } catch {}
  updateOverlay();
}
function updateOverlay() {
  const mode = state.overlays[surface() ? "planet" : "space"];
  $("overlay-legend").hidden = mode === "off";
  $("overlay-legend").dataset.mode = mode;
  text("overlay-label", mode.toUpperCase());
  text(
    "overlay-description",
    {
      curvature: "Signed curvature: cyan valleys to violet peaks.",
      energy: "Excitation adds mass. Brighter rings hold more activity.",
      bonds: "Bonds connect nearby sibling atoms within each molecule.",
      temperature: "Cold blue to hot coral: activity agitates a molecule.",
      light: "Emission versus reflected light. Only recent activity emits.",
    }[mode] || "",
  );
  $("overlay-button").setAttribute(
    "aria-label",
    `Overlay: ${mode}. Click to cycle.`,
  );
}
function showConstants() {
  if (!state.spaceWorld) return;
  clearInput();
  closePanels();
  dl(
    "constants-values",
    Object.entries({
      ...C,
      G: state.spaceWorld.system.G,
      cSquared: state.spaceWorld.system.cSquared,
      G_S: state.planetWorld?.system.G_S || 0,
    })
      .filter(([, value]) => typeof value === "number")
      .map(([key, value]) => [key, number(value, 8)]),
  );
  $("constants").showModal();
}
function togglePause() {
  if (!state.launched || transition()) return;
  cancelShot();
  state.paused = !state.paused;
  clearInput();
  text("pause-button", state.paused ? "▷" : "Ⅱ");
  $("pause-button").setAttribute(
    "aria-label",
    state.paused ? "Resume flight" : "Pause flight",
  );
  toast(
    state.paused ? "Flight paused. Press Escape to resume." : "Flight resumed.",
  );
}
function showManual() {
  clearInput();
  closePanels();
  $("manual").showModal();
}
function updateMission() {
  const available = (state.spaceWorld?.bodies || []).reduce(
      (sum, b) => sum + (b.fileCount || 0),
      0,
    ),
    goal = Math.min(5, available),
    bodiesGoal = Math.min(3, state.spaceWorld?.bodies.length || 0);
  const files = Math.min(goal, state.charted.size),
    bodies = Math.min(bodiesGoal, state.landed.size),
    denominator = goal + bodiesGoal,
    progress = denominator ? (files + bodies) / denominator : 0;
  text("charted-count", String(state.charted.size).padStart(2, "0"));
  text("mission-total", `/ ${String(goal).padStart(2, "0")} atoms charted`);
  text("landed-count", state.landed.size);
  text("landed-total", bodiesGoal);
  $("mission-progress").style.width = `${progress * 100}%`;
  $("progress-arc").style.strokeDashoffset = String(82 * (1 - progress));
  text("mission-percent", `${Math.round(progress * 100)}%`);
  $("mission").querySelector("p").firstChild.textContent =
    `Chart ${goal} ${goal === 1 ? "atom" : "atoms"}. Land on ${bodiesGoal} ${bodiesGoal === 1 ? "body" : "bodies"}.`;
  text(
    "mission-state",
    progress === 1 ? "COMPLETE" : !available ? "AWAITING ATOMS" : "IN PROGRESS",
  );
}
function updateHUD(dt) {
  hudElapsed += dt;
  if (hudElapsed < 0.1) return;
  hudElapsed = 0;
  state.dialogOpen = anyDialog();
  const data = readInstruments(state, Date.now());
  state.instruments = data;
  if (state.launched && !state.paused && !anyDialog() && !transition()) {
    for (const notice of environmentalNotices(
      state.previousInstruments,
      data,
      state,
    ))
      toast(notice, true);
    state.previousInstruments = data;
  }
  text("flight-state", data.flight);
  text("speed", String(Math.round(data.speed)).padStart(3, "0"));
  $("speed-bar").style.width = `${Math.min(data.speed / 120, 1) * 100}%`;
  text(
    "coordinates",
    `X ${number(state.ship.position.x, 0)}   Y ${number(state.ship.position.y, 0)}   Z ${number(state.ship.position.z, 0)}`,
  );
  $("reticle").hidden =
    !state.launched || state.paused || anyDialog() || transition();
  $("reticle").style.left = `${(state.reticle.x * 0.5 + 0.5) * 100}%`;
  $("reticle").style.top = `${(-state.reticle.y * 0.5 + 0.5) * 100}%`;
  const target = state.reticle.target,
    range = surface() ? PROBE_RANGE : C.PROBE_RANGE_SPACE;
  $("reticle").dataset.locked = String(!!target && target.distance <= range);
  text(
    "reticle-label",
    target
      ? `Q · ${target.object.name || target.id} · ${number(target.distance, 0)} u${target.distance > range ? " · OUT OF RANGE" : ""}`
      : "",
  );
  $("tour-note").hidden =
    !state.tour ||
    !["dwelling", "opening", "reading"].includes(state.tour.status);
  text("tour-note-text", state.tour?.stops[state.tour.index]?.note || "");
  $("destination").hidden = !state.route;
  const destination = state.destination;
  if (state.route) {
    text(
      "destination-name",
      destination?.name ||
        state.route.legs[state.route.index]?.type ||
        "Following course",
    );
    text(
      "destination-distance",
      destination
        ? `${number(distance(state.ship.position, destination.position), 0)} units · leg ${state.route.index + 1}/${state.route.legs.length}`
        : `Leg ${state.route.index + 1}/${state.route.legs.length}`,
    );
  }
  $("astrophysics-panel").hidden = !state.spaceWorld || surface();
  $("chemistry-panel").hidden = !surface() || !state.planetWorld;
  $("file-panel").hidden = true;
  const layerName = surface() ? "SURFACE" : "SPACE",
    root = state.spacePayload?.root?.name || "LOCAL WORKSPACE";
  text(
    "view-label",
    surface()
      ? `${layerName} / ${state.planetPayload?.path || state.planetPayload?.name || root} / CHEMISTRY`
      : `SPACE / ${root} SYSTEM / ASTROPHYSICS`,
  );
  text("root-name", surface() ? nameOf(state.layer.planetId) : root);
  text("world-name", surface() ? nameOf(state.layer.planetId) : root);
  text(
    "scan-time",
    state.spacePayload
      ? `${data.survey.pending} SURVEYING · ${data.survey.partial} PARTIAL`
      : "CHOOSE A FOLDER",
  );
  text("privacy-note", "FILES STAY LOCAL");
  if (state.spaceWorld) {
    if (surface() && state.planetWorld) {
      text("stat-label-1", "MOLECULES");
      text("file-count", data.planet.molecules);
      text("stat-label-2", "ATOMS");
      text("district-count", data.planet.atoms);
      text("stat-label-3", "MASS");
      text(
        "world-size",
        `${state.planetPayload.survey?.partial ? "≥ " : ""}${formatBytes(data.sums.atoms.restMass)}`,
      );
    } else {
      text("stat-label-1", "BODIES");
      text("file-count", data.system.bodies);
      text("stat-label-2", "EMITTING");
      text(
        "district-count",
        state.spaceWorld.bodies.filter((b) => b.emits).length,
      );
      text("stat-label-3", "TOTAL MASS");
      text(
        "world-size",
        `${data.survey.partial ? "≥ " : ""}${formatBytes(data.sums.bodies.restMass)}`,
      );
    }
  }
  if (!surface() && data.space.nearest) {
    const near = data.space.nearest,
      b = state.spaceWorld.bodies.find((b) => b.id === near.id),
      partial = b.partial ? "≥ " : "";
    text("astro-name", b.name);
    text(
      "astro-meta",
      `${b.kind} · ${b.constellation || "ungrouped"} · ${b.git?.branch || "snapshot"} ${b.git?.head?.slice(0, 8) || ""} · ${b.git?.dirty || 0} dirty · ${b.survey?.pending ? "survey pending" : `${number(Math.max(0, (Date.now() - Date.parse(b.survey?.scannedAt || 0)) / 1000), 0)}s survey age`}`,
    );
    text("astro-formula", formula(b.elements));
    dl("astro-values", [
      ["Rest mass", `${partial}${formatBytes(b.restMass)}`],
      ["Excitation", `${partial}${formatBytes(b.effMass - b.restMass)}`],
      [
        "Effective / rest",
        `× ${number(b.effMass / Math.max(b.restMass, 1), 4)}`,
      ],
      ["Horizon radius", `${number(b.horizonRadius)} units`],
      ["Landing radius", `${number(b.landingRadius)} units`],
      ["To landing ring", `${number(near.distance - b.landingRadius)} units`],
      ["Curvature", number(data.field.curvature, 5)],
      ["Potential", number(data.field.potential, 3)],
      [
        "Escape / ship speed",
        `${number(near.escapeVelocity)} / ${number(data.speed)} units/sec`,
      ],
      [
        "Luminosity",
        `${number(b.luminosity)} bytes/day · ${b.emits ? "EMITTING" : "DARK"}`,
      ],
      ["Illumination", number(near.illumination, 4)],
      ["Surface gravity", `${number(near.gravity)} units/sec²`],
    ]);
  }
  if (data.planet) {
    const p = data.planet,
      a = p.nearest.atom,
      m = p.nearest.molecule,
      b = p.body;
    text("chem-atom", a ? a.name : "No atoms mapped");
    text(
      "chem-molecule",
      m
        ? `${m.path || m.id} · ${formula(m.elements)} · ${m.repo ? "nested repository " : ""}${m.worktree ? "linked worktree" : ""}`
        : "",
    );
    dl("chem-values", [
      ["Surface gravity", `${number(p.gravity)} units/sec²`],
      ["Altitude", `${number(p.altitude)} units`],
      ["Temperature at ship", number(p.temperature, 4)],
      ["Viscosity", `${number(data.field.damping)} /sec`],
      ["Cohesion potential", number(p.cohesion, 4)],
      ["Curvature", number(data.field.curvature, 5)],
      ...(a
        ? [
            ["Atom / element", `${a.name} / ${a.element}`],
            ["Atomic mass", formatBytes(a.atomicMass)],
            [
              "Lines / delta",
              `${a.linesExact ? "" : "~"}${a.lines ?? 0} / ${a.delta ?? 0}`,
            ],
            [
              "Excitation / ξ",
              `${formatBytes(a.effMass - a.atomicMass)} / ${number(a.xi, 4)}`,
            ],
            ["Bond well ε", number(a.epsilon, 4)],
            [
              "Status",
              `${a.status || "unknown"} · ${a.emits ? "EMITTING" : "DARK"}${state.charted.has(a.id) ? " · CHARTED" : ""}`,
            ],
          ]
        : []),
      ...(m
        ? [
            ["Molecule mass", formatBytes(m.molecularMass)],
            [
              "Molecule atoms / bonds",
              `${m.atomCount ?? state.planetWorld.atoms.filter((a) => a.moleculeId === m.id || a.path.startsWith(m.id + "/")).length} / ${m.bonds}`,
            ],
            ["Molecule temperature", number(m.temperature, 4)],
            ["Molecule luminosity", `${number(m.luminosity)} bytes/day`],
          ]
        : []),
    ]);
    dl("chem-body-values", [
      ["Effective mass", formatBytes(b.effMass)],
      ["Luminosity", `${number(b.luminosity)} bytes/day`],
      ["Excitation ratio ξ", number(b.xi, 4)],
    ]);
    const candidate = scanCandidate();
    const focused = state.shot?.file || candidate || target?.object || a;
    if (focused && state.launched) {
      const d = distance(focused.position, state.ship.position);
      $("file-panel").hidden = false;
      text(
        "file-status",
        state.shot
          ? state.shot.phase === "flight"
            ? "SHOT IN FLIGHT"
            : "SIGNAL HIT"
          : candidate && d > C.OPEN_RANGE
            ? "IN E SHOT RANGE"
            : state.charted.has(focused.id)
              ? "CHARTED SIGNAL"
              : d <= C.OPEN_RANGE
                ? "WITHIN SCAN RANGE"
                : "SIGNAL DETECTED",
      );
      text("file-name", focused.name);
      text("file-path", focused.path);
      text("file-distance", `${number(d, 0)} u`);
      text("file-type", focused.element || "ATOM");
      text("file-size", formatBytes(focused.atomicMass));
      text("file-age", focused.status || "unknown");
      $("scan").disabled =
        !candidate ||
        state.paused ||
        anyDialog() ||
        transition() ||
        !!state.shot ||
        !!state.probe;
      $("scan").firstChild.textContent = state.shot
        ? "Firing… "
        : !candidate
          ? "Aim ship or approach "
          : d > C.OPEN_RANGE
            ? "Fire to open "
            : "Open file ";
    }
  }
  const landing =
    state.spaceWorld && landable(state.spaceWorld, state.ship.position);
  text(
    "layer-prompt",
    !state.source
      ? "Connect a folder to discover its system."
      : state.layer.name === "descending"
        ? `Landing on ${nameOf(state.layer.planetId)}${state.layer.payloadReady ? "…" : " · surveying surface…"}`
        : state.layer.name === "ascending"
          ? `Lifting off from ${nameOf(state.layer.planetId)}…`
          : surface()
            ? state.shot
              ? `E · ${state.shot.file.name} · ${state.shot.phase === "flight" ? "FIRING" : "HIT"}`
              : scanCandidate()
                ? `E · ${scanCandidate().name} · ${distance(scanCandidate().position, state.ship.position) > C.OPEN_RANGE ? "FIRE TO OPEN" : "OPEN"}`
                : "L LIFT OFF · E AIM SHIP / OPEN NEARBY · Q AIM PROBE"
            : state.layer.capture.held
              ? `CAPTURED · L LAND ON ${nameOf(state.layer.capture.bodyId)}`
              : landing
                ? `L LAND ON ${landing.name}`
                : "Fly inside a landing ring · L LAND",
  );
  $("layer-prompt").dataset.shot = String(!!state.shot);
  $("land-button").disabled =
    !state.launched || transition() || (!surface() && !landing);
  $("land-button").querySelector("span").textContent = surface()
    ? "Lift off"
    : "Land";
  updateOverlay();
  updateMission();
  $("scene").dataset.telemetry = JSON.stringify(diagnostics());
}
function diagnostics() {
  state.dialogOpen = anyDialog();
  const data = readInstruments(state, Date.now()),
    tour = state.tour,
    stop = tour?.stops[tour.index];
  const result = {
    ...data,
    ready:
      !!activeWorld() &&
      (state.layer.name !== "planet" || state.layer.payloadReady),
    source: state.source
      ? {
          kind: state.source.kind,
          name: state.spacePayload?.root?.name || state.source.name,
          live: state.source.live,
        }
      : null,
    layer: {
      name: state.layer.name,
      planetId: state.layer.planetId,
      transition: state.layer.transition ? { ...state.layer.transition } : null,
      capture: { ...state.layer.capture },
    },
    launched: state.launched,
    paused: state.paused,
    position: { ...state.ship.position },
    velocity: { ...state.ship.velocity },
    yaw: state.ship.yaw,
    charted: [...state.charted],
    landed: [...state.landed],
    files: state.planetWorld?.atoms.length || 0,
    destination: state.destination
      ? {
          id: state.destination.id,
          name: state.destination.name,
          kind: state.destination.kind,
          position: { ...state.destination.position },
        }
      : null,
    route: state.route
      ? {
          legs: state.route.legs.map(({ approach, ...leg }) => ({ ...leg })),
          index: state.route.index,
        }
      : null,
    tour: tour
      ? {
          id: tour.id,
          index: tour.index,
          total: tour.stops.length,
          status: tour.status,
          planet: stop?.planet || null,
          stop: stop ? { ...stop } : null,
          visited: [...tour.visited],
          opened: [...tour.opened],
          skipped: [...tour.skipped],
          distance: tour.distance,
        }
      : null,
    reticle: {
      layer: state.layer.name,
      x: state.reticle.x,
      y: state.reticle.y,
      target: state.reticle.target
        ? {
            id: state.reticle.target.id,
            distance: state.reticle.target.distance,
          }
        : null,
      candidates: (surface()
        ? state.planetWorld?.atoms || []
        : state.spaceWorld?.bodies || []
      )
        .map((a) => {
          const p = v(a.position || a.center).project(camera);
          return {
            id: a.id,
            name: a.name,
            x: (p.x * 0.5 + 0.5) * innerWidth,
            y: (-p.y * 0.5 + 0.5) * innerHeight,
            depth: p.z,
            distance: distance(state.ship.position, a.position || a.center),
          };
        })
        .filter(
          (a) =>
            a.depth > -1 &&
            a.depth < 1 &&
            a.x > 0 &&
            a.x < innerWidth &&
            a.y > 0 &&
            a.y < innerHeight,
        )
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 32),
    },
    probe: state.probe
      ? {
          id: state.probe.id,
          progress: state.probe.progress,
          position: { ...state.probe.position },
        }
      : null,
    shot: state.shot
      ? {
          id: state.shot.file.id,
          phase: state.shot.phase,
          progress: state.shot.progress,
          start: { ...state.shot.start },
          end: { ...state.shot.end },
        }
      : null,
    scanCandidate: scanCandidate()
      ? {
          id: scanCandidate().id,
          distance: distance(scanCandidate().position, state.ship.position),
          range: SHOT_RANGE,
        }
      : null,
    light: { ...state.light },
    overlay: state.overlays[surface() ? "planet" : "space"],
    fps: Math.round(state.fps),
    drawCalls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
    liveEvents: state.spacePayload?.events?.length || 0,
    viewerOpen: fileViewer.isOpen,
    openedFile: fileViewer.path,
    bodies:
      state.spaceWorld?.bodies.map((b) => ({
        id: b.id,
        name: b.name,
        kind: b.kind,
        center: { ...b.center },
        radius: b.radius,
        restMass: b.restMass,
        effMass: b.effMass,
        luminosity: b.luminosity,
        xi: b.xi,
        landingRadius: b.landingRadius,
        pending: !!b.survey?.pending,
        revision: b.revision,
      })) || [],
  };
  // Serialize a fresh value: callers cannot mutate objects retained by the simulation.
  return JSON.parse(JSON.stringify(result));
}
window.__SPACE__ = window.__SPACE_DRIFT__ = Object.freeze({
  getState: diagnostics,
});

$("choose-folder").addEventListener("click", chooseFolder);
$("folder-button").addEventListener("click", chooseFolder);
$("snapshot-picker").addEventListener("click", chooseSnapshot);
$("folder-input").addEventListener("change", () => {
  const files = [...$("folder-input").files];
  $("folder-input").value = "";
  if (!state.choosing) return;
  state.choosing = false;
  updateFolderUI();
  if (files.length) connectSource(createSnapshotSource(files));
});
$("folder-input").addEventListener("cancel", () => {
  state.choosing = false;
  updateFolderUI();
});
$("disconnect-folder").addEventListener("click", disconnectFolder);
$("refresh-folder").addEventListener("click", () =>
  state.source?.live ? loadWorld() : chooseSnapshot(),
);
$("launch").addEventListener("click", launch);
$("scan").addEventListener("click", scanFile);
$("map-button").addEventListener("click", openAtlas);
$("atlas-search").addEventListener("input", renderAtlas);
$("land-button").addEventListener("click", landOrTakeoff);
$("overlay-button").addEventListener("click", cycleOverlay);
$("tour-button").addEventListener("click", openTours);
$("constants-button").addEventListener("click", showConstants);
$("details-button").addEventListener("click", () => {
  const open = document.body.classList.toggle("instruments-open");
  $("details-button").setAttribute("aria-expanded", String(open));
});
$("help-button").addEventListener("click", showManual);
$("all-controls").addEventListener("click", showManual);
$("pause-button").addEventListener("click", togglePause);
$("cancel-course").addEventListener("click", manualControl);
$("retry").addEventListener("click", () => location.reload());
$("currents-toggle").addEventListener("click", () => {
  state.fieldEnabled = !state.fieldEnabled;
  $("currents-toggle").setAttribute("aria-pressed", String(state.fieldEnabled));
  text("currents-state", state.fieldEnabled ? "ON" : "OFF");
});
$("tour-resume").addEventListener("click", resumeTour);
$("tour-back").addEventListener("click", () => skipTour(-1));
$("tour-next").addEventListener("click", () => skipTour(1));
$("tour-exit").addEventListener("click", exitTour);
$("tour-export").addEventListener("click", copyTour);
document
  .querySelectorAll(".close-dialog,.close-manual")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    clearInput();
    $("scene").focus({ preventScroll: true });
  });
}
const movementKeys = [
  "KeyW",
  "KeyS",
  "KeyA",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "KeyR",
  "KeyF",
  "ShiftLeft",
  "ShiftRight",
  "Space",
];
const actions = {
  KeyE: scanFile,
  KeyQ: fire,
  KeyC: recenter,
  KeyL: landOrTakeoff,
  KeyT: openTours,
  KeyG: cycleOverlay,
  KeyM: openAtlas,
  KeyH: showManual,
  Home: resetShip,
  Escape: togglePause,
  Enter: launch,
};
function keyDown(code) {
  if (movementKeys.includes(code)) {
    if (state.launched && !state.paused && !transition()) {
      if (code === "Space") {
        pauseTour();
        state.route = null;
        state.destination = null;
      } else manualControl();
      keys.add(code);
      tapUntil.set(code, performance.now() + 90);
    }
    return;
  }
  actions[code]?.();
}
addEventListener("keydown", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    anyDialog()
  )
    return;
  if (movementKeys.includes(event.code) || actions[event.code])
    event.preventDefault();
  if (event.repeat && !movementKeys.includes(event.code)) return;
  keyDown(event.code);
});
addEventListener("keyup", (event) => keys.delete(event.code));
addEventListener("blur", () => {
  clearInput();
  cancelShot();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearInput();
    cancelShot();
  }
});
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture(event.pointerId);
    if (!state.launched) launch();
    keyDown(button.dataset.key);
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    button.addEventListener(name, () => keys.delete(button.dataset.key));
}
let pointerStart = null;
function aim(event) {
  const rect = $("scene").getBoundingClientRect();
  state.reticle.x = clamp(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -0.97,
    0.97,
  );
  state.reticle.y = clamp(
    1 - ((event.clientY - rect.top) / rect.height) * 2,
    -0.97,
    0.97,
  );
}
$("scene").addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || !state.launched || anyDialog()) return;
  pointerStart = { x: event.clientX, y: event.clientY };
  $("scene").setPointerCapture(event.pointerId);
  aim(event);
});
$("scene").addEventListener("pointermove", (event) => {
  if (event.pointerType === "mouse" || pointerStart) aim(event);
});
$("scene").addEventListener("pointerup", (event) => {
  if (
    pointerStart &&
    Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) <
      6
  ) {
    aim(event);
    fire();
  }
  pointerStart = null;
});
$("scene").addEventListener("pointercancel", () => (pointerStart = null));

function animate(time) {
  requestAnimationFrame(animate);
  const now = time / 1000,
    frameDt = Math.max(0, now - (animate.last || now)),
    dt = Math.min(0.05, frameDt);
  animate.last = now;
  // Validate interruptions and open after the visible impact before freezing the frame.
  updateShot(dt);
  const paused = state.paused || anyDialog() || document.hidden;
  state.fps += ((frameDt ? 1 / frameDt : 60) - state.fps) * 0.02;
  if (!paused) state.time += frameDt;
  if (
    state.layer.name === "space" &&
    state.planetWorld &&
    Date.now() - state.lastTakeoffAt > C.PLANET_CACHE_MS
  ) {
    state.planetWorld = null;
    state.planetPayload = null;
    planetRenderer.reset();
  }
  if (state.spaceWorld)
    refreshWorldPhysics(
      state.spaceWorld,
      state.planetWorld,
      Date.now(),
      frameDt,
    );
  if (!paused && transition()) advanceLayer(frameDt);
  if (state.launched && !paused) {
    if (!transition() && activeWorld()) {
      driveTour(dt);
      const before = { ...state.ship.position };
      state.input = playerInput();
      if (!transition()) {
        stepShip(state.ship, state.input, activeWorld(), dt, {
          field: state.fieldEnabled,
        });
        if (state.tour)
          state.tour = tourReducer(state.tour, {
            type: "distance",
            distance: distance(before, state.ship.position),
          });
        updateCapture();
        if (state.layer.name === "planet") {
          const altitude = altitudeTakeoff(state.layer, state.ship, dt);
          state.layer.altitudeTime = altitude.elapsed;
          if (altitude.takeoff) beginTakeoff();
        }
      }
    }
    updateProbe();
  }
  const onSurface = surface(),
    world = activeWorld();
  spaceRenderer.setVisible(!!state.spaceWorld && !onSurface);
  planetRenderer.setVisible(!!state.planetWorld && onSurface);
  if (world) {
    const visual = (onSurface ? planetRenderer : spaceRenderer).update({
      world,
      spaceWorld: state.spaceWorld,
      now: Date.now(),
      dt,
      ship: state.ship,
      camera,
      targetId: state.reticle.target?.id,
      overlay: state.overlays[onSurface ? "planet" : "space"],
      fieldEnabled: state.fieldEnabled,
      events: world.payload?.events || [],
    });
    if (visual)
      state.light = {
        emitters: visual.emitters ?? visual.lights ?? 0,
        illumination: visual.illumination ?? C.AMBIENT,
        flashes: visual.flashes ?? 0,
        cooling: visual.cooling ?? 0,
        pointLights: visual.pointLights ?? 0,
      };
  }
  const p = v(state.ship.position),
    yaw = state.ship.yaw;
  let cameraTarget = p
    .clone()
    .add(new THREE.Vector3(Math.sin(yaw) * 32, 15, Math.cos(yaw) * 32));
  let look = p
    .clone()
    .add(new THREE.Vector3(-Math.sin(yaw) * 15, 2, -Math.cos(yaw) * 15));
  if (transition()) {
    const progress = state.layer.transition.progress,
      eased = progress * progress * (3 - 2 * progress);
    if (state.layer.name === "descending" && state.transitionBody) {
      cameraTarget = state.transitionStart.camera
        .clone()
        .lerp(
          v(state.transitionBody.center).add(
            v(state.layer.approach).multiplyScalar(
              state.transitionBody.radius + 3,
            ),
          ),
          eased,
        );
      look = v(state.transitionBody.center);
    } else {
      cameraTarget = state.transitionStart.camera
        .clone()
        .add(new THREE.Vector3(0, eased * 80, 0));
      look = p;
    }
    $("layer-transition").style.opacity = String(
      Math.max(0, (progress - 0.65) / 0.35),
    );
  } else $("layer-transition").style.opacity = "0";
  if (!state.launched) {
    cameraTarget = p.clone().add(new THREE.Vector3(32, 42, 80));
    look = onSurface
      ? p.clone().add(new THREE.Vector3(0, 0, -25))
      : new THREE.Vector3(0, 0, -100);
  }
  camera.position.lerp(
    cameraTarget,
    1 - Math.exp(-dt * (transition() ? 8 : 4)),
  );
  camera.lookAt(look);
  shipMesh.visible = !!world;
  shipMesh.position.copy(p);
  shipMesh.rotation.y = yaw;
  shipMesh.rotation.z = THREE.MathUtils.lerp(
    shipMesh.rotation.z,
    (state.input.turn || 0) * -0.25,
    0.1,
  );
  const speed = length(state.ship.velocity);
  shipMesh.userData.plume.scale.z = 0.2 + speed / 40;
  shipMesh.userData.plume.visible = speed > 2;
  shipMesh.userData.engine.material.size = 2.5 + speed / 50;
  if (!paused && world && !transition()) {
    trail.unshift(p);
    if (trail.length > 70) trail.pop();
    for (let i = 0; i < 70; i++)
      trail[Math.min(i, trail.length - 1)]?.toArray(trailPositions, i * 3);
    trailGeometry.attributes.position.needsUpdate = true;
  }
  shipTrail.visible = !!world && speed > 4 && !transition();
  navigationLine.visible = !!state.destination && !transition();
  if (state.destination) {
    const attr = navigationLine.geometry.attributes.position;
    attr.setXYZ(0, p.x, p.y, p.z);
    const q = state.destination.waypoint || state.destination.position;
    attr.setXYZ(1, q.x, q.y, q.z);
    attr.needsUpdate = true;
    navigationLine.computeLineDistances();
  }
  updateReticle();
  const highlighted = state.reticle.target?.object || state.destination;
  beacon.visible = state.launched && !!highlighted && !transition();
  if (highlighted) {
    beacon.position.copy(v(highlighted.position || highlighted.center));
    beacon.rotation.y = state.time * 0.8;
    beacon.scale.setScalar(
      highlighted.kind === "planet" ||
        highlighted.kind === "belt" ||
        highlighted.kind === "overflow"
        ? Math.max(1, highlighted.radius / 4)
        : 1,
    );
  }
  probeMesh.visible = !!state.probe;
  if (state.probe) probeMesh.position.copy(v(state.probe.position));
  updateHUD(dt);
  renderer.render(scene, camera);
}
addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
renderer.domElement.addEventListener("webglcontextlost", (event) => {
  event.preventDefault();
  state.paused = true;
  $("error").hidden = false;
  text(
    "error-message",
    "The graphics context was interrupted. Reload to return to the launch point.",
  );
});
initializeSource();
setInterval(loadWorld, 5000);
requestAnimationFrame(animate);
