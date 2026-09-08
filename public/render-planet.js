import { JITTER_K, FLASH_SECONDS, L_MIN, ELEMENT_COLORS, OPEN_RANGE } from './constants.js';
import { emissionColor, bodyColor, luminosity, emits, remainingExcitation, skyStars, rgb } from './light.js';
import { createLightRenderer } from './render-light.js';
import { colorOf, vector, instanceEmission, disposeGroup, circle, createFieldSheet, createStars, createLabels } from './render-common.js';
const hash = (text) => { let value = 2166136261; for (const c of String(text)) value = Math.imul(value ^ c.charCodeAt(0), 16777619); return (value >>> 0) / 4294967296; };
const temperature = (m, now) => remainingExcitation(m, now) / Math.max(1, m.molecularMass || m.restMass || 0);

export function createPlanetRenderer({ THREE, scene }) {
  const group = new THREE.Group(); group.name = 'planet-layer'; scene.add(group);
  const geometryGroup = new THREE.Group(); group.add(geometryGroup);
  const lighting = createLightRenderer({ THREE, group, excludeRoot: true });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();
  let world, sheet, labels, focusLabels, focusSignature = '', atomsMesh, bondsMesh, moleculeLines, ghostsMesh, sky, skySignature = '', cachedSpaceWorld = null;
  let shells = [], previousAtoms = new Map(), ghosts = [], hexCells = [], hexGeometry, lastHeat = 0, lastOverlay = '', suspended = false;
  function setWorld(next) {
    if (world && world.planetId !== next.planetId) { previousAtoms = new Map(); ghosts = []; lighting.reset(); }
    const oldGrid = sheet?.grid, now = next.now || Date.now();
    const atomIds = new Set(next.atoms.map((atom) => atom.id));
    for (const atom of previousAtoms.values()) if (!atomIds.has(atom.id)) ghosts.push({ ...atom, removedAt: now });
    ghosts = ghosts.filter((atom) => atom.removedAt + FLASH_SECONDS * 1000 > now).slice(-2500);
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
    for (const m of children) {
      const r = m.clusterRadius || 12, color = m.color || bodyColor(m, world.atoms.filter((a) => a.moleculeId === m.id));
      const shellMaterial = new THREE.MeshBasicMaterial({ color: colorOf(THREE, color), transparent: true, opacity: .035 + (m.temperature || 0) * .06, side: THREE.DoubleSide, depthWrite: false });
      const shell = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), shellMaterial); shell.position.copy(vector(THREE, m.center)); shell.scale.y = .35; geometryGroup.add(shell);
      const ring = circle(THREE, r, colorOf(THREE, color)); ring.position.copy(vector(THREE, m.center)); ring.position.y = .6; ring.material.opacity = .21; geometryGroup.add(ring);
      if (m.repo) { for (let i = 0; i < (m.worktree ? 2 : 1); i++) { const marker = circle(THREE, r + 2.5 + i * 2, 0xffad9b, true); marker.position.copy(ring.position); marker.material.opacity = .6; geometryGroup.add(marker); } }
      shells.push({ m, shell, ring }); labelsData.push({ text: `${m.name || m.path}${m.repo ? m.worktree ? ' ◉ worktree' : ' ◉ repo' : ''}`, position: { x: m.center.x, y: Math.min(30, r * .35) + 8, z: m.center.z } });
    }
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
    const atomGeometry = new THREE.OctahedronGeometry(1, 0);
    atomGeometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array(world.atoms.length), 1));
    const atomMaterial = new THREE.MeshStandardMaterial({ roughness: .46, metalness: .18, vertexColors: true, emissive: 0xffffff, emissiveIntensity: 1 });
    // Instance color supplies spectra to diffuse and emissive channels.
    instanceEmission(atomMaterial);
    atomsMesh = new THREE.InstancedMesh(atomGeometry, atomMaterial, world.atoms.length); atomsMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); geometryGroup.add(atomsMesh);
    if (ghosts.length) { ghostsMesh = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .65 }), ghosts.length); geometryGroup.add(ghostsMesh); } else ghostsMesh = null;
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
    world.atoms.forEach((atom, i) => {
      if (atom.id === targetId) targetAtom = atom;
      if (ship) { const d = (atom.position.x - ship.position.x) ** 2 + (atom.position.y - ship.position.y) ** 2 + (atom.position.z - ship.position.z) ** 2; if (d <= OPEN_RANGE ** 2) closeAtoms.push({ atom, d }); }
      const m = moleculeMap.get(atom.moleculeId), t = m ? temperature(m, now) : 0, seed = hash(atom.id) * 100, vibration = JITTER_K * t, pulse = lighting.flash(atom.id, now);
      dummy.position.set(atom.position.x + Math.sin(now * .012 + seed) * vibration, atom.position.y + Math.sin(now * .014 + seed * 3) * vibration * .6, atom.position.z + Math.cos(now * .011 + seed * 2) * vibration);
      dummy.rotation.set(0, seed, .12); const r = atom.radius || .9; dummy.scale.set(r * (1 + pulse * .13), r * 1.5 * (1 + pulse * .13), r * (1 + pulse * .13)); dummy.updateMatrix(); atomsMesh.setMatrixAt(i, dummy.matrix);
      const c = emissionColor(atom, now), active = emits(atom, now), strength = active ? .85 : .52;
      atomsMesh.geometry.attributes.emission.setX(i, (active ? .6 + Math.min(1, Math.log2(1 + luminosity(atom, now) / L_MIN) * .18) : 0) + pulse * .8);
      tint.setRGB(c[0], c[1], c[2]).multiplyScalar(strength + pulse * .55); atomsMesh.setColorAt(i, tint);
    });
    atomsMesh.instanceMatrix.needsUpdate = true; atomsMesh.geometry.attributes.emission.needsUpdate = true; if (atomsMesh.instanceColor) atomsMesh.instanceColor.needsUpdate = true;
    if (ghostsMesh) { ghosts = ghosts.filter((atom) => now < atom.removedAt + FLASH_SECONDS * 1000); ghostsMesh.count = ghosts.length; ghostsMesh.visible = ghosts.length > 0; ghosts.forEach((atom, i) => { const fade = 1 - (now - atom.removedAt) / (FLASH_SECONDS * 1000); dummy.position.copy(vector(THREE, atom.position)); dummy.rotation.set(0, hash(atom.id) * 100, .12); dummy.scale.set(atom.radius, atom.radius * 1.5, atom.radius); dummy.updateMatrix(); ghostsMesh.setMatrixAt(i, dummy.matrix); tint.copy(colorOf(THREE, rgb(ELEMENT_COLORS[atom.element] || ELEMENT_COLORS.other))).multiplyScalar(fade); ghostsMesh.setColorAt(i, tint); }); ghostsMesh.instanceMatrix.needsUpdate = true; if (ghostsMesh.instanceColor) ghostsMesh.instanceColor.needsUpdate = true; }
    if (now - lastHeat > 200 || overlay !== lastOverlay) {
      const attribute = hexGeometry.attributes.color;
      for (const cell of hexCells) { const t = cell.molecule ? temperature(cell.molecule, now) : 0; for (let i = 0; i < 12; i++) attribute.setXYZ(cell.start + i, .14 + t * .7, .24 + t * .08, .38 + t * .14); }
      attribute.needsUpdate = true; lastHeat = now; lastOverlay = overlay;
      for (const { m, shell, ring } of shells) { const t = temperature(m, now); shell.material.opacity = .025 + t * .12 + (overlay === 'temperature' ? .05 : 0); ring.material.opacity = .18 + t * .55; }
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
  function suspend() { if (suspended) return; suspended = true; labels?.dispose(); labels = null; focusLabels?.dispose(); focusLabels = null; focusSignature = ''; disposeGroup(geometryGroup); sheet = null; atomsMesh = null; ghostsMesh = null; sky = null; shells = []; hexCells = []; }
  function reset() { suspend(); world = null; previousAtoms = new Map(); ghosts = []; lighting.reset(); group.visible = false; }
  return { group, setWorld, update, suspend, reset, setVisible(value) { group.visible = value; if (!value) suspend(); else if (suspended && world) { suspended = false; setWorld(world); } }, dispose() { labels?.dispose(); focusLabels?.dispose(); disposeGroup(group); scene.remove(group); world = null; } };
}
