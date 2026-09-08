/** A visible E shot: nose flash, travelling beam, then a short impact glow. */
export function createShotRenderer({ THREE, scene, glow = null }) {
  const group = new THREE.Group();
  group.name = 'file-shot';
  group.visible = false;
  scene.add(group);

  // Geometry gives the beam a reliable width on devices with one-pixel WebGL lines.
  const geometry = new THREE.CylinderGeometry(.16, .16, 1, 8);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0x68e4ef, transparent: true, depthTest: false, depthWrite: false,
    toneMapped: false, blending: THREE.AdditiveBlending,
  });
  const glowMaterial = new THREE.SpriteMaterial({
    map: glow, color: 0xdafaff, transparent: true, depthTest: false,
    depthWrite: false, toneMapped: false, blending: THREE.AdditiveBlending,
  });
  const muzzleMaterial = glowMaterial.clone();
  const beam = new THREE.Mesh(geometry, beamMaterial);
  const headGlow = new THREE.Sprite(glowMaterial);
  const muzzle = new THREE.Sprite(muzzleMaterial);
  beam.name = 'beam'; headGlow.name = 'head'; muzzle.name = 'muzzle';
  for (const object of [beam, headGlow, muzzle]) {
    object.renderOrder = 10;
    group.add(object);
  }

  // Reuse every scratch vector and GPU resource across shots and frames.
  const start = new THREE.Vector3(), end = new THREE.Vector3();
  const head = new THREE.Vector3(), tail = new THREE.Vector3();
  const delta = new THREE.Vector3(), beamAxis = new THREE.Vector3(0, 1, 0);
  let disposed = false;

  function update(shot) {
    if (disposed) return;
    group.visible = !!shot && (shot.phase === 'flight' || shot.phase === 'impact');
    if (!group.visible) return;
    start.copy(shot.start); end.copy(shot.end);
    const progress = Math.max(0, Math.min(1, shot.progress));
    const age = Math.max(0, shot.age);
    const distance = Math.max(.0001, shot.distance);
    head.lerpVectors(start, end, progress);
    tail.lerpVectors(start, end, Math.max(0, progress - 18 / distance));
    delta.subVectors(head, tail);
    const length = delta.length();
    beam.visible = shot.phase === 'flight' && length > .01;
    if (beam.visible) {
      beam.position.copy(tail).add(head).multiplyScalar(.5);
      beam.quaternion.setFromUnitVectors(beamAxis, delta.divideScalar(length));
      beam.scale.set(1, length, 1);
    }
    headGlow.position.copy(head);
    headGlow.scale.setScalar(shot.phase === 'impact' ? 5 + age * 35 : 3.5);
    glowMaterial.opacity = shot.phase === 'impact' ? Math.max(0, 1 - age / .2) : 1;
    muzzle.position.copy(start);
    muzzle.scale.setScalar(4 + age * 20);
    muzzle.visible = shot.phase === 'flight' && age < .15;
    muzzleMaterial.opacity = Math.max(0, 1 - age / .15);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    group.visible = false;
    group.removeFromParent();
    group.clear();
    geometry.dispose();
    beamMaterial.dispose(); glowMaterial.dispose(); muzzleMaterial.dispose();
    // The caller owns glow. Sprite geometry is shared internally by Three.
  }

  return { update, dispose };
}
