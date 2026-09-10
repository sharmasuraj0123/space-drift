# Space Drift assets

The visual language is an orbital field guide: midnight space, ceramic surfaces, fine orbital lines, and restrained cyan signals. The approved quirq mark is shared across the header, favicon, app icons, and title artwork. The welcome scene and playable map use the same authored Blender meshes, loaded from a local GLB. Connecting a folder replaces the welcome arrangement with the user's real map; disconnecting returns to the live model showcase.

## Palette and sources

| Role | Color | Source |
| --- | --- | --- |
| Background | `#080b18` | Application background / theme color |
| Text | `#eef2ff` | `--ink` in `public/styles.css` |
| Main accent | `#aab8ff` | `--accent` |
| Signals | `#68e4ef` | `--cyan` |
| Secondary text | `#bec9e6` | `--soft` |
| Quiet text | `#94a3c4` | `--muted` |
| Warm satellite | `#ffad9b` | `--coral` |

`scripts/export-assets.mjs` reads the palette from the stylesheet and the exact brand geometry from `public/icons.svg#brand`. The Blender scripts read color tokens from that stylesheet and add darker material variations. The game models use geometry, materials, and vertex colors without image textures. The promotional render uses studio lights and AgX tone mapping; rendered pixels naturally vary with illumination.

| Asset | Export | Editable source |
| --- | --- | --- |
| Interface icons | `public/icons.svg`, 24×24 grid, 1.75px round strokes | SVG symbols; `public/icons.js` handles stateful controls |
| Brand mark | `public/icons.svg#brand`, 100×132 | Approved quirq geometry; no alternate mark |
| Favicon | `public/favicon.svg`, 16px and 32px PNGs | Export script; SVG adapts to light/dark browser chrome |
| Apple touch icon | `public/apple-touch-icon.png`, 180×180 | Export script; opaque background |
| App icons | `public/icon-192.png`, `icon-512.png` | Export script |
| Maskable icon | `public/icon-maskable-512.png`, 512×512 | Export script; mark stays inside the central 80% safe circle |
| Live game models | `public/assets/models/space-drift.glb`, 688,144 bytes | `source/game-assets.blend`, `source/game-assets-manifest.json`, and `scripts/create-game-assets.py` |
| Promotional artwork | `public/assets/orbital-scene.webp`, 1600×1000 | `source/orbital-scene.blend` and `scripts/create-orbital-art.py`; used by share/README exports, not the welcome scene |
| Social card | `public/assets/social-card.png`, 1200×630 | Export script, brand symbol, Blender artwork |
| README hero | `space-drift-hero.svg`, 1600×840 | Export script; embedded PNG makes the SVG self-contained |
| Four game screenshots | `screenshots/{space,surface,atlas,viewer}.png`, 1280×800 | `scripts/capture-assets.mjs` |

The models, artwork, and UI icon geometry are original to this project, apart from the existing quirq and GitHub brand marks. There are no downloaded stock images, textures, or fonts. The `.blend` files are editable production sources, excluded from the static deployment because only `public/` and the required Three.js vendor files are published.

## In-game model pack

The binary glTF 2.0 pack contains eleven named models. Counts and measured bounds come from `source/game-assets-manifest.json`.

| Model | Role | Triangles |
| --- | --- | ---: |
| `explorer` | Player ship: ceramic hull, cockpit, wings, engines, and named live-thruster sockets | 1,640 |
| `planet_basalt` | Cratered repository planet | 1,280 |
| `planet_ocean` | Ocean and continental repository planet | 1,280 |
| `planet_ice` | Fractured ice repository planet | 1,280 |
| `atom_code` | Source/code files | 204 |
| `atom_data` | Data/configuration files | 260 |
| `atom_document` | Markup/text/document files | 192 |
| `atom_media` | Image/audio/video/media files | 260 |
| `atom_other` | Remaining file types | 216 |
| `molecule` | Open folder cage surrounding its file atoms | 552 |
| `asteroid` | Belt and overflow debris | 240 |

The export uses +Y up and the explorer faces −Z. All ten non-ship assets fit inside a unit sphere at the origin; the explorer retains its authored dimensions, with bounds recorded in the manifest. The runtime scales repository models by body radius and atoms by `(radius, 1.5 × radius, radius)`, preserving the existing atom collider bounds. Thermal vibration rotates atoms around their vertical axis. Planet variants are selected deterministically from body identity.

