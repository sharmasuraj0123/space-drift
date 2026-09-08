# Space

![A ship flying through glowing folder districts and file crystals in space.](assets/space-hero.svg)

Fly a small ship through a living map of a local folder. Folders form districts, file size gives objects mass, and file activity creates currents you can feel while flying. This is a local prototype: your folder supplies the world, and the game maps file names and metadata, then reads file contents locally when you press E to open them.

## Run

Requires Node.js 20 or newer and npm.

```sh
cd data-drift
npm install
npm start
```

Open [Space](http://127.0.0.1:4188). The default map is the containing `quirq` project. To explore another folder or use a different port:

```sh
npm start -- --root "/absolute/path/to/your/folder" --port 4188
```

Stop the server with Ctrl+C. Your browser needs WebGL support.

## Fly

- W / up arrow: thrust forward.
- S / down arrow: reverse thrust.
- A / D or left / right arrows: steer.
- R / F: rise / descend.
- Shift: boost.
- Space: brake.
- E: open the selected file within 18 units. Opening a new file also charts it; visited files can be reopened.
- Move the mouse, or drag the scene on touch: move the aiming reticle independently of the ship. A cyan reticle locks onto the closest file in its narrow aim cone.
- Left click or Q: fire a probe at the locked file. Probes reach files within 160 units, then open and chart them exactly like a proximity open. C: center the reticle on the ship's forward vector.
- M: open the atlas; search for a file or choose a folder to fly there automatically. Any steering input returns manual control.
- Escape: pause or resume flight. H: open the flight manual.
- Home: return to the launch point.

Click **Launch expedition** to begin. Chart five files to complete the first expedition, then keep exploring. Exploration progress lasts for the current browser session. Touch controls provide forward thrust, left/right steering, proximity opening, probe firing, and reticle centering; drag open space to aim. The atlas handles longer trips.

The interface includes exploration and navigation controls. The world refreshes from disk every five seconds while the page is open. Edit, add, rename, or move a file in your normal editor or file manager to create activity in the map. The game itself does not change your files.

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Runtime | Node.js 20+ | Runs the local server and filesystem scanner. |
| Server | Native `node:http` | Serves the app and local-only JSON/file endpoints. |
| 3D rendering | [Three.js](https://threejs.org/) | Draws the browser-based space map and ship. |
| Client | Vanilla JavaScript ES modules, HTML, and CSS | Handles input, atlas navigation, UI, and the file viewer. |
| Filesystem | Node.js `fs`, `path`, and streams APIs | Scans eligible files and provides bounded local previews. |
| Tests | Node.js built-in test runner | Covers scanning, file access, physics, and HTTP boundaries. |

## Architecture

```text
                                  LOCAL MACHINE ONLY
+----------------------+                 |                 +------------------------+
| Selected workspace   |                 |                 | Browser                |
| folders and files    |                 |                 | Three.js + vanilla JS  |
+----------+-----------+                 |                 +-----------+------------+
           |                             |                             |
           | bounded scan: names, paths, |                             | GET /api/world
           | sizes, timestamps; ignores  |                             | every 5 seconds
           | hidden/generated/unsafe     |                             v
           v                             |                 +-----------+------------+
+----------+----------------------------+--+              | Space server           |
| lib/scan.mjs                             |              | node:http on 127.0.0.1 |
| creates world snapshots and change events |              +-----------+------------+
+----------+----------------------------+--+                          |
           ^                             |                             | checks requested path
           | E opens a mapped file only  |                             | against latest eligible map
           |                             |                             v
+----------+----------------------------+--+              +-----------+------------+
| Local file preview / media stream        | <-----------> | File viewer / atlas    |
| text, image, PDF, audio, or video        |   /api/file   | user interaction       |
+-------------------------------------------+   endpoints  +------------------------+
```

The browser receives map metadata during normal refreshes. It requests file contents only after you choose a mapped file to preview; the server stays bound to `127.0.0.1` and rejects paths outside the eligible map.

## Flight and exploration flow

```text
Open Space
    |
    v
Load world snapshot --------------------> districts, file crystals, activity currents
    |
    v
Launch expedition
    |
    +--> Manual flight: W/A/S/D, R/F, Shift, Space
    |          |
    |          +--> approach a crystal and press E, or aim and fire a probe with Q/click
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

Approach a crystal and press **E**, or use **M** to find a file and fly to it. You can also move the reticle with the mouse (or a touch drag), lock a distant crystal, and click or press **Q** to send a probe up to 160 units away. Press **C** to recenter the reticle. A probe opens the file on arrival and pauses flight just like an E open; a target outside range reports that it is too far away. Space pauses flight while the file viewer is open and holds position after guided arrival; any movement key resumes manual flight. Text/code, images, PDFs, audio, and video display inside the viewer. Press **Escape** or close the viewer to return to the same location.

Use **Open in desktop app** to open documents in their normal macOS application; text and code use the text editor. Files without a built-in preview still have this option where appropriate. Unknown, archive, and executable formats use **Show in Finder** instead. Desktop integration currently supports macOS.

## How the map works

- Top-level folders form up to 24 districts; nested files retain their full relative paths and are searchable in the atlas. Additional folders are grouped into an overflow district.
- File sizes provide relative mass. Recently changed files provide activity.
- Later snapshots detect created, modified, deleted, and moved files. Move detection requires a unique matching filesystem identity; when that is unavailable, changes appear as creation and deletion.
- The initial scan establishes a baseline. There is no historical change log before the server starts.
- Event history holds the latest 40 changes in memory and resets when the server restarts.

File crystals have collision and gentle gravity proportional to logarithmic file size. Floating platforms, folder markers and route lines are passable map decoration. These forces and routes are a game interpretation of metadata, not measured disk traffic or semantic relationships between file contents. Nested files share their top-level district; there are no nested-folder interiors yet.

The scanner maps at most 2,500 files, inspects at most 25,000 directory entries, limits nesting, and stops after ten seconds of scanning. When the file cap applies, it shares the map budget across top-level folders so smaller districts remain represented. Hidden entries, dependency and build folders, common cache folders, symlinks, and private-key extensions are excluded. Omission counts are exact when directory discovery finishes, or flagged as a lower bound when an entry, depth, time, or access limit prevents a full count. Creation, deletion, and move events are suppressed across incomplete scans to avoid inventing activity.

## Local data access

The server binds to `127.0.0.1`, accepts only its own local host and origin, and keeps all file access confined to the currently mapped, eligible files. `/api/world` returns names, relative paths, sizes, modification times, and recent metadata changes. `/api/file` reads a requested mapped file for preview, and `/api/file-content` streams image/PDF/audio/video content. Text previews use plain text, capped at 256 KiB; executable HTML is never rendered as a page. The desktop-opening endpoint accepts same-origin JSON requests and uses the macOS document opener without a shell. Source and script files open as text; unknown and executable formats are revealed in Finder. Space does not upload files or maps or send them to an AI service. An external desktop application uses its own settings.

## Verify

```sh
npm test
```

Tests cover scanning, ignored entries, symlinks, bounded scans, actual file-change detection, concurrent requests, event limits, and HTTP access boundaries.

The pure model tests additionally cover deterministic layout, frame-rate-independent movement, boosted collision, crystal-tip collision, bounded mass attraction, empty maps, and probe target/range selection. `npm run check` checks server and browser JavaScript syntax. A read-only `window.__SPACE__.getState()` diagnostic reports position, velocity, current destination, reticle lock, in-flight probe, exploration progress, render counters, and live-event counts; the same snapshot is available on `#scene` as `data-telemetry`.

Initial flight prototype verified locally on 2026-09-07: all 14 original tests and syntax checks passed; browser playtesting covered launch, keyboard thrust/steering/altitude, atlas search, continuous flight to `PROJECT.md`, targeted E scanning, live creation/modification events, 1280×800 and 390×844 layouts, and a clean browser error log.

The Space update passes 22 tests covering file access, safe text previews, media ranges, and desktop launch arguments with an injected executor. Browser checks verified text and PDF opening with E, reopening a visited file without duplicate progress, paused flight during reading, held arrival, and desktop/mobile viewer layouts.

## Code map

- `server.mjs`: local HTTP server and access boundaries.
- `lib/scan.mjs`: bounded folder scan and metadata differences.
- `lib/files.mjs`: confined file access, bounded previews, and desktop opening.
- `public/model.js`: repeatable world generation and flight physics.
- `public/main.js`: Three.js scene, controls, guided flight and exploration.
- `public/viewer.js` / `viewer.css`: local file viewer and return-to-flight behavior.
- `public/index.html` / `styles.css`: Space branding and responsive controls.

Inspired by [Building games with Astra](https://developers.openai.com/blog/how-to-build-games-with-astra): begin with a playable experience, separate simulation from rendering, and expose enough state to verify actual journeys.
