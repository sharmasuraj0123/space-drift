// The welcome view uses the same Blender meshes as the playable world.
export function createShowcase({ THREE, scene, assets }) {
  const group = new THREE.Group();
  group.name = 'blender-model-preview';
  scene.add(group);
  const planet = assets.instantiate('planet_ocean');
  planet.position.set(24, 17, -4);
  planet.scale.setScalar(12);
  planet.rotation.z = -.22;
  group.add(planet);
  const moon = assets.instantiate('planet_basalt');
  moon.position.set(37, -1, 4);
  moon.scale.setScalar(4.5);
  group.add(moon);
  const ship = assets.instantiate('explorer');
  ship.position.set(13, 1, 13);
  ship.rotation.set(.12, -.42, -.15);
  ship.scale.setScalar(.95);
  group.add(ship);
  const molecule = assets.instantiate('molecule');
  molecule.position.set(28, -9, 9);
  molecule.scale.setScalar(5);
  group.add(molecule);
  for (const [i, name] of ['atom_code', 'atom_document', 'atom_data'].entries()) {
    const atom = assets.instantiate(name);
    const angle = i * Math.PI * 2 / 3;
    atom.position.set(28 + Math.cos(angle) * 3.2, -9 + Math.sin(angle) * 2, 9 + Math.sin(angle) * 2);
    atom.scale.setScalar(1.3);
    group.add(atom);
  }
  return {
    update({ visible, time = 0, compact = false, reducedMotion = false }) {
      group.visible = visible;
      if (!visible) return;
      group.scale.setScalar(compact ? .72 : 1);
      group.position.set(compact ? -7 : 0, compact ? 3 : 0, 0);
      planet.rotation.y = reducedMotion ? .4 : time * .05 + .4;
      ship.position.y = reducedMotion ? 1 : 1 + Math.sin(time * .55) * .3;
    },
  };
}
