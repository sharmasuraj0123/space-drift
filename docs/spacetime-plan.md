# Space Drift: spacetime implementation plan

Planning draft, 2026-09-08. Code baseline: `6b37efc`. This document proposes implementation; it does not mark any issue complete.

## Outcome

Keep the small ship and local file-opening loop. Replace the independent activity currents and file attraction with one explainable model: files are atoms, nested directories are molecules, top-level directories are planets, and changes excite atoms. The same remaining excitation increases a planet’s gravitational influence and produces its light. A pilot can find active work by flying toward a bright molecular cluster, read the file, and see its contribution to the planet’s mass.

## Issues read

The repository’s complete open/closed issue listing contained these nine spacetime issues. All were open, with no issue comments, at review time. The parent body supplies the current model and supersedes its earlier status-coloring scope.

| Issue | Responsibility | Implementation dependency |
| --- | --- | --- |
| [#9 — Spacetime](https://github.com/sharmasuraj0123/space-drift/issues/9) | Model, vocabulary, end-to-end acceptance | Parent; closes after all gates |
| [#11 — Matter](https://github.com/sharmasuraj0123/space-drift/issues/11) | Atoms, molecules, planets, additive mass, cluster layout | Shared contracts |
| [#12 — Change energy](https://github.com/sharmasuraj0123/space-drift/issues/12) | Git/snapshot changes, normalized churn, decay, effective mass | Shared contracts; integrates with #11 |
| [#13 — Curvature field](https://github.com/sharmasuraj0123/space-drift/issues/13) | Potential, acceleration, sampled curvature, horizons | #11 + #12; pure fixtures can start earlier |
| [#14 — Flight](https://github.com/sharmasuraj0123/space-drift/issues/14) | Gravity, braking, capture, escape, autopilot | #13 |
| [#15 — Sheet rendering](https://github.com/sharmasuraj0123/space-drift/issues/15) | Curved grid, contours, horizons, planet surfaces | #11 + #13 |
| [#16 — Light model](https://github.com/sharmasuraj0123/space-drift/issues/16) | Luminosity, element colors, illumination, transitions | #11 + #12; parallel with #13 |
| [#17 — Light rendering](https://github.com/sharmasuraj0123/space-drift/issues/17) | Glowing atoms, dark planets, headlamp, flashes | #15 + #16 |
| [#18 — HUD and documentation](https://github.com/sharmasuraj0123/space-drift/issues/18) | Matter panel, G overlays, atlas rankings, telemetry | Contracts early; completion after #14–17 |

Also read [#6 — Shoot-to-open](https://github.com/sharmasuraj0123/space-drift/issues/6), its two comments, [PR #8](https://github.com/sharmasuraj0123/space-drift/pull/8), and [#10 — Tours](https://github.com/sharmasuraj0123/space-drift/issues/10). PR #8 was open with merge conflicts and touches the same model, main loop, controls, styles and tests. Tours are a later consumer of arrival events, not a prerequisite for spacetime. Lensing, relativity, moving planets and chemical reactions remain outside this implementation.

## Decisions to settle before coding

These are proposed resolutions to gaps or contradictions in the issues, not changes already approved on GitHub.

1. **Keep the existing name and file interfaces.** Use `window.__SPACE_DRIFT__.getState()` and `#scene[data-telemetry]`; the issues’ `__SPACE__` references predate the rename. Keep file paths as atom IDs and retain `files`/`sectors` compatibility views for one release. Separate the existing visual `mass` from new raw-byte physical mass. `file.size` continues to mean bytes.

2. **Count matter once.** Each atom has one immediate owner. Molecules contain direct atoms and direct child molecules; planets contain direct molecules and free atoms. Only planets source gravity and interplanetary illumination. A synthetic root-files planet contains only root-level files. Directory totals mean represented, eligible bytes; partial scans must be labeled partial rather than claiming the full disk’s mass. Retain discovered empty directories with zero mass. Remove the semantic “Other folders” merge: more than 24 top-level folders must retain separate planet identities; 24 is the required performance fixture, not an excuse to merge unrelated matter. Stress-test larger bounded maps and adapt grid detail if necessary.

3. **Use the formulas rather than the rewrite examples.** With `delta = added + removed`, replacing every line of a same-length file gives approximately `rho = 2`, so that atom’s initial effective mass is approximately three times its rest mass. `rho = 1` doubles it. A planet doubles only when its mass-weighted excitation ratio reaches one; rewriting one small constituent cannot double the entire planet. Correct the examples and calibration acceptance accordingly.

4. **Make change precision explicit.** Git numstat supplies changed lines, not total line counts, and binary changes appear as `- -`. Exact text normalization requires bounded local line-count reads; proposed limits are 1 MiB per file and 32 MiB per refresh, cached by file identity and metadata. These byte caps apply to the line-count reader, not Git’s internal reads of blobs or working-tree files; metrics also need an elapsed-time budget. A line count is exact only after reaching EOF within the cap. Return counts only. Larger/unreadable/binary files use a labeled byte estimate or unavailable result. Snapshot size changes are estimates of churn; same-size modifications get a documented minimal nonzero estimate, never an invented exact diff. This expands automatic local reading beyond stat metadata, so documentation must say so. No contents are uploaded or included in the world response.

5. **Decay changes at their actual ages.** Use dated history contributions or an equivalent decay-weighted basis. Do not refresh all 90 days of churn using the latest commit date. Normalize historical deltas against current file length for the first version and state that approximation. Repeated polls, source recovery, staging, and committing must not duplicate excitation. A first non-Git scan is a baseline, not a creation event. Keep the energy ledger separate from the 40-event activity feed.

6. **Preserve free flight; define the sheet measurement.** Recommended: retain three-dimensional ship motion, derive acceleration from one softened three-dimensional potential, and render a fixed horizontal slice of that same potential. Show the signed numerical Laplacian of the slice as “map-plane curvature beneath the ship.” This needs a wording adjustment to #13/#18 rather than calling it three-dimensional curvature at the ship. The alternative is strictly planar gravity with independent altitude controls; pick one contract before the field and renderer split. Body centers, colliders, approach points and the sheet reference plane must share a documented coordinate system.

7. **Keep signed curvature.** For an isolated source centered on the sampled plane, its two-dimensional Laplacian is `G*M*(2*eps²-r²)/(r²+eps²)^(5/2)`. It changes sign outside `sqrt(2)*eps`. Test center maximum, linear scaling with mass, sign preservation and convergence toward zero; “signed curvature increases everywhere with mass” is not a valid acceptance condition. Show negative bands and the zero contour.

8. **Treat capture as reversible assistance.** Keep the exact `2*G*M_eff/C_SQUARED` horizon. A horizon can be inside a planet’s collision surface because physical mass and display radius scale differently; use an exterior surface arrival for such destinations rather than enlarging the reported horizon. Define escape as exiting that planet’s capture region, with required speed derived from the potential difference to an exterior point. Use a latched escape attempt and hysteresis so capture cannot zero the ship’s velocity on every tick. Brake/hold counteracts gravity through a controller; it does not switch gravity off.

9. **Choose deletion semantics explicitly.** Recommended first version: remove the deleted atom from live ownership, mass totals and file eligibility immediately, retain a non-openable visual tombstone for `FLASH_SECONDS`, and interpolate the well’s transition. That preserves exact live compositional mass and satisfies the short fade in #17. The parent’s description of deleted matter retaining a slowly decaying well would require a separate transient-matter ledger; do not mix these interpretations silently. A pure move transfers existing excitation and re-bonds ownership without manufacturing new content energy.

10. **Scope Git to the selected worktree.** For version one, use the containing worktree restricted to the selected subtree; nested repositories and files without usable Git history fall back per file to snapshots. Do not attribute the parent writings repository’s history to the nested Space Drift repository. Full multi-repository history discovery can be a follow-up. A single aggregate `git.enabled` flag is insufficient to explain mixed-source worlds; include per-file source and coverage. Detect nested `.git` directory/file boundaries without exposing their contents, including linked worktrees and submodules. Normalize Git outputs to selected-root-relative paths and intersect them with eligible scanner records; test changed siblings outside a selected subtree.

## Implementation sequence

### 0. Freeze interfaces and integration order

- Record the decisions above, units, fixtures and acceptance corrections. Use seconds for decay/luminosity calculations and explicitly convert timestamp milliseconds.
- Establish shared, browser-safe `public/constants.js` and `public/file-types.js`. Preview types and matter elements use one classification source with separate outputs.
- Introduce a versioned world contract. Keep `files[].size` as bytes; put normalized change values in `files[].change` (`source`, `unit`, `delta`, `size`, `rho`, `changedAt`, `quality`, decay basis). Add directory ownership/totals and Git status/coverage without exposing content.
- Resolve/rebase the existing probe PR before major changes to `main.js`, or agree an adapter boundary with its implementation. Keep E proximity opening, Q/click probes and C recentering compatible if PR #8 lands. Do not merge it as an incidental part of planning.
- Add one canonical file-open/charting action and arrival event contract for atlas, probes and future tours. Share the body-selector output between the nearest-file panel and reticle target.

### 1. Build matter and a verifiable map — #11

- Extend `lib/scan.mjs` with directory records, direct/subtree mapped bytes and coverage while preserving existing scan limits and symlink exclusions.
- Put hierarchy, masses, positions and bonds in a pure `public/matter.js`; let `buildWorld()` in `public/model.js` compose it. Retain compatibility views until the UI migration finishes.
- Use deterministic cluster placement, a capped nearest-neighbor bond graph and explicit exterior approach points. Separate rest-mass display radius from packing clearance. If the logarithmic surface cannot fit every crystal, grow the documented display/packing envelope or use level of detail; never bury inaccessible atoms or change their physical mass to make them fit.
- For #11, keep existing rendering usable through compatibility views; new planet surfaces and visible molecular bonds arrive in #15. The first PR proves the hierarchy in tests and telemetry.
- Preserve unaffected cluster positions across refreshes. Specify allowed local repacking in an affected molecule; keep ordering-determinism and addition-stability tests where they still apply.
- Gate: exact ownership and mass sums, root/empty/deep folders, partial maps, 40+ top-level directories, no overlapping collision envelopes, and an unobstructed approach point within E’s 18-unit range for every represented atom.

### 2. Build excitation accounting — #12

- Add `lib/git.mjs` for bounded read-only Git collection and `lib/file-metrics.mjs` for cached line counts. Use fixed argv, `execFile`, NUL-delimited formats, no optional locks, no external diff/text conversion, bounded output, a shared three-second collection deadline, and a 15-second success/failure cache.
- Metrics must read already-scanned eligible records through a shared checked-file-descriptor helper, with metadata checked before and after counting. Do not call `openMappedFile()` from enrichment: it calls the world reader and would create recursion or an in-flight promise deadlock. Discard counts when the file changes during reading.
- Use first-parent history with merges compared to their first parent so integrated changes count once. Use one net HEAD-to-working-tree diff, not the sum of staged and unstaged diffs. Handle unborn/detached HEAD, untracked paths, renames and unusual filenames.
- Enrich snapshot events with previous/current sizes and stable change identity. Maintain bounded per-file excitation state outside the display-event list. Preserve unchanged contribution timestamps; reconcile dirty-file contributions when commits absorb them. On Git timeout, keep the world responsive and reconcile fallback without replaying old energy when Git recovers.
- Keep snapshot detection on every five-second refresh even while Git results are cached. A new edit immediately creates a provisional contribution/flash with a stable change ID; later Git metrics replace it. Give updates a reason/revision: source recovery, denominator corrections and precision upgrades are measurement changes, not new flashes.
- Add pure `public/energy.js` for decay, weighted history bases, effective mass and signed refresh-to-refresh `dEnergy/dt`.
- Keep expensive enrichment off the file-preview validation path: `openMappedFile()` currently calls the world reader. Preserve fresh eligibility checks, but do not run history collection for each text/media request. Run bounded scan/enrichment work concurrently where independent and keep the combined response inside the existing client timeout; an expired metrics/Git budget yields a labeled fallback.
- Gate: 20-line versus 10,000-line normalization; 72-hour half-life; old and fresh history; unchanged repeated polls; edit→stage→commit without duplicate energy; same-size writes; binary estimates; rename/delete; mixed Git/snapshot roots; bounds and timeout behavior.

### 3. Develop field and light models in parallel — #13 and #16

- `public/field.js`: softened potential, analytic acceleration, exact horizons, sampled height/gradient/curvature arrays and interpolation. Bodies enter once through planet effective mass. Prefer cached typed arrays and a 65×65 sample grid as an initial calibration seed.
- `public/light.js`: luminosity from the same remaining excitation; additive body luminosity; element-based colors with bounded blue-white shift; clamped inverse-square irradiance; neighboring-body illumination; deduplicated flashes and tombstone transitions.
- Advance decay from an explicit clock even when no file metadata changes. Rebuild field targets on world refresh and interpolate one shared potential/source state used by acceleration, sheet geometry and field telemetry. Keep authoritative live mass/energy separate from explicitly reported transition-state field sources, especially during deletion, so visual wells and felt gravity stay synchronized. Use the same evaluation time for controls, HUD and lighting. Energy-only changes must invalidate dynamic buffers: the existing signature only covers path, bytes and mtime.
- Tune G for navigable acceleration, then C_SQUARED for horizon scale and energy units, and light exposure/thresholds for visibility. C_SQUARED cancels from effective mass for fixed rho; it cannot fix a wrong planet mass ratio. Keep raw mass uncompressed and display scaling explicit.
- Gate: finite-difference gradient, signed slice curvature and grid convergence, superposition, finite centers, linear horizons, interpolation endpoints, fixed-time luminosity halving, correct color mixing, inverse-square falloff and no duplicate flashes.

### 4. Integrate flight and the visible sheet in parallel — #14 and #15

- Extract pure navigation/holding logic into `public/navigation.js`. Replace the current velocity-to-target damping with explicit thruster acceleration and fixed 120 Hz accumulated steps; otherwise “no thrust” still brakes away inertial drift.
- Apply the field once per step. Retire `currentForce()` and the attraction branch of `resolveFileInteractions()` while retaining crystal collision coverage and adding planet-surface collision. Document controls/contact as external forces; gravity has one source.
- Implement brake/hold compensation, capture→hold→escape-attempt transitions, and gravity-aware approach/arrival. Preserve viewer pause, manual steering cancellation and Home recovery. Replace the old currents toggle and flow decoration as part of this migration.
- Add `public/render-field.js` and `public/render-matter.js`: reusable sheet buffers, contour bands/lines, horizon rings, planet meshes and outward-facing molecular clusters. Keep the current background/fog identity. Match interpolation, centers and approach points to the model.
- Gate: free fall and distant inertial drift; 30/60/144 Hz agreement; boosted and tip collisions; brake release drift; escape/recapture; guided arrival at the heaviest/lightest planet and dense file clusters; visibly matching well/contour/horizon values.

### 5. Make the physics visible and inspectable — #17 and #18

- Add `public/render-light.js`: per-instance emission, bond glow, dark planet materials, ship headlamp, short excitation pulses and deletion fades. Retain instancing rather than creating a material/light per atom. Pool at most eight planet point lights, choose by luminosity, and use emissive-only rendering for the remaining emitters.
- Replace strong global planet illumination with the specified low ambient and emitter/headlamp lighting. Keep the ship readable. Explain that the eight-light rendering budget approximates the full numerical illumination model.
- Add a matter panel from one shared selector: nearest/targeted atom, owning molecule and planet, byte mass, energy, effective mass, luminosity, emitting state, curvature and horizon distance. Free atoms have a clear “no molecule” state; empty/zero-mass bodies never display NaN ratios.
- G cycles off/curvature/energy/light with a legend and guarded localStorage persistence; add the equivalent touch control and constants readout. Atlas lists the five heaviest and brightest planets with stable tie-breaking and surface-safe set-course targets.
- Extend `__SPACE_DRIFT__` and DOM telemetry with the same selected values, field samples, source quality, light counts, capture/controller state and render timing. Preserve existing diagnostics needed by tests and probes.
- Update README, package pitch and flight manual, including real formulas, estimated change sources, automatic local line counting, G, capture/escape and the constants table. Keep tour implementation separate.

### 6. Run the complete story and close the parent

Use deterministic generated folders plus both the Space Drift repo (`--root .`) and the larger default Quirq map. Do not calibrate only against the small game repo and assume the default workspace behaves identically.

1. Start with a dormant heavy planet and an isolated cold neighbor: verify raw mass, gravity, low luminosity, readable contours and headlamp access.
2. Edit a small molecule, then stage and commit: see one excitation transition, stronger pull, deeper well and correct element color within one five-second world refresh, even with a warm 15-second Git cache. Verify no extra excitation merely from polling or staging.
3. Advance the injected clock by one half-life: excess mass and luminosity halve together. Unchanged geometry must still reflect the decay.
4. Move a file, delete another, and simulate a partial scan: ownership remains correct, ghosts cannot open deleted files, and incomplete scans do not invent deletion events. When a cap changes the represented sample, accept the new represented mass with an explicit coverage-change status; do not create excitation, flashes or deletion tombstones for atoms entering/leaving the sample. Test a file crossing the sampling boundary without being deleted.
5. Fly to heavy and light planets, enter/escape capture, open with E, return from the viewer, and exercise probes if merged. Validate hooks for a future tour without implementing #10.
6. Verify all overlays, atlas rankings, matching telemetry, 1280×800 and 390×844 layouts, keyboard/touch controls and a clean browser console.

Run `npm test` and extend `npm run check` to every new module. Preserve file-access/security tests and replace only assertions whose old physics is deliberately retired. Benchmark separately from fragile single-run timing assertions: warmed distributions for grid sampling (<5 ms for 24 bodies), sheet/contours (≤2 ms added frame time), and lighting (≤1 ms additional), with draw calls, triangles, light count, resolution and hardware recorded. The stated “2020 laptop” budget needs a named device or agreed equivalent; measurements on another machine must be identified as such. Also measure dense 2,500-file and >24-planet maps.

## Suggested first milestone

Deliver contracts plus #11 as a reviewable first PR, followed by #12. Verify an atom, its molecule and planet through telemetry and tests, with provably additive byte mass and a reachable file, while retaining the existing renderer. Visible bonds and new planetary surfaces follow in #15. Once excitation accounting passes, run #13 and #16 in parallel, then integrate flight and rendering. No implementation, issue edits, PR merges or pushes have been performed as part of this planning task.
