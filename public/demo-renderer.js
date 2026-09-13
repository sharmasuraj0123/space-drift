// Training markers are presentation only: the mission owns navigation and success.
export function createDemoRenderer({ THREE, scene }) {
  const group = new THREE.Group();
  group.name = 'demo-navigation';
  group.visible = false;
  scene.add(group);

  const geometries = [], materials = [], instances = [];
  const geometry = value => { geometries.push(value); return value; };
  const material = (color, opacity, line = false) => {
    const options = { color, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false };
    const value = line ? new THREE.LineBasicMaterial(options) : new THREE.MeshBasicMaterial(options);
    materials.push(value);
    return value;
  };
  const cyan = new THREE.Color(0x68e4ef), periwinkle = new THREE.Color(0xaab8ff), mintWhite = new THREE.Color(0xd5fff2);
  const normal = new THREE.Vector3(0, 0, 1), up = new THREE.Vector3(1, 0, 0), direction = new THREE.Vector3();
  const start = new THREE.Vector3(), end = new THREE.Vector3(), delta = new THREE.Vector3();
  const dummy = new THREE.Object3D(), dotColor = new THREE.Color();

  const hoop = new THREE.Group();
  hoop.name = 'demo-target-hoop';
  group.add(hoop);
  const ringGeometry = geometry(new THREE.TorusGeometry(1, .014, 6, 80));
  const haloGeometry = geometry(new THREE.TorusGeometry(1, .054, 6, 80));
  const rimMaterial = material(periwinkle, .76), haloMaterial = material(cyan, .12);
  const rim = new THREE.Mesh(ringGeometry, rimMaterial), halo = new THREE.Mesh(haloGeometry, haloMaterial);
  hoop.add(halo, rim);

  const ticks = new THREE.InstancedMesh(geometry(new THREE.BoxGeometry(.018, .066, .018)), material(periwinkle, .6), 24);
  ticks.name = 'demo-hoop-ticks';
  instances.push(ticks);
  for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12;
    dummy.position.set(Math.cos(angle) * 1.12, Math.sin(angle) * 1.12, 0);
    dummy.rotation.set(0, 0, angle + Math.PI / 2);
    dummy.scale.setScalar(i % 3 === 0 ? 1.35 : .7);
    dummy.updateMatrix();
    ticks.setMatrixAt(i, dummy.matrix);
  }
  ticks.instanceMatrix.needsUpdate = true;
  hoop.add(ticks);

  const chevronPositions = new Float32Array(8 * 4 * 3);
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4, x = Math.cos(angle), y = Math.sin(angle), offset = i * 12;
    chevronPositions.set([x * 1.28 - y * .048, y * 1.28 + x * .048, 0, x * 1.18, y * 1.18, 0,
      x * 1.18, y * 1.18, 0, x * 1.28 + y * .048, y * 1.28 - x * .048, 0], offset);
  }
  const chevronGeometry = geometry(new THREE.BufferGeometry());
  chevronGeometry.setAttribute('position', new THREE.BufferAttribute(chevronPositions, 3));
  const chevronMaterial = material(cyan, .8, true);
  const chevrons = new THREE.LineSegments(chevronGeometry, chevronMaterial);
  hoop.add(chevrons);

  const arcPositions = new Float32Array(81 * 3);
  for (let i = 0; i <= 80; i++) {
    const angle = Math.PI / 2 - i * Math.PI / 40;
    arcPositions.set([Math.cos(angle) * 1.045, Math.sin(angle) * 1.045, .01], i * 3);
  }
  const arcGeometry = geometry(new THREE.BufferGeometry());
  arcGeometry.setAttribute('position', new THREE.BufferAttribute(arcPositions, 3));
  const arc = new THREE.Line(arcGeometry, material(cyan, .96, true));
  hoop.add(arc);
  const pulseMaterial = material(mintWhite, 0);
  const pulse = new THREE.Mesh(haloGeometry, pulseMaterial);
  pulse.name = 'demo-success-pulse';
  pulse.visible = false;
  hoop.add(pulse);

  const beacon = new THREE.Group();
  beacon.name = 'demo-destination-beacon';
  group.add(beacon);
  const coreMaterial = material(cyan, .9), beamMaterial = material(periwinkle, .3);
  const core = new THREE.Mesh(geometry(new THREE.OctahedronGeometry(1, 0)), coreMaterial);
  const beam = new THREE.Mesh(geometry(new THREE.CylinderGeometry(.035, .065, 1, 6, 1, true)), beamMaterial);
  beacon.add(core, beam);

  const dotMaterial = material(cyan, .7);
  const dots = new THREE.InstancedMesh(geometry(new THREE.OctahedronGeometry(1, 0)), dotMaterial, 16);
  dots.name = 'demo-approach-dots';
  dots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dots.frustumCulled = false;
  // Allocate instance colors during construction, never on the animation path.
  for (let i = 0; i < 16; i++) dots.setColorAt(i, cyan);
  dots.instanceColor.setUsage(THREE.DynamicDrawUsage);
  dots.count = 0;
  instances.push(dots);
  group.add(dots);

  let disposed = false, lastStatus = '', lastType = '', lastX = NaN, lastY = NaN, lastZ = NaN, celebrationAt = 0;
  const validPoint = point => point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);

  function reset() {
    group.visible = false;
    dots.count = 0;
    pulse.visible = false;
    lastStatus = ''; lastType = ''; lastX = NaN; lastY = NaN; lastZ = NaN;
  }

  // time is in seconds; progress is a presentation-only fraction from 0 to 1.
  function update(frame) {
    if (disposed) return;
    const target = frame?.target;
    if (!frame?.active || !validPoint(target?.position)) { reset(); return; }
    const time = Number.isFinite(frame.time) ? frame.time : 0;
    const radius = Number.isFinite(target.radius) ? Math.max(.5, target.radius) : 10;
    const destination = target.type === 'destination', celebrating = frame.status === 'celebrating';
    const changed = target.type !== lastType || target.position.x !== lastX || target.position.y !== lastY || target.position.z !== lastZ;
    if (celebrating && (lastStatus !== 'celebrating' || changed)) celebrationAt = time;
    lastStatus = frame.status; lastType = target.type;
    lastX = target.position.x; lastY = target.position.y; lastZ = target.position.z;
    group.visible = true;
    hoop.position.copy(target.position);
    hoop.scale.setScalar(radius * (destination ? .62 : 1));
    if (destination) hoop.quaternion.setFromAxisAngle(up, -Math.PI / 2);
    else {
      if (validPoint(target.direction)) direction.copy(target.direction); else direction.set(0, 0, -1);
      if (direction.lengthSq() < 1e-10) direction.set(0, 0, -1);
      direction.normalize();
      hoop.quaternion.setFromUnitVectors(normal, direction);
    }
    const brightness = .78 + Math.sin(time * 1.8) * .08;
    rimMaterial.color.copy(celebrating ? mintWhite : periwinkle);
    haloMaterial.color.copy(celebrating ? mintWhite : cyan);
    chevronMaterial.color.copy(celebrating ? mintWhite : cyan);
    ticks.material.color.copy(celebrating ? mintWhite : periwinkle);
    arc.material.color.copy(celebrating ? mintWhite : cyan);
    rimMaterial.opacity = celebrating ? .98 : brightness;
    haloMaterial.opacity = celebrating ? .2 : .1 + Math.sin(time * 1.8) * .02;
    chevronMaterial.opacity = celebrating ? .95 : .66 + Math.sin(time * 2.1) * .14;
    const progress = Number.isFinite(frame.progress) ? Math.min(1, Math.max(0, frame.progress)) : 0;
    arc.visible = progress > 0 || celebrating;
    arcGeometry.setDrawRange(0, celebrating ? 81 : Math.max(2, Math.floor(progress * 80) + 1));

    const phase = Math.min(1, Math.max(0, (time - celebrationAt) / 1.2));
    pulse.visible = celebrating && phase < 1;
    pulse.scale.setScalar(1.02 + phase * .42);
    pulseMaterial.opacity = celebrating ? .45 * (1 - phase) ** 2 : 0;

    beacon.visible = destination;
    if (destination) {
      beacon.position.copy(target.position);
      core.position.y = radius * (.28 + Math.sin(time * 1.5) * .025);
      core.scale.setScalar(radius * .11);
      core.rotation.set(0, time * .45, Math.PI / 4);
      coreMaterial.color.copy(celebrating ? mintWhite : cyan);
      beamMaterial.color.copy(celebrating ? mintWhite : periwinkle);
      beam.position.y = radius * .42;
      beam.scale.set(radius, radius * .82, radius);
      beamMaterial.opacity = celebrating ? .45 : .23 + Math.sin(time * 1.8) * .035;
    }

    dots.count = 0;
    if (!celebrating && validPoint(frame.ship?.position)) {
      start.copy(frame.ship.position); end.copy(target.position); delta.subVectors(end, start);
      const distance = delta.length();
      if (distance > 5) {
        // Stay clear of the ship and stop before the target's readable opening.
        const finish = Math.max(0, distance - radius * .8), begin = Math.min(5, finish);
        const count = Math.min(16, Math.max(0, Math.floor((finish - begin) / 3)));
        dots.count = count;
        for (let i = 0; i < count; i++) {
          const fraction = (i + 1) / (count + 1), along = (begin + (finish - begin) * fraction) / distance;
          const shimmer = .4 + .6 * (.5 + .5 * Math.sin(fraction * Math.PI * 3 - time * 3));
          dummy.position.copy(start).addScaledVector(delta, along);
          dummy.rotation.set(0, time * .25, Math.PI / 4);
          dummy.scale.setScalar(Math.min(.45, Math.max(.12, radius * .02)) * (.8 + shimmer * .3));
          dummy.updateMatrix(); dots.setMatrixAt(i, dummy.matrix);
          dotColor.copy(cyan).multiplyScalar(.35 + shimmer * .65); dots.setColorAt(i, dotColor);
        }
        dots.instanceMatrix.needsUpdate = true;
        dots.instanceColor.needsUpdate = true;
      }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    reset();
    for (let i = 0; i < instances.length; i++) instances[i].dispose();
    for (let i = 0; i < geometries.length; i++) geometries[i].dispose();
    for (let i = 0; i < materials.length; i++) materials[i].dispose();
    scene.remove(group);
    group.clear();
  }
  return { update, reset, dispose };
}
