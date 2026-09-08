import test from "node:test";
import assert from "node:assert/strict";
import { resolveShotAtom } from "../public/file-shots.js";
import { createFileShot } from "../public/model.js";

const atom = { id: "repo/README.md", position: { x: 0, y: 3, z: -60 } };
const ship = { position: { x: 0, y: 3, z: 0 }, yaw: 0 };
const shot = {
  ...createFileShot(ship, atom),
  sourceVersion: 2,
  planetId: "repo",
  generation: 4,
};
const context = {
  launched: true,
  paused: false,
  dialogOpen: false,
  hidden: false,
  layer: { name: "planet", planetId: "repo" },
  sourceVersion: 2,
  layerGeneration: 4,
  atoms: [atom],
};

test("ranged E shots reject interruptions, lost atoms, and reused paths in obsolete surfaces", () => {
  for (const change of [
    { launched: false },
    { paused: true },
    { dialogOpen: true },
    { hidden: true },
    { sourceVersion: 3 },
    { layerGeneration: 5 },
    { atoms: [] },
    { layer: { name: "ascending", planetId: "repo" } },
    { layer: { name: "planet", planetId: "other" } },
  ]) {
    assert.equal(
      resolveShotAtom(shot, { ...context, ...change }),
      null,
      JSON.stringify(change),
    );
  }
  assert.equal(resolveShotAtom(null, context), null);
});

test("cruising and same-generation refresh keep the canonical atom eligible without mutating flight", () => {
  const refreshed = { ...atom, position: { x: 4, y: 3, z: -60 } };
  const moving = {
    position: { x: 10, y: 3, z: -10 },
    velocity: { x: 2, y: 0, z: -25 },
    yaw: 1,
  };
  const before = structuredClone(moving);
  assert.equal(
    resolveShotAtom(shot, { ...context, atoms: [refreshed], ship: moving }),
    refreshed,
  );
  assert.deepEqual(moving, before);
  assert.deepEqual(shot.end, atom.position);
});
