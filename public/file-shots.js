/** Resolve an in-flight E shot only inside the surface generation that fired it. */
export function resolveShotAtom(shot, context) {
  if (
    !shot ||
    !context.launched ||
    context.paused ||
    context.dialogOpen ||
    context.hidden ||
    context.layer.name !== "planet" ||
    shot.planetId !== context.layer.planetId ||
    shot.sourceVersion !== context.sourceVersion ||
    shot.generation !== context.layerGeneration
  )
    return null;
  return context.atoms?.find((atom) => atom.id === shot.file.id) || null;
}
