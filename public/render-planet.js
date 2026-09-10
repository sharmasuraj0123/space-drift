import { JITTER_K, FLASH_SECONDS, L_MIN, ELEMENT_COLORS, OPEN_RANGE } from './constants.js';
import { emissionColor, bodyColor, luminosity, emits, remainingExcitation, skyStars, rgb } from './light.js';
import { createLightRenderer } from './render-light.js';
import { atomModelName } from './model-assets.js';
import { colorOf, vector, instanceEmission, disposeGroup, circle, createFieldSheet, createStars, createLabels } from './render-common.js';
const hash = (text) => { let value = 2166136261; for (const c of String(text)) value = Math.imul(value ^ c.charCodeAt(0), 16777619); return (value >>> 0) / 4294967296; };
const temperature = (m, now) => remainingExcitation(m, now) / Math.max(1, m.molecularMass || m.restMass || 0);

export function createPlanetRenderer({ THREE, scene, assets }) {
  if (!assets) throw new Error('The surface renderer requires the Space Drift model pack.');
  const group = new THREE.Group(); group.name = 'planet-layer'; scene.add(group);
  const geometryGroup = new THREE.Group(); group.add(geometryGroup);
  const lighting = createLightRenderer({ THREE, group, excludeRoot: true });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  let world, sheet, labels, focusLabels, focusSignature = '', moleculeMesh, bondsMesh, moleculeLines, sky, skySignature = '', cachedSpaceWorld = null;
  let atomBatches = [], ghostBatches = [];
  let shells = [], previousAtoms = new Map(), ghosts = [], hexCells = [], hexGeometry, lastHeat = 0, lastOverlay = '', suspended = false;
  function createAtomBatches(atoms, cooling = false) {
    const families = new Map();
    for (const atom of atoms) {
      const name = atomModelName(atom.element);
      if (!families.has(name)) families.set(name, []);
      families.get(name).push(atom);
    }
    return [...families].map(([name, members]) => {
      const geometry = assets.geometry(name);
      const material = cooling
        ? new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .48, depthWrite: false })
        : new THREE.MeshStandardMaterial({ roughness: .74, metalness: .22, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1 });
      if (!cooling) {
        geometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(members.length), 1));
        instanceEmission(material);
      }
      const mesh = new THREE.InstancedMesh(geometry, material, members.length);
      mesh.name = `${cooling ? 'cooling' : 'files'}:${name}`;
      mesh.userData.assetName = name;
      mesh.userData.atomIds = members.map(atom => atom.id);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      geometryGroup.add(mesh);
      return { mesh, members };
    });
  }
  function setWorld(next) {
    if (world && world.planetId !== next.planetId) { previousAtoms = new Map(); ghosts = []; lighting.reset(); }
    const oldGrid = sheet?.grid, now = next.now || Date.now();
    const atomIds = new Set(next.atoms.map((atom) => atom.id));
    for (const atom of previousAtoms.values()) if (!atomIds.has(atom.id)) ghosts.push({ ...atom, removedAt: now });
    ghosts = ghosts.filter((atom) => !atomIds.has(atom.id) && atom.removedAt + FLASH_SECONDS * 1000 > now).slice(-2500);
    previousAtoms = new Map(next.atoms.map((atom) => [atom.id, atom]));
    world = next;
    if (suspended) { lighting.setBodies(world.molecules.filter((m) => m.id !== '.'), now, world.atoms); return; }
    labels?.dispose(); focusLabels?.dispose(); focusLabels = null; focusSignature = ''; disposeGroup(geometryGroup); shells = []; sky = null; skySignature = ''; hexCells = [];
    const radius = world.surfaceRadius || 150, floor = world.floor ?? 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 120), new THREE.MeshBasicMaterial({ color: 0x111a35, transparent: true, opacity: .14, side: THREE.DoubleSide, depthWrite: false })); disc.rotation.x = -Math.PI / 2; disc.position.y = -.2; geometryGroup.add(disc);
    sheet = createFieldSheet(THREE, world, { surface: true, previous: oldGrid }); geometryGroup.add(sheet.group);
    const edge = circle(THREE, world.edgeRadius || radius + 20, 0x947cc9, true, 150); edge.position.y = .4; edge.material.opacity = .5; geometryGroup.add(edge);
    const rim = circle(THREE, radius, 0x68e4ef, false, 150); rim.position.y = .3; rim.material.opacity = .26; geometryGroup.add(rim);
    const children = world.molecules.filter((m) => m.id !== '.').sort((a, b) => (a.clusterRadius || 0) - (b.clusterRadius || 0));
    const labelsData = [];
    moleculeMesh = null;
    if (children.length) {
      const geometry = assets.geometry('molecule');
      geometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(children.length), 1));
      const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .7, metalness: .3, emissive: 0xffffff, emissiveIntensity: 1, transparent: true, opacity: .48, depthWrite: false });
      instanceEmission(material);
      moleculeMesh = new THREE.InstancedMesh(geometry, material, children.length);
      moleculeMesh.name = 'folders:molecule';
      moleculeMesh.userData.assetName = 'molecule';
      geometryGroup.add(moleculeMesh);
    }
    for (const [index, m] of children.entries()) {
      const r = m.clusterRadius || 12, color = m.color || bodyColor(m, world.atoms.filter((a) => a.moleculeId === m.id));
      // The centered open cage occupies the old shell's horizontal radius and height.
      dummy.position.set(m.center.x, m.center.y + r * .175, m.center.z);
      dummy.rotation.set(0, hash(m.id) * Math.PI * 2, 0);
      dummy.scale.set(r, r * .175, r);
      dummy.updateMatrix();
      moleculeMesh.setMatrixAt(index, dummy.matrix);
      moleculeMesh.setColorAt(index, colorOf(THREE, color));
      const ring = circle(THREE, r, colorOf(THREE, color)); ring.position.copy(vector(THREE, m.center)); ring.position.y = .6; ring.material.opacity = .21; geometryGroup.add(ring);
      if (m.repo) { for (let i = 0; i < (m.worktree ? 2 : 1); i++) { const marker = circle(THREE, r + 2.5 + i * 2, 0xffad9b, true); marker.position.copy(ring.position); marker.material.opacity = .6; geometryGroup.add(marker); } }
      shells.push({ m, ring, index }); labelsData.push({ text: `${m.name || m.path}${m.repo ? m.worktree ? ' ◉ worktree' : ' ◉ repo' : ''}`, position: { x: m.center.x, y: Math.min(30, r * .35) + 8, z: m.center.z } });
    }
    if (moleculeMesh) { moleculeMesh.instanceMatrix.needsUpdate = true; moleculeMesh.instanceColor.needsUpdate = true; }
    const hexPositions = [], hexColors = [], hexSize = Math.max(5, radius / 28), rowStep = hexSize * 1.5, colStep = hexSize * Math.sqrt(3);
    for (let row = -20; row <= 20; row++) for (let col = -20; col <= 20; col++) {
      const x = (col + (row & 1) * .5) * colStep, z = row * rowStep;
      if (Math.hypot(x, z) > radius - hexSize) continue;
      const molecule = children.find((m) => Math.hypot(m.center.x - x, m.center.z - z) <= m.clusterRadius), start = hexPositions.length / 3;
      for (let i = 0; i < 6; i++) for (const j of [i, i + 1]) { const a = j * Math.PI / 3 + Math.PI / 6; hexPositions.push(x + Math.cos(a) * hexSize, .15, z + Math.sin(a) * hexSize); hexColors.push(.14, .24, .38); }
      hexCells.push({ start, molecule });
    }
    hexGeometry = new THREE.BufferGeometry(); hexGeometry.setAttribute('position', new THREE.Float32BufferAttribute(hexPositions, 3)); hexGeometry.setAttribute('color', new THREE.Float32BufferAttribute(hexColors, 3));
    const hex = new THREE.LineSegments(hexGeometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .3, depthWrite: false })); geometryGroup.add(hex);
    atomBatches = createAtomBatches(world.atoms);
    ghostBatches = createAtomBatches(ghosts, true);
    const atomMap = new Map(world.atoms.map((atom) => [atom.id, atom]));
    function bondGeometry(records, molecular = false) {
      const positions = [], colors = [];
      for (const bond of records || []) {
        const a = bond.from || atomMap.get(bond.a)?.position, b = bond.to || atomMap.get(bond.b)?.position; if (!a || !b) continue;
        const ca = molecular ? [.47, .42, .68] : emissionColor(atomMap.get(bond.a)), cb = molecular ? ca : emissionColor(atomMap.get(bond.b));
        const count = molecular ? 3 : Math.min(3, Math.max(1, bond.order || 1)), length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        for (let line = 0; line < count; line++) { const offset = (line - (count - 1) / 2) * (molecular ? .24 : .13), dx = -(b.z - a.z) / length * offset, dz = (b.x - a.x) / length * offset;
          positions.push(a.x + dx, a.y + .3, a.z + dz, b.x + dx, b.y + .3, b.z + dz); colors.push(...ca.map((v) => v * .55), ...cb.map((v) => v * .55)); }
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: molecular ? .44 : .28, depthWrite: false }));
    }
    bondsMesh = bondGeometry(world.bonds); moleculeLines = bondGeometry(world.moleculeBonds, true); geometryGroup.add(bondsMesh, moleculeLines);
    labels = createLabels(THREE, labelsData, 'planet'); lighting.setBodies(children, now, world.atoms); lastHeat = 0; lastOverlay = '';
  }
  function updateSky(spaceWorld, now, ship) {
    if (!spaceWorld) return;
    const body = spaceWorld.bodies?.find((b) => b.id === world.planetId); if (!body) return;
    const stars = skyStars(body, spaceWorld.bodies, now), signature = stars.map((s) => s.id).join('|');
    const radius = Math.max(400, world.surfaceRadius * 1.4);
    if (!sky || signature !== skySignature) {
      if (sky) { geometryGroup.remove(sky); sky.geometry.dispose(); sky.material.dispose(); }
      sky = createStars(THREE, stars.map((s) => ({ position: { x: s.bearing.x * radius, y: s.bearing.y * radius, z: s.bearing.z * radius }, color: s.color, size: 5 + Math.log2(1 + s.luminosity / L_MIN) * 2 }))); geometryGroup.add(sky); skySignature = signature;
    }
    for (let i = 0; i < stars.length; i++) { const star = stars[i], bright = .35 + star.illumination * .65; sky.geometry.attributes.position.setXYZ(i, star.bearing.x * radius, star.bearing.y * radius, star.bearing.z * radius); sky.geometry.attributes.color.setXYZ(i, star.color[0] * bright, star.color[1] * bright, star.color[2] * bright); sky.geometry.attributes.size.setX(i, 5 + Math.log2(1 + star.luminosity / L_MIN) * 2); }
    sky.geometry.attributes.position.needsUpdate = true; sky.geometry.attributes.color.needsUpdate = true; sky.geometry.attributes.size.needsUpdate = true;
    if (ship) sky.position.copy(vector(THREE, ship.position));
  }
  function update({ world: next = world, spaceWorld = cachedSpaceWorld, now = Date.now(), dt = 0, ship, camera, targetId = null, overlay = 'off', fieldEnabled = true } = {}) {
    if (!world) return { emitters: [], illumination: [], flashes: [], cooling: [], pointLights: 0 };
    if (next !== world) setWorld(next); cachedSpaceWorld = spaceWorld;
    sheet.update(dt, overlay === 'bonds' || overlay === 'temperature' ? 'off' : overlay); sheet.group.visible = fieldEnabled || overlay !== 'off';
    const telemetry = lighting.update({ now, ship, bodies: world.molecules.filter((m) => m.id !== '.') });
    const moleculeMap = new Map(world.molecules.map((m) => [m.id, m])), closeAtoms = []; let targetAtom;
    for (const { mesh, members } of atomBatches) {
      members.forEach((atom, i) => {
        if (atom.id === targetId) targetAtom = atom;
        if (ship) { const d = (atom.position.x - ship.position.x) ** 2 + (atom.position.y - ship.position.y) ** 2 + (atom.position.z - ship.position.z) ** 2; if (d <= OPEN_RANGE ** 2) closeAtoms.push({ atom, d }); }
        const m = moleculeMap.get(atom.moleculeId), t = m ? temperature(m, now) : 0, seed = hash(atom.id) * 100, pulse = lighting.flash(atom.id, now);
        // Rotation conveys thermal vibration without moving matter outside its collider.
        dummy.position.copy(vector(THREE, atom.position));
        dummy.rotation.set(0, seed + Math.sin(now * .012 + seed) * JITTER_K * t * .18, 0);
        const r = atom.radius || .9;
        dummy.scale.set(r, r * 1.5, r);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        const base = rgb(ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.other), excited = emissionColor(atom, now), active = emits(atom, now);
        mesh.geometry.attributes.emission.setX(i, Math.min(.5, (active ? Math.min(.25, .07 + Math.log2(1 + luminosity(atom, now) / L_MIN) * .04) : 0) + pulse * .5));
        tint.setRGB(base[0] * .7 + excited[0] * .3, base[1] * .7 + excited[1] * .3, base[2] * .7 + excited[2] * .3).multiplyScalar(active ? .94 : .78);
        mesh.setColorAt(i, tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.geometry.attributes.emission.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    for (const { mesh, members } of ghostBatches) {
      const remaining = members.filter(atom => now < atom.removedAt + FLASH_SECONDS * 1000);
      mesh.count = remaining.length;
      mesh.visible = remaining.length > 0;
      remaining.forEach((atom, i) => {
        const fade = 1 - (now - atom.removedAt) / (FLASH_SECONDS * 1000);
        dummy.position.copy(vector(THREE, atom.position));
        dummy.rotation.set(0, hash(atom.id) * 100, 0);
        dummy.scale.set(atom.radius, atom.radius * 1.5, atom.radius);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        tint.copy(colorOf(THREE, rgb(ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.other))).multiplyScalar(fade);
        mesh.setColorAt(i, tint);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (now - lastHeat > 200 || overlay !== lastOverlay) {
      const attribute = hexGeometry.attributes.color;
      for (const cell of hexCells) { const t = cell.molecule ? temperature(cell.molecule, now) : 0; for (let i = 0; i < 12; i++) attribute.setXYZ(cell.start + i, .14 + t * .7, .24 + t * .08, .38 + t * .14); }
      attribute.needsUpdate = true; lastHeat = now; lastOverlay = overlay;
      for (const { m, ring, index } of shells) {
        const t = temperature(m, now);
        moleculeMesh.geometry.attributes.emission.setX(index, t * (overlay === 'temperature' ? .25 : .12));
        moleculeMesh.setColorAt(index, colorOf(THREE, m.color || bodyColor(m)).multiplyScalar(.55 + t * .35));
        ring.material.opacity = .18 + t * .55;
      }
      if (moleculeMesh) { moleculeMesh.geometry.attributes.emission.needsUpdate = true; moleculeMesh.instanceColor.needsUpdate = true; }
    }
    bondsMesh.material.opacity = overlay === 'bonds' ? .92 : overlay === 'light' ? .6 : .28; moleculeLines.material.opacity = overlay === 'bonds' ? .9 : .4;
    closeAtoms.sort((a, b) => a.d - b.d);
    const focusAtoms = [...new Map([...(targetAtom ? [targetAtom] : []), ...closeAtoms.slice(0, 2).map((item) => item.atom)].map((atom) => [atom.id, atom])).values()];
    const signature = focusAtoms.map((atom) => atom.id).join('|');
    if (signature !== focusSignature) {
      focusLabels?.dispose(); focusLabels = createLabels(THREE, focusAtoms.map((atom) => ({ text: `${atom.name || atom.path} · ${atom.element}`, kind: 'atom', color: `#${(ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.other).toString(16).padStart(6, '0')}`, position: { x: atom.position.x, y: atom.position.y + atom.radius * 1.5 + 3, z: atom.position.z } })), 'planet'); focusSignature = signature;
    }
    if (camera) { labels.update(camera, group.visible); focusLabels?.update(camera, group.visible); } updateSky(spaceWorld, now, ship);
    return { ...telemetry, overlayRange: sheet.range, drawables: geometryGroup.children.length };
  }
  function suspend() { if (suspended) return; suspended = true; labels?.dispose(); labels = null; focusLabels?.dispose(); focusLabels = null; focusSignature = ''; disposeGroup(geometryGroup); sheet = null; atomBatches = []; ghostBatches = []; moleculeMesh = null; sky = null; shells = []; hexCells = []; }
  function reset() { suspend(); world = null; previousAtoms = new Map(); ghosts = []; lighting.reset(); group.visible = false; }
  return { group, setWorld, update, suspend, reset, setVisible(value) { group.visible = value; if (!value) suspend(); else if (suspended && world) { suspended = false; setWorld(world); } }, dispose() { labels?.dispose(); focusLabels?.dispose(); disposeGroup(group); scene.remove(group); world = null; } };
}
