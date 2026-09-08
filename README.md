# Space Drift

![A ship flying through glowing folder districts and file crystals in space.](assets/space-drift-hero.svg)

Fly a small ship through a living map of a local folder. Folders form districts, files appear as crystals, file size gives objects mass, and file activity creates currents you can feel while flying. The hosted game runs entirely in your browser: choose a folder, fly through its metadata, and press E to read a file locally. An optional Node.js server can scan a folder automatically instead.

This README documents the shipped district/crystal explorer. The repository description's repositories as planets, folders as molecules, and files as atoms describe the planned [Spacetime model](docs/spacetime-plan.md), not the current map.

## Use a local folder in the browser

Open the [hosted app](https://quirq-test-xmu6.vercel.app) and choose a folder through the folder button. The browser grants Space Drift read access to that selection; files are not uploaded. WebGL is required for the game.

- **Chrome and Edge:** the directory-handle picker allows the game to scan the chosen folder again every five seconds while the page is open. Edits and newly added or removed files become activity in the world. The picker requires a secure context (HTTPS, or a trusted loopback development address) and a direct click. See the [directory picker API](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).
- **Other browsers:** the directory-input fallback provides a snapshot of the selected files through `webkitdirectory`. Choose the folder again to refresh it after changes. The browser may label the selection as an upload, but Space Drift processes that selection locally. Relative paths come from the [browser's File API](https://developer.mozilla.org/en-US/docs/Web/API/File/webkitRelativePath).

Folder access lasts for this page session. Browsers can deny access to protected folders; choose another folder if the picker refuses it. The hosted app has no local Git-process access, native-app launching, or Finder integration. It shows the files exposed by your chosen folder, rather than reading Git history or watching disk traffic.

## Build and preview

Requires Node.js 20 or newer and npm for development and builds. The deployed app does not need a Node server.

```sh
git clone https://github.com/sharmasuraj0123/space-drift.git
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

Open [local server mode](http://127.0.0.1:4188). The default map is the parent directory containing this repository. To select another folder or port:

```sh
npm start -- --root "/absolute/path/to/your/folder" --port 4188
```

The server stays on loopback. Stop it with Ctrl+C. Unlike the hosted app, the optional local server can use the filesystem scanner, and on macOS it supports desktop-app opening (documents open in their normal application; text and code use the text editor; unknown and executable formats are revealed in Finder).

## Fly

- W / up arrow: thrust forward.
- S / down arrow: reverse thrust.
- A / D or left / right arrows: steer.
- R / F: rise / descend.
- Shift: boost.
- Space: brake.
- E: open the selected file within 18 units. Opening a new file also charts it; visited files can be reopened.
- M: open the atlas; search for a file or choose a folder to fly there automatically. Any steering input returns manual control.
- Escape: pause or resume flight. H: open the flight manual.
- Home: return to the launch point.

Click **Launch expedition** to begin. Chart five files to complete the first expedition, then keep exploring. Exploration progress lasts for the current browser session. Touch controls provide forward thrust, left/right steering, and opening files; the atlas handles longer trips.

The interface includes exploration and navigation controls. A live directory handle or the optional local server refreshes the world every five seconds while the page is open; a directory-input snapshot requires choosing the folder again. Edit, add, rename, or move a file in your normal editor or file manager to create activity. The game itself does not change your files.

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Hosted app | Static HTML, CSS, and JavaScript ES modules | Runs the game without a backend. |
| 3D rendering | [Three.js](https://threejs.org/) | Draws the space map and ship. |
| Browser files | Directory handles or `webkitdirectory` file snapshots | Reads selected-folder metadata and on-demand local previews. |
| Build / preview | Node.js 20+ and native filesystem/HTTP APIs | Copies public assets and serves a local static preview. |
| Optional local server | Native `node:http`, filesystem APIs and streams | Supplies bounded filesystem scans, file previews, and desktop integration. |
| Tests | Node.js built-in test runner | Covers scanning, file access, physics, and HTTP boundaries. |

## Architecture

```text
Vercel / static host                     YOUR COMPUTER
┌─────────────────────┐           ┌────────────────────────────────────┐
│ HTML + CSS + JS     │ ────────>  │ Browser: ship, world, atlas, viewer │
│ Three.js modules   │           │                ↕                   │
└─────────────────────┘           │ Chosen local folder / file snapshot│
                                 └────────────────────────────────────┘
                                  Metadata and contents stay here.

Optional local mode on the same computer:
Browser ↔ 127.0.0.1 Node server ↔ eligible local files / macOS opener
```

The hosted app reads a user-selected folder through browser file APIs. Map metadata and file previews remain in the browser; there is no hosted `/api/world` or file-content service. In optional local-server mode, `/api/world` provides snapshots and the local file endpoints provide previews, with paths confined to the eligible map. The built `runtime.json` sets `localServer: false`, so hosted pages skip local API requests; the optional Node server overrides that route with `localServer: true`.

## Flight and exploration flow

```text
Open Space Drift
    |
    v
Choose folder / load local snapshot ----> districts, file crystals, activity currents
    |
    v
Launch expedition
    |
    +--> Manual flight: W/A/S/D, R/F, Shift, Space
    |          |
    |          +--> press E nearby, or aim and fire from up to 90 units away
    |          |          |
    |          |          +--> open local preview --> close / Escape --> resume at the same location
    |          |          |
    |          |          +--> first visit charts the file --> 5 charted files complete the expedition
    |          |
    |          +--> press M --> search atlas or choose a district/file --> guided flight
    |                                                              |
    +--------------------------------------------------------------+--> any steering input returns to manual flight
```

## Open a file

Press **E** to open a nearby crystal (within 18 units, no aiming needed), or aim the ship at a signal up to 90 units away and fire with the same key. The centre reticle lights up and names the file that will open. A ranged shot visibly launches from the ship, travels to the crystal, and flashes on impact before opening the viewer; you can keep flying during the shot. Nearby opens remain instant. Ranged shots use a 12° horizontal half-angle and allow up to 30 units of vertical offset; aim matters more than distance, and an atlas-selected file stays locked while within 90 units (nearby files still take priority). Use **M** to find a file and set a course. Space Drift pauses flight while the file viewer is open: a ranged shot preserves your velocity for closing the viewer, while a nearby open or guided arrival holds position until a movement key resumes manual flight. Text/code, images, PDFs, audio, and video display inside the viewer. Press **Escape** or close the viewer to return to the same location.

## How the map works

- Top-level folders form up to 24 districts; nested files retain their full relative paths and are searchable in the atlas. Additional folders are grouped into an overflow district.
- File sizes provide relative mass. Recently changed files provide activity.
- A live browser directory detects created, modified, and deleted files using relative paths, sizes, and modification times. A rename or move appears as deletion plus creation because browser handles do not expose a stable filesystem identity. The optional Node scanner can match a unique filesystem identity and report a move.
- The initial scan establishes a baseline. There is no historical change log before the folder is opened.
- Event history holds the latest 40 changes in memory. Browser-folder history resets with the folder session; local-server history resets when the server restarts.

File crystals have collision and gentle gravity proportional to logarithmic file size. Floating platforms, folder markers and route lines are passable map decoration. These forces and routes are a game interpretation of metadata, not measured disk traffic or semantic relationships between file contents. Nested files share their top-level district; there are no nested-folder interiors yet.

The browser source maps at most 2,500 files, inspects at most 25,000 directory entries, limits nesting to 32 levels, and limits scanning to ten seconds. It shares the map budget across top-level folders so smaller districts remain represented. Hidden entries, dependency and build folders, common cache folders, and private-key extensions are excluded; unsafe or duplicate relative paths are unavailable. The optional Node scanner applies comparable bounds and also excludes symlinks. Omission counts are exact when discovery finishes, or flagged as a lower bound when an entry, depth, time, or access limit prevents a full count. Creation and deletion events are suppressed across incomplete live scans to avoid inventing activity.

## Local data access

**Hosted/browser-folder mode:** the page reads only the folder or file snapshot selected through the browser picker. Metadata and file contents are kept on your device; Space Drift sends neither to Vercel, a database, or an AI service. Text previews are rendered as plain text and capped at 256 KiB, including source HTML and SVG. Supported image, PDF, audio, and video previews use local browser object URLs; unsupported formats can be opened separately using your file manager. The static host serves the application assets and receives ordinary asset requests, not your chosen folder.

**Optional Node mode:** the server binds to `127.0.0.1`, accepts only its own local host and origin, and confines file access to currently mapped, eligible files. `/api/world` returns names, relative paths, sizes, modification times, and recent metadata changes. `/api/file` reads a requested mapped file for preview, and `/api/file-content` streams image/PDF/audio/video content. Text previews are capped at 256 KiB; executable HTML is never rendered as a page. The same-origin JSON desktop endpoint uses the macOS opener without a shell. Source and script files open as text; unknown and executable formats are revealed in Finder. An external desktop application uses its own settings.

## Verify

```sh
npm run check
npm test
npm run build
```

`npm run check` checks server and browser JavaScript syntax. Tests cover scanning, ignored entries, symlinks, bounded scans, file-change detection, concurrent requests, event limits, HTTP access boundaries, deterministic layout, frame-rate-independent movement, boosted collision, crystal-tip collision, bounded mass attraction, empty maps, file access, safe text previews, media ranges, and desktop launch arguments.

A read-only `window.__SPACE_DRIFT__.getState()` diagnostic reports position, velocity, current destination, exploration progress, render counters, and live-event counts; the same snapshot is available on `#scene` as `data-telemetry`.

## Code map

- `vercel.json`: static hosting build and output settings.
- `scripts/build.mjs`: browser-asset build with the required Three.js modules.
- `scripts/preview.mjs`: confined static preview on loopback port 4190.
- `scripts/check.mjs`: syntax checks for app, server, scripts, and test modules.
- `server.mjs`: optional local HTTP server, access boundaries, and runtime configuration override.
- `lib/scan.mjs`: bounded folder scan and metadata differences.
- `lib/files.mjs`: confined file access, bounded previews, and desktop opening.
- `public/folder-source.js`: bounded browser-directory scans, file snapshots, and live metadata differences.
- `public/model.js`: repeatable world generation and flight physics.
- `public/main.js`: Three.js scene, controls, guided flight and exploration.
- `public/viewer.js` / `viewer.css`: local file viewer and return-to-flight behavior.
- `public/index.html` / `styles.css`: app shell and responsive controls.

Inspired by [Building games with Astra](https://developers.openai.com/blog/how-to-build-games-with-astra): begin with a playable experience, separate simulation from rendering, and expose enough state to verify actual journeys.

## Contributing

Report bugs and feature requests through [GitHub Issues](https://github.com/sharmasuraj0123/space-drift/issues). Pull requests are welcome.

## License

This repository does not include a LICENSE file. Contact the maintainer for licensing terms before reuse.
