# Space Drift: latest issue review

Reviewed 2026-09-08 against GitHub `main` at [`c0fe90d`](https://github.com/sharmasuraj0123/space-drift/commit/c0fe90d67831b72e077c4799879a94099ff1486b). The spacetime specification was rewritten at approximately 12:04 UTC that day. This is an understanding and dependency review, not an implementation commitment or estimate for the whole project.

## Coverage and current state

Read all **18 issues: 15 open and 3 closed**, their available comments, and the open probe PR's description, changed-file list, and review status. Closed issues #1, #3, and #4 concern README/diagrams. The 15 open issues comprise the spacetime parent and its 11 sub-issues, plus probes, tours, and onboarding. No issue was closed or changed during this review.

The current app already has static Vercel build support, live browser-directory and snapshot sources, local previews with E, a single-layer map, manual flight, and atlas-guided arrival. It does not yet implement repository discovery, the two layers, the new fields, tours, a demo/tutorial, or ranged probes. [PR #8](https://github.com/sharmasuraj0123/space-drift/pull/8) remains open and unmerged; a fresh PR query reports `DIRTY` merge status. It changes the README, main loop, model, controls, styles, and model tests.

## The revised product

[Parent #9](https://github.com/sharmasuraj0123/space-drift/issues/9) now describes a workspace at two scales. Repositories become planets in space; a repository's folders and files become molecules and atoms on its surface. Loose files form a landable belt, grouping folders form constellations, and repositories beyond the body limit form an overflow body. Nested repositories remain molecules inside their enclosing planet. A one-body workspace starts on its surface.

```mermaid
flowchart LR
  W[Selected workspace] --> D[Discover repositories and loose files]
  D --> S[Space: planets, belt, overflow]
  S -->|L or route landing| P[Surface of one body]
  P --> M[Folders: molecule clusters]
  M --> A[Files: atoms]
  A -->|E or surface probe| F[Local file preview]
  P -->|L or altitude takeoff| S
```

The two scales share one accounting model: bytes supply rest mass, changes supply capped and decaying excess mass, and that same excitation determines effective mass and emitted light. Space flight uses gravity, landing rings, capture and escape. Surface flight uses downward gravity, cluster attraction, short-range atom attraction, bond-dependent damping, temperature-driven buffeting, contact and a floor. Hosted browser mode must support both layers, using snapshot change estimates instead of Git history.

## Issue-by-issue map

Numbers in the first column are the issue titles' implementation sequence, not GitHub issue numbers.

| Sequence | Issue | Required outcome | Main dependency |
| --- | --- | --- | --- |
| Parent | [#9](https://github.com/sharmasuraj0123/space-drift/issues/9) | Defines the shared model, vocabulary, payloads, transitions, amendments and end-to-end acceptance. | All sub-issues |
| 1 | [#20 — Universe](https://github.com/sharmasuraj0123/space-drift/issues/20) | Repository discovery, belt/overflow ownership, background per-body surveys, retained search index, layered server and browser source interfaces. | Shared contracts |
| 2 | [#11 — Matter](https://github.com/sharmasuraj0123/space-drift/issues/11) | Additive atom/molecule/body mass; deterministic constellation and surface layouts; bonds, nested-repo markers and colliders. | #20 |
| 3 | [#12 — Excitation](https://github.com/sharmasuraj0123/space-drift/issues/12) | Per-repository Git history and dirty changes, nested Git sources, capped excitation ledger, snapshot fallback, moves/deletions and shared decay. | #20; matter ownership agreed with #11 |
| 4 | [#13 — Fields](https://github.com/sharmasuraj0123/space-drift/issues/13) | Derived constants and one interface for gravity and molecular fields, including sampling and readable diagnostics. | #11, #12 |
| 5 | [#14 — Flight](https://github.com/sharmasuraj0123/space-drift/issues/14) | Integrate fields with existing damped controls, capture/release/skim/hold in space and gravity/contact/damping/buffet on surfaces. | #13 |
| 6 | [#21 — Layers and traversal](https://github.com/sharmasuraj0123/space-drift/issues/21) | Space/descending/surface/ascending state machine, L, failure recovery, spawn rules, multi-leg routes, tour state/API and telemetry. | #20, #11, #14 |
| 7 | [#15 — Space rendering](https://github.com/sharmasuraj0123/space-drift/issues/15) | Curved sheet, contours and rings, planets with molecular patches, constellations, distant points and transitions. | #11, #13, #21 |
| 8 | [#22 — Surface rendering](https://github.com/sharmasuraj0123/space-drift/issues/22) | Disc/grid, molecule shells, atom and bond instances, repo/worktree markers and the other bodies in the sky. | #11, #13, #21 |
| 9 | [#16 — Light model](https://github.com/sharmasuraj0123/space-drift/issues/16) | Shared luminosity, element colors and inter-body illumination from excitation; sums agree across scales. | #11, #12; can run alongside fields |
| 10 | [#17 — Light rendering](https://github.com/sharmasuraj0123/space-drift/issues/17) | Per-layer bright sources, bounded point lights, emissive material, flashes/cooling and shared headlamp. | #15, #22, #16 |
| 11 | [#18 — HUD and integration](https://github.com/sharmasuraj0123/space-drift/issues/18) | Two panels, atlases and overlay sets; flight feedback; physics toggle; tours; space aiming; touch controls; mission and docs. | Contracts early; completion after the other layers |
| Related | [#6 — Probes](https://github.com/sharmasuraj0123/space-drift/issues/6) | Surface probes open atoms; firing at a body in space starts a landing route under the parent's amendment. | Existing PR #8; #18 space integration |
| Related | [#10 — Tours](https://github.com/sharmasuraj0123/space-drift/issues/10) | Local tour definitions, automatic routes and stop/open/pause/resume behavior, now spanning bodies and layers. | #21 state/routes/source work; #18 panels |
| Separate scope | [#19 — Onboarding](https://github.com/sharmasuraj0123/space-drift/issues/19) | Explain before picking, recommend one picker, demo, action-gated first flight, legend and actionable recovery. | Scope discussion; first-flight behavior must match the new layers |

These dependencies describe the required interfaces; they do not imply that every issue must be developed serially or that each is exactly one PR.

## What supersedes the previous plan

The saved [spacetime-plan.md](spacetime-plan.md) predates this rewrite and should not drive implementation unchanged.

| Previous draft | Current requirement |
| --- | --- |
| Top-level folders are planets in one world. | Discovered repositories are bodies; folder chemistry lives on a separate surface. |
| Keep a `files`/`sectors` bridge through the model migration. | Introduce explicit space/body payloads and `buildSpaceWorld`/`buildPlanetWorld`; any compatibility adapter needs its own contract. |
| Uncapped normalized churn and possible direct line-count reads. | Cap both `rho` and excitation; use Git-object line counts and byte-estimate fallback. No separate `dE/dt` ledger. |
| First-parent merge accounting and moves without fresh excitation. | The specified history excludes merges; moves carry excitation and add the `RHO_TOUCH` contribution. |
| Decide whether to add planar or three-dimensional movement. | Retain free three-dimensional movement, with different specified potentials and constraints per layer. |
| Tours are later consumers. | Tour state, resolution and multi-layer routes are owned by #21; panels are owned by #18. |
| Treat `__SPACE__` as an obsolete pre-rename reference. | Parent explicitly requests `__SPACE__`, retaining `__SPACE_DRIFT__` as an alias for one release. Product branding stays Space Drift. |
| Deletion could remove a source immediately. | New scope includes cooling/fading; live ownership and transient remnants need a consistent accounting rule. |

The earlier concerns about preserving mapped-file access, avoiding duplicated excitation, deterministic placement, signed/grid-consistent diagnostics and real-control browser verification still matter. The new spec resolves several earlier questions, especially excitation capping, capture re-arming, surface dimensionality and source parity.

## Decisions needed before implementation

These are review findings and recommendations, not changes already approved in the issues.

1. **Browser repository discovery and tour access.** Directory handles can inspect marker names without reading Git data, but a flat snapshot cannot infer a repository from an empty or omitted `.git` marker. Specify what happens when repository identity is unavailable instead of silently promising identical discovery. Add narrowly scoped tour-metadata access for `.space/tours`; keep hidden files excluded from ordinary maps/previews. Document any automatic tour or onboarding-metadata reads separately from on-demand file opening. Preserve the current source lifecycle (`kind`, `live`, `getFile`, `dispose`, cancellation) when adding layered methods. [#20](https://github.com/sharmasuraj0123/space-drift/issues/20), [#21](https://github.com/sharmasuraj0123/space-drift/issues/21), [#10](https://github.com/sharmasuraj0123/space-drift/issues/10)

2. **Root-body addressing and file identity.** Browser URL normalization turns both `/api/planet/.` and `/api/planet/%2E` into `/api/planet/`; matching the raw literal on the server does not fix normal browser requests. Keep the model's root id if desired, but use a query id or a reserved transport token. Separately, new `atom.path` is body-relative while current `viewer.js` opens `file.path` as root-relative. Introduce one explicit adapter using the canonical root-relative `atom.id`. The existing file-access helper still expects a callback result with `files[].path`; define that adapter and update old world-shape tests while preserving their access-boundary assertions. [#20](https://github.com/sharmasuraj0123/space-drift/issues/20)

   Also namespace or escape synthetic IDs: real repository folders may legally be named `__belt__` or `__overflow__`. Adapt `atomicMass` to the viewer's `size` metadata instead of handing new atoms to it unchanged. New asynchronous surveys also require file-opening tests to wait for represented membership.

3. **Packing and a reachable first file.** The specified circumference-based formulas do not guarantee non-overlap. Two constellation members with landing radius 108 produce center separation about 163, below the required 216. Three surface child slots of radius 100 on a ring of radius 106 have chord separation about 183.6, below 200. Use chord-aware clearance or a deterministic placement correction. A fixed spawn and hashed first-ring angles also cannot guarantee README is within E range. Reserve a safe approach/landing target, handle absent root files, and test the actual chosen target. [#11](https://github.com/sharmasuraj0123/space-drift/issues/11), [#21](https://github.com/sharmasuraj0123/space-drift/issues/21)

4. **Field boundary and time contracts.** The written atom potential abruptly becomes zero inside contact and beyond the cutoff; literal implementation gives discontinuities that conflict with a global gradient-equality claim. Agree continuous continuation/cutoff behavior or document excluded boundary cases. Buffeting is time-dependent and non-conservative, so its time input and derivative-test exclusions need to be explicit. Pending/all-zero bodies must have finite constants. [#13](https://github.com/sharmasuraj0123/space-drift/issues/13), [#14](https://github.com/sharmasuraj0123/space-drift/issues/14)

   Qualify calibration tests: use isolated rest-mass fixtures for center/maximum assertions, fixed geometry for mass-rescaling invariance, and a timestep-converged measurement for continuous thrust constants. Rebuilding logarithmic radii or measuring one finite integration step changes those comparisons.

5. **Refresh, landing and deletion lifecycle.** Remember payload readiness if loading finishes before the descent animation; finish only after both gates. Ensure capture cannot stop an automatic landing route indefinitely. Retain enough last-known geometry to lift off after a body disappears. Define how surveys, changing constants, retained positions and fading deleted bodies interact with collision safety and live mass sums. [#20](https://github.com/sharmasuraj0123/space-drift/issues/20), [#21](https://github.com/sharmasuraj0123/space-drift/issues/21)

   Use a common survey revision and evaluation timestamp when comparing a space summary with its surface atoms. A transition clock must keep advancing while flight controls and `stepShip` are disabled; adding transitions to the current pause flag would stop its simulation clock. Guard body loads/retries by source and layer generation, and invalidate removed-body indexes and obsolete ownership. Retain indexes across idle eviction, not across deletion or source replacement.

6. **Git accounting and privacy wording.** Object-store line counts avoid a separate direct text reader, but Git's dirty-worktree diff still reads working-tree data internally. State that precisely. Specify refresh/stage/commit deduplication, source recovery, rename transfer and shrinking-file normalization so excitation is never replayed accidentally and the cap remains meaningful. [#12](https://github.com/sharmasuraj0123/space-drift/issues/12)

7. **Mission, tutorial and tour completion.** The new five-atom/three-body mission needs a rule for one- or two-body worlds. Visiting a body during a fly-by is not landing on it. The enlarged generated tour and #10's original stop limit/completion claim need reconciliation. Onboarding must teach L before E for a multi-body start, while a single-body start is already landed; automatic tours cannot substitute for proving manual thrust/steering actions. [#18](https://github.com/sharmasuraj0123/space-drift/issues/18), [#19](https://github.com/sharmasuraj0123/space-drift/issues/19), [#21](https://github.com/sharmasuraj0123/space-drift/issues/21)

8. **Aggregate light color.** Several atoms below the individual emission threshold can collectively make an emitting body. A color mix restricted to individually emitting atoms is then empty. Define a fallback or use all positive luminosity contributions; clarify root-molecule participation in surface lighting. [#16](https://github.com/sharmasuraj0123/space-drift/issues/16), [#17](https://github.com/sharmasuraj0123/space-drift/issues/17)

9. **Discovery coverage, overflow and work budgets.** A repository below discovery depth three would be missed by discovery but skipped by the belt's `stopAtRepos` scan unless an explicit ownership rule handles it. Decide whether it joins the belt, overflow, or a clearly reported omitted region. Discovering whether a belt is empty may itself require a survey; allow a provisional pending belt or budget that check. Define overflow's aggregate caps and member-relative identities so its totals describe represented matter consistently. [#20](https://github.com/sharmasuraj0123/space-drift/issues/20)

   Separate metadata-ready from Git-ready states and use one shared Git deadline. Seven commands each receiving a three-second timeout could exceed the intended per-repository budget, and fifty repositories at two concurrent three-second slots already require 75 seconds before nested work. A sixty-second all-surveys acceptance cannot also require every worst-case Git enrichment to finish; slow Git should yield a labeled fallback without holding up the world. [#12](https://github.com/sharmasuraj0123/space-drift/issues/12)

## Onboarding sizing discussion

The owner's [sizing request](https://github.com/sharmasuraj0123/space-drift/issues/19#issuecomment-5584686330) asks for discussion before implementation. The collaborator's [final estimate](https://github.com/sharmasuraj0123/space-drift/issues/19#issuecomment-5584721506) corrects its earlier premature implementation acknowledgement and gives:

- **6–10 engineer-days** for the complete onboarding proposal, including integrated verification.
- **4–6 days** for a proposed minimum: explanation/privacy, recommended picker, essential recovery, and a first-file tutorial with touch and skip support.
- Under that minimum, demo, legend/annotations and remaining failure polish are deferred; the whole issue would remain incomplete.

No later scope approval appears in the reviewed discussion. That estimate assumes the current single-layer model; it is not an estimate for the new spacetime system and should be revisited for a tutorial that teaches landing and takeoff. The entry explanation/picker improvements can be discussed independently of the larger physics work.

## Basis for the next action plan

First settle the source, identity, geometry and lifecycle contracts above. Then organize work around: **universe and shared data → matter and excitation → fields and light models → flight, layers and routes → parallel space/surface rendering → light, HUD, tours and probe integration**. Specify HUD/telemetry contracts early rather than leaving their interfaces until the last phase. Resolve the old probe PR against the new architecture before merging it. Size and approve the onboarding slice separately, with its instructional language tied to the revised product.

The first useful end-to-end milestone should prove the same selected workspace in browser and server modes: discover bodies, land, open one canonical file, lift off, switch sources safely, and preserve exact represented-mass accounting. Visual polish and a full schedule come after those contracts are agreed.

No runtime code, issues, PRs, deployments, commits or remote branches were changed during this review. Only local review/plan documentation was updated.