`public/model-assets.js` loads the pack once with `GLTFLoader`. Its private templates produce independently disposable instances or merged geometry with authored material/vertex colors baked in. Files are grouped into at most five live `InstancedMesh` batches, one per model family, with separate temporary cooling batches. Folder cages form one instanced batch; debris and crust activity patches are instanced too. The explorer keeps six mesh/material groups. Field sheets, orbit rings, bonds, labels, and particles remain generated from live data.

`public/render-showcase.js` uses these same GLB models for the welcome view, including reduced-motion behavior. `public/assets/orbital-scene.webp` is promotional artwork only. The app waits for the model pack before enabling folder selection; `getState().modelAssets` exposes readiness, source, and the eleven names.

The browser import map resolves `three` and `three/addons/` to local vendor files. The static build includes `three.module.js`, `three.core.js`, `GLTFLoader.js`, `BufferGeometryUtils.js`, `SkeletonUtils.js`, and the Three.js license. No model CDN, external texture request, or Blender runtime is needed.

## Regenerate

Install the development tools with `npm ci`. Blender is needed only when changing authored models or promotional artwork; tested with Blender 5.2. Regenerate the playable model pack:

```sh
blender --background --python scripts/create-game-assets.py
npm run build
```

This recreates the eleven models, checks triangle budgets and unit bounds, writes the GLB and measured manifest, and saves `assets/source/game-assets.blend`. That file includes both the export scene and an editable studio contact sheet. A contact-sheet PNG is rendered to the ignored `artifacts/game-assets-contact.png` for inspection.

Regenerate the separate promotional artwork, icons, and share images:

```sh
blender --background --python scripts/create-orbital-art.py
npm run assets:export
npm run build
```

On macOS, the Blender executable may be `/Applications/Blender.app/Contents/MacOS/Blender`. The promotional script recreates its scene, lights, camera, saved `.blend`, and WebP. The image export command then rebuilds every favicon/app icon, the share card, and the README hero. Committed exports are used by normal builds; production does not run Blender or a browser.

Capture real application views:

```sh
npx playwright install chromium
npm run assets:capture
# Or use an installed Chrome:
CHANNEL=chrome npm run assets:capture
```

The capture script builds a disposable synthetic workspace called `mission-control` and starts the optional loopback server. It waits for all eleven Blender models and completed surveys, makes real edits to synthetic files, and uses ordinary controls to launch, pause/resume, fly an atlas route, steer, land, reach a folder and file, press E, return to flight, and lift off. It also checks disconnect and snapshot reconnection on the same page. Telemetry is read only for readiness, navigation observations, and verification; the script does not teleport the ship or mutate game state. It verifies pause/viewer icons and fails on uncaught errors, failed requests, or console/GPU shader errors. The browser/server and fixture are cleaned up afterward. No personal folders or documents are included. The screenshot viewport is fixed at 1280×800; flight timing and live excitation can vary slightly between machines.

Before the flight, an isolated GPU check renders the production instance-emission shader without scene lights. Cold matter must be black and excited matter must retain its tint; measured pixels are recorded in `screenshots/gpu-emission.json`. Run just this check with `GPU_ONLY=1 CHANNEL=chrome npm run assets:capture`.

## Delivery and sharing

`public/index.html` links the manifest, favicon variants, and app icon. The manifest provides standalone launch metadata without a service worker or offline storage. Both local servers serve `.webmanifest` as `application/manifest+json`; Vercel serves the static build.

Open Graph and Twitter metadata reference the repository's public site, `https://www.quirqs.ai/`, with a 1200×630 PNG, title, description, and image alternatives. Update those absolute URLs if deploying a fork to another domain. The card is available to external preview crawlers after these files are deployed; local validation cannot refresh their caches.

GitHub's repository social-preview image is a separate setting. Once publishing this change, upload `public/assets/social-card.png` under repository **Settings → General → Social preview**. Merely committing the image does not change that setting.

## Verification

Run `npm test`, `npm run check`, `npm run build`, and the capture command. The model tests check the actual GLB names, measured bounds, merged vertex colors, and independent resource ownership. Inspect the live welcome scene and flight at 1280×800 and 390×844; confirm readable copy, no horizontal overflow, SVG icons in controls, and no browser errors. Inspect the 16px favicon at native size and the maskable icon under a circular crop. The real file map must replace the welcome model arrangement after folder selection, and the same GLB showcase must return after disconnecting.
