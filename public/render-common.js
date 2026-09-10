import { GRID_RESOLUTION } from './constants.js';
import { rgb, luminosity, remainingExcitation } from './light.js';
export const vector = (THREE, p = {}) => new THREE.Vector3(p.x || 0, p.y || 0, p.z || 0);
export function colorOf(THREE, value) { const c = rgb(value); return new THREE.Color(c[0], c[1], c[2]); }
export function instanceEmission(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = 'attribute float emission; varying float instanceEmission;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\ninstanceEmission = emission;');
    // Three exposes combined vertex/instance tint under USE_COLOR in the fragment stage.
    shader.fragmentShader = 'varying float instanceEmission;\n' + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= instanceEmission;\n#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )\ntotalEmissiveRadiance *= vColor.rgb;\n#endif');
  };
  material.customProgramCacheKey = () => 'space-drift-instance-emission-v2';
}
export function disposeGroup(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse((node) => { if (node.isInstancedMesh) node.dispose(); if (node.geometry) geometries.add(node.geometry); for (const m of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) { materials.add(m); if (m.map) textures.add(m.map); } });
  geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose()); textures.forEach((t) => t.dispose()); group.clear();
}
export function circle(THREE, radius, tint = 0xaab8ff, dashed = false, segments = 96) {
  const positions = [];
  for (let i = 0; i <= segments; i++) { const t = i / segments * Math.PI * 2; positions.push(Math.cos(t) * radius, 0, Math.sin(t) * radius); }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = dashed ? new THREE.LineDashedMaterial({ color: tint, transparent: true, opacity: .48, dashSize: Math.max(2, radius / 25), gapSize: Math.max(1, radius / 40) }) : new THREE.LineBasicMaterial({ color: tint, transparent: true, opacity: .48 });
  const ring = new THREE.Line(geometry, material); if (dashed) ring.computeLineDistances(); return ring;
}
export function gridValue(grid, x, z, key = 'heights') {
  if (!grid) return 0;
  const { bounds: b, resolution: n } = grid, values = grid[key] || grid.height;
  if (!b || !values || n < 2) return 0;
  const gx = Math.max(0, Math.min(n - 1, (x - b.minX) / Math.max(1e-9, b.maxX - b.minX) * (n - 1)));
  const gz = Math.max(0, Math.min(n - 1, (z - b.minZ) / Math.max(1e-9, b.maxZ - b.minZ) * (n - 1)));
  const ix = Math.min(n - 2, Math.floor(gx)), iz = Math.min(n - 2, Math.floor(gz)), tx = gx - ix, tz = gz - iz;
  return (values[iz * n + ix] * (1 - tx) + values[iz * n + ix + 1] * tx) * (1 - tz) + (values[(iz + 1) * n + ix] * (1 - tx) + values[(iz + 1) * n + ix + 1] * tx) * tz;
}
export function createFieldSheet(THREE, world, { previous = null, surface = false } = {}) {
  const radius = world.surfaceRadius || 500;
  const bounds = surface ? { minX: -radius, maxX: radius, minZ: -radius, maxZ: radius } : world.bounds || 900;
  const grid = world.field.sampleGrid(bounds, GRID_RESOLUTION);
  const n = grid.resolution, b = grid.bounds, positions = new Float32Array(n * n * 3), colors = new Float32Array(n * n * 3), start = new Float32Array(n * n);
  const lines = [], triangles = [], group = new THREE.Group(); let elapsed = 0, mode = '';
  const height = grid.heights || grid.height;
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * n + x, px = b.minX + x / (n - 1) * (b.maxX - b.minX), pz = b.minZ + z / (n - 1) * (b.maxZ - b.minZ);
    start[i] = previous ? gridValue(previous, px, pz) : height[i]; positions.set([px, start[i], pz], i * 3);
    if (x < n - 1) lines.push(i, i + 1); if (z < n - 1) lines.push(i, i + n);
    if (x < n - 1 && z < n - 1) triangles.push(i, i + n, i + 1, i + 1, i + n, i + n + 1);
  }
  const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3)); geometry.setIndex(lines);
  const wire = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .34, depthWrite: false })); group.add(wire);
  const fillGeometry = new THREE.BufferGeometry(); fillGeometry.setAttribute('position', geometry.attributes.position); fillGeometry.setAttribute('color', geometry.attributes.color); fillGeometry.setIndex(triangles);
  const fill = new THREE.Mesh(fillGeometry, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: .085, side: THREE.DoubleSide, depthWrite: false })); group.add(fill);
  const finite = [...grid.curvature].filter(Number.isFinite).sort((a, b) => a - b);
  let lo = finite[Math.floor(finite.length * .05)] || 0, hi = finite[Math.floor(finite.length * .95)] || 0, lastSample = world.now || Date.now();
  const curvatureAttribute = new THREE.BufferAttribute(new Float32Array(grid.curvature), 1); fillGeometry.setAttribute('curvature', curvatureAttribute);
  const contourMaterial = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { low: { value: lo }, high: { value: hi } },
    vertexShader: 'attribute float curvature; varying float k; void main(){k=curvature;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform float low;uniform float high;varying float k;void main(){float range=max(abs(low),abs(high));if(range<1e-15)discard;float value=k/range*5.0;float band=abs(fract(value+.5)-.5);float width=max(.012,fwidth(value));float a=(1.0-smoothstep(width,width*2.0,band))*.48;if(a<.015)discard;gl_FragColor=vec4(k<0.0?vec3(.4,.9,.95):vec3(.77,.65,1.0),a);}' });
  const contours = new THREE.Mesh(fillGeometry, contourMaterial); contours.renderOrder = 1; group.add(contours);
  function refresh() {
    const next = world.field.sampleGrid(bounds, GRID_RESOLUTION);
    for (let i = 0; i < n * n; i++) start[i] = positions[i * 3 + 1];
    height.set(next.heights || next.height); grid.curvature.set(next.curvature); curvatureAttribute.array.set(next.curvature); curvatureAttribute.needsUpdate = true;
    lo = next.legend?.min ?? 0; hi = next.legend?.max ?? 0; contourMaterial.uniforms.low.value = lo; contourMaterial.uniforms.high.value = hi;
    elapsed = 0; mode = ''; lastSample = world.now || Date.now();
  }
  function setOverlay(overlay) {
    if (overlay === mode) return; mode = overlay;
    let strengths = null, peak = 0;
    if (overlay === 'energy' || overlay === 'light') {
      strengths = new Float32Array(n * n);
      const sources = (world.bodies || world.molecules || []).filter((source) => !surface || source.id !== '.').map((source) => ({ center: source.center || source.position, radius: source.radius || source.clusterRadius || 1, value: overlay === 'light' ? luminosity(source, world.now) : remainingExcitation(source, world.now) })).filter((source) => source.value > 0);
      for (let i = 0; i < strengths.length; i++) {
        const x = positions[i * 3], z = positions[i * 3 + 2]; let value = 0;
        for (const source of sources) { const d2 = (x - source.center.x) ** 2 + (z - source.center.z) ** 2 + source.radius ** 2; value += source.value / (overlay === 'light' ? d2 : Math.sqrt(d2)); }
        strengths[i] = value; peak = Math.max(peak, value);
      }
    }
    for (let i = 0; i < n * n; i++) {
      const value = grid.curvature[i] || 0, t = Math.max(-1, Math.min(1, value / Math.max(1e-9, value >= 0 ? Math.abs(hi) : Math.abs(lo))));
      const base = overlay === 'curvature' ? t >= 0 ? [.52 + .22 * t, .55 + .1 * t, .95] : [.3, .62 - .28 * t, .74 - .2 * t] : overlay === 'energy' ? [.64, .43, .7] : overlay === 'light' ? [.75, .57, .4] : [.25, .34, .56];
      if (strengths) { const weight = Math.sqrt(strengths[i] / Math.max(1e-20, peak)); base[0] *= .18 + weight * .82; base[1] *= .18 + weight * .82; base[2] *= .18 + weight * .82; }
      colors.set(base, i * 3);
    }
    geometry.attributes.color.needsUpdate = true; contours.visible = overlay === 'curvature'; wire.material.opacity = overlay === 'off' ? .065 : .4; fill.material.opacity = overlay === 'off' ? .012 : .12;
  }
  function update(dt, overlay = 'off') {
    if (Math.abs((world.now || Date.now()) - lastSample) >= 500) refresh();
    elapsed = Math.min(1, elapsed + dt / .5); const t = elapsed * elapsed * (3 - 2 * elapsed);
    if (elapsed < 1 || geometry.userData.lastBlend !== 1) {
      for (let i = 0; i < n * n; i++) positions[i * 3 + 1] = start[i] + (height[i] - start[i]) * t;
      geometry.attributes.position.needsUpdate = true; geometry.userData.lastBlend = elapsed;
    }
    setOverlay(overlay);
  }
  const startGrid = { ...grid, heights: start };
  setOverlay('off'); return { group, grid, update, contours, wire, get range() { return { min: lo, max: hi }; }, heightAt: (x, z) => { const t = elapsed * elapsed * (3 - 2 * elapsed); return gridValue(startGrid, x, z) * (1 - t) + gridValue(grid, x, z) * t; } };
}
export function createStars(THREE, entries) {
  const geometry = new THREE.BufferGeometry(), positions = [], colors = [], sizes = [];
  for (const e of entries) { positions.push(e.position.x, e.position.y, e.position.z); colors.push(...rgb(e.color)); sizes.push(e.size || 6); }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); geometry.setAttribute('size', new THREE.Float32BufferAttribute(sizes, 1));
  const material = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, vertexColors: true,
    vertexShader: 'attribute float size; varying vec3 tint; void main(){tint=color;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);gl_PointSize=size;}',
    fragmentShader: 'varying vec3 tint; void main(){float d=length(gl_PointCoord-vec2(.5));if(d>.5)discard;float a=pow(1.0-d*2.0,2.0);gl_FragColor=vec4(tint,a);}' });
  const stars = new THREE.Points(geometry, material); stars.frustumCulled = false; stars.renderOrder = 2; return stars;
}
export function createLabels(THREE, entries, layer) {
  const container = typeof document === 'undefined' ? null : document.getElementById('labels'), projected = new THREE.Vector3();
  const labels = entries.slice(0, 120).map((entry) => { const el = container ? document.createElement('div') : null; if (el) { el.className = 'sector-label'; el.dataset.layer = layer; if (entry.kind) el.dataset.kind = entry.kind; el.textContent = entry.text; el.style.setProperty('--sector-color', entry.color || '#aab8ff'); container.append(el); } return { ...entry, el }; });
  return { update(camera, visible = true) {
    if (!container) return;
    const mobile = innerWidth <= 700, instrumentsOpen = mobile && document.body.classList.contains('instruments-open');
    for (const label of labels) {
      projected.copy(vector(THREE, label.position)).project(camera);
      const x = (projected.x * .5 + .5) * innerWidth, y = (-projected.y * .5 + .5) * innerHeight;
      const blocked = mobile ? instrumentsOpen || x < 245 && y < 330 : x < 310 && y < 400 || x > innerWidth - 325 && y < innerHeight - 140;
      label.el.hidden = !visible || projected.z > 1 || projected.z < -1 || x < 20 || x > innerWidth - 20 || y < 130 || y > innerHeight - (mobile ? 215 : 150) || blocked;
      label.el.style.left = `${x}px`; label.el.style.top = `${y}px`;
    }
  }, dispose() { labels.forEach((label) => label.el?.remove()); } };
}
