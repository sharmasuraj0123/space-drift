# Space Drift

Fly a small ship through your local workspace as a two-layer universe. Repositories are planets; land on one to explore its folders as molecules and files as atoms. Bytes create mass, recent changes add excitation, and that excitation produces gravity, heat, and light which fade together. Press E to open an atom in a read-only local viewer.

## Use a local folder in the browser

Open the hosted HTTPS app and choose a folder through the folder button. The browser grants Space Drift read access to that selection; files are not uploaded. WebGL is required for the game.

- **Chrome and Edge:** the directory-handle picker allows the game to scan the chosen folder again every five seconds while the page is open. Edits and newly added or removed files become activity in the world. The picker requires a secure context (HTTPS, or a trusted loopback development address) and a direct click. See the [directory picker API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
- **Other browsers:** the directory-input fallback provides a snapshot of the selected files through `webkitdirectory`. Choose the folder again to refresh it after changes. The browser may label the selection as an upload, but Space Drift processes that selection locally. Relative paths come from the [browser's File API](https://developer.mozilla.org/en-US/docs/Web/API/File/webkitRelativePath).

Folder access lasts for this page session. Browsers can deny access to protected folders; choose another folder if the picker refuses it. The hosted app has no local Git-process access, native-app launching, or Finder integration. It shows the files exposed by your chosen folder, rather than reading Git history or watching disk traffic.

## Build and preview

Requires Node.js 20 or newer and npm for development and builds. The deployed app does not need a Node server.

```sh
cd space-drift
npm ci
npm run build
npm run preview
```

Open [the static preview](http://127.0.0.1:4190) and choose a folder in the browser. `npm run build` produces `dist/` from the public app plus the two Three.js runtime modules and their license. The preview serves only this output directory on loopback, with no file-scanning API. Stop it with Ctrl+C.

## Deploy to Vercel

Import this repository into Vercel with its repository root as the Root Directory. The included `vercel.json` selects the **Other** framework preset (`framework: null`), runs `npm run build`, and publishes `dist/`. These are the documented [Vercel build configuration fields](https://vercel.com/docs/project-configuration/vercel-json). No runtime functions or API rewrites are needed, and no environment variables are required by the app.

For CLI deployment, link the repository to the intended Vercel account/project, then deploy a preview:

```sh
vercel link
vercel deploy
```

Check the preview's folder selection, flight, and E file opening before promoting or deploying production. `.vercelignore` excludes local project metadata, dependencies, generated output, environment files, and the optional Node backend from deployment uploads. The build publishes only browser assets; selected folders never enter the build or deployment.

## Optional local server

The original Node mode remains available for automatic scanning and desktop-app opening:

```sh
npm start
```

Open [local server mode](http://127.0.0.1:4188). Its default map is the parent folder containing this repository (the `quirq` project in the original workspace). To select another folder or port:

```sh
npm start -- --root "/absolute/path/to/your/folder" --port 4188
```

The server stays on loopback. Stop it with Ctrl+C. Unlike the hosted app, it can use the local filesystem scanner and the supported macOS desktop opener.

## Fly

| Control | Action |
| --- | --- |
| W / S or up / down | Thrust / reverse |
| A / D or left / right | Steer |
| R / F | Rise / descend |
| Shift | Boost |
| Space | Brake |
| L | Land inside a body's landing ring; lift off from a surface |
| E | Open a surface atom within 18 units |
| Mouse / touch drag | Aim independently of the ship |
| Q / scene click | Fire a probe at an atom, or plan a landing route to a body |
| C | Recenter the reticle along the ship's heading |
| M | Layer-aware atlas, search, and route queue |
| T | Guided tours, resume, skip, and exit |
| G | Cycle the active layer's overlay |
| Home | Return to this layer's launch or landing site |
| Escape / H | Pause or resume / flight manual |

A one-body folder starts on its surface. A larger workspace starts in space. The first expedition asks you to chart five available atoms and land on up to three available bodies, so small folders remain completable. Touch buttons provide steering, thrust, braking, altitude, opening, probes, landing, tours, and overlays; **Details** opens the instrument panel on a narrow screen.

Cross a landing ring slowly to be captured and held; press L to land. Thrust releases capture. Boost can skim through a ring above escape speed. Taking off places you on the same approach side with outward velocity; capture re-arms after leaving 1.5 times the landing radius. On a surface, hold R with boost to climb; remaining above 80 units for one second lifts off automatically. Transitions disable flight integration and take 1.5 seconds down / 1.2 seconds up. Landing also waits for the survey; one failed retry causes an automatic lift-off.

The atlas can land, fly by, search across surveyed bodies, or fly to a local molecule or atom. Routes perform lift-off, interplanetary flight and landing when needed. A body-only fly-by stays in space. Manual steering cancels a route and pauses any tour. The Physics switch disables field forces while retaining collisions and the surface floor.

## How the map works

**System discovery.** The selected workspace is searched for repository markers up to three directory levels deep. Grouping folders become constellations. Loose files form a landable asteroid belt. Nested repositories remain molecules inside their parent planet, with their own Git enrichment where available. A workspace with more than 64 bodies uses a bounded overflow body whose members appear in the atlas. Linked worktrees are recognized from a `.git` file. Browser snapshots can omit empty/hidden Git markers; those selections still play as a belt and show the limitation.

**Matter.** An atom's rest mass is its file size in bytes. A molecule's mass is the sum of its direct atoms and child molecules. A body's mass is the sum of its atoms exactly once. Physical radii use logarithmic sizing; accounting mass stays additive. Constellation rings and nested surface rings pack with collision clearance. Root README files sit beside the landing site; a body without root files gets a safe nearby atom instead.

**Activity.** Each atom carries an excitation ledger. For a change of relative size rho, the previous excitation decays, then `mass × rho` is added, capped at the atom's mass at that event. Effective mass is rest mass plus excitation. The half-life is 72 hours. Node mode reads each repository's history from the last 90 days, ignores merge commits, and includes staged, dirty and untracked work. Churn is added plus deleted lines divided by current lines, capped at one. Binary/unavailable line counts use a bounded estimate. Nested Git enrichment is capped at eight repositories per body. Git failures and browser mode use modification times and observed changes instead. An existing file's snapshot touch adds at most 5% of its mass; a creation can fully excite it. A unique filesystem move carries its ledger; browser snapshots without stable identities may observe a delete and create instead.

**Space physics.** The potential of a body is `−G × effective mass / sqrt(distance² + radius²)`. The field adds all bodies and pulls the ship down the potential gradient. A derived G calibrates the heaviest surveyed rest-mass body to a pull of 50 units/sec² at twice its radius. The derived c² puts that body's rest horizon at twice its radius. Capture uses the larger of the current horizon and the radius plus a 30-unit atmosphere. These are designed game rules, not a simulation of real gravity or measured disk traffic. Recalibration blends over one second as discovery readiness changes.

**Surface physics.** A surface has a capped downward gravity, softened attraction to child molecules, short-range atom attraction with a continuous cutoff, and more drag around dense bonds. Hot molecules buffet the ship deterministically. The root molecule contributes mass but does not duplicate child cohesion or bond-entry events. The floor prevents falling through; the outer edge pushes inward. Boost provides enough lift to leave the surface. The chemistry and astrophysics panels show the same landed body's mass and luminosity at a common survey revision and time.

**Light.** Luminosity is the decay rate times remaining excitation, in bytes per day. A large cold file is massive and dark. A recent commit can make its body heavier and brighter in space, and heat and brighten its atoms and molecules on the surface. Other emitters illuminate dark neighbors with an inverse-square falloff. Emission uses element colors with hotter atoms approaching white. The active renderer uses at most eight body or molecule point lights plus a ship headlamp. Flashes mark actual excitation increases; deleted atoms briefly cool visually without remaining openable or contributing live mass.

Space overlays show curvature, energy, or light. Surface overlays show bonds, temperature, or light. Each layer remembers its own choice. Curvature instruments use the same finite-difference stencil as the field grid. **∑** opens the design and derived constants.

## Guided tours

A tour sequences routes, notes, file reading and short pauses. Closing a file advances the tour; steering or L pauses it, including across a layer change. T resumes from your current position. Completion shows visited stops, distance flown and files opened, with choices to fly again or explore freely.

Create a JSON definition in `<workspace>/.space/tours/` or `<body>/.space/tours/`:

```json
{
  "id": "read-first",
  "title": "Start with the map",
  "stops": [
    { "planet": "apps/my-project", "path": "README.md", "note": "Start here.", "open": true },
    { "planet": "apps/my-project", "molecule": "src", "note": "Explore the source.", "dwellSeconds": 3 },
    { "planet": "apps/another-project", "path": "src/main.js", "open": true }
  ]
}
```

File and molecule paths are body-relative; atom identity and copied viewer paths are workspace-relative. Omit `planet` in a per-body definition. Root repository id is `.`; loose belt and overflow ids are `__belt__` and `__overflow__`. Actual repositories with reserved names use an escaped id shown by the API. A body-only stop is a space fly-by. Definitions allow 1–64 stops; invalid definitions get individual errors and unmapped stops are skipped. Notes render as plain text.

When no authored onboarding tour exists, a generated tour visits the three heaviest bodies and two brightest, then explores the brightest body's readable entry points. Up to seven local stops prioritize README, PROJECT, PLAN, AGENTS/CLAUDE, package metadata, an entry point, the main source molecule and tests. Available file slots extend the route toward the five-file expedition. The separate action-gated onboarding redesign is not part of these guided tours.

In M, search for atoms and **Queue** several, then choose **Fly this route**. **Copy route JSON** in T exports the route to your clipboard. The game never writes tour files into the mapped folder.

## Open a file

E opens the nearest eligible atom within 18 units. Q or a scene click launches a cosmetic probe from the ship and opens its target on impact, without moving the ship. Surface probes reach 160 units, take 0.3–0.8 seconds, and recharge in 0.65 seconds. Space targeting reaches 600 units and plans a landing route. A miss or out-of-range shot gives feedback and opens nothing.

Text/code, images, PDFs, audio and video display in the read-only viewer. Text previews are capped at 256 KiB and rendered as text, including source HTML/SVG. Closing the viewer returns to the same position. Charting happens only after opening succeeds; reopening an atom does not duplicate progress.

Optional Node mode on macOS can open supported documents in their desktop app and source files in a text editor. Unknown/executable formats are revealed in Finder. Hosted mode keeps previews inside the browser and offers no desktop launcher.

## Local data access and bounds

Selected folders and previews stay on your device. No world payload contains file contents, and nothing is sent to Vercel, a database, or an AI service. The static host receives ordinary application-asset requests. Directory handles last for the page session; disconnecting or switching clears the previous world, caches, route, tour, probes and previews.

The application builds physics from metadata and Git statistics. Git itself may read working-tree data internally to compute dirty diffs; the game adds no separate working-tree text reader for physics. Git runs read-only with fixed argument arrays, optional locks disabled, and external diff/text conversion disabled. A linked worktree can reference a Git directory outside the mapped root; an unavailable directory falls back to snapshot excitation. Bounded `.space/tours` JSON and eligible package entry-point metadata are narrow, explicit content reads for tour navigation. A user-requested file preview is a separate content read.

Discovery is bounded to two seconds, surveys to 1.5 seconds per body with four concurrent surveys. Each body samples up to 2,500 files, 25,000 entries and 32 directory levels, sharing capacity across its top-level molecules. Git enrichment runs separately under a three-second budget with two concurrent jobs and a 15-second cache. Pending bodies remain navigable once surveyed; partial surveys display lower bounds honestly. The current surface is prioritized, other bodies refresh round-robin, and discovery repeats every 30 seconds. Read-space calls serve cached metadata without waiting for background enrichment. Compact search indexes survive idle surface-payload eviction.

Hidden entries, dependencies, generated folders, private-key extensions, unsafe paths and Node symlinks stay outside the file map. Marker discovery never makes `.git` readable through the viewer. Metadata exceptions cannot be opened through ordinary file routes. Browser directory-input snapshots do not refresh until reselected; live handles and Node mode poll every five seconds. Incomplete scans do not invent deletion or creation events.

The optional server binds to loopback, checks host/origin, and confines file access to mapped eligible paths. `/api/world` returns the system, `/api/planet?id=.` safely addresses the root body, `/api/planet/<id>` addresses other exact ids, `/api/search` reads indexes, and `/api/tours` returns resolved routes. `/api/file` and `/api/file-content` retain their preview bounds; `/api/open-file` requires same-origin JSON POST. Protocol version 3 advertises layers and search. Both browser sources expose the same two-layer world contract.

## Verify and develop

```sh
npm test
npm run check
npm run build
```

The Node test suite covers discovery, independent survey scheduling, Git statistics, excitation replay, additive mass, deterministic packing, conservative field derivatives, grid curvature, frame-rate-independent flight, layer guards, cached/retried loads, tour state, targeting, light accounting, browser handles, and HTTP file boundaries. See [implementation and verification notes](docs/spacetime-implementation.md) for the current branch's browser checks and measured budgets.

`window.__SPACE__.getState()` and its `window.__SPACE_DRIFT__` alias return independent read-only diagnostic snapshots. The same data appears on `#scene[data-telemetry]`: layers, flight state, field values, bodies, landed atoms, sums, survey status, routes, tours, probes, lighting and renderer counters. These expose observation only; journeys are tested through normal game controls.

| Files | Responsibility |
| --- | --- |
| `lib/discover.mjs`, `lib/scan.mjs`, `lib/git.mjs`, `lib/universe.mjs` | Optional Node discovery, bounded metadata and Git adapters |
| `public/universe-core.js`, `public/universe-reader.js` | Shared aggregation, ledgers and asynchronous surveys |
| `public/folder-source.js`, `public/server-source.js` | Browser and server source parity |
| `public/constants.js`, `energy.js`, `bodies.js`, `field.js`, `model.js` | Derived physics, packing and ship simulation |
| `public/layers.js`, `planet-loader.js`, `tours.js`, `probes.js` | Pure transitions, loading lifecycle, navigation and probes |
| `public/light.js`, `render-space.js`, `render-planet.js`, `render-light.js`, `render-common.js` | Shared light model and separate layer rendering |
| `public/main.js`, `instruments.js`, `index.html`, `styles.css` | Controls, routes, atlas, HUD and diagnostics |
| `public/viewer.js`, `preview.js`, `lib/files.mjs` | Local preview and file-access boundaries |
| `vercel.json`, `scripts/build.mjs`, `scripts/preview.mjs` | Static deployment and loopback preview |

Built with vanilla ES modules, [Three.js](https://threejs.org/), native browser file APIs and an optional Node.js server. Inspired by [Building games with Astra](https://developers.openai.com/blog/how-to-build-games-with-astra).
