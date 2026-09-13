# Local reader support

Land on a folder planet, approach a file atom and press **E** to open its read-only preview. The viewer opens inside Space Drift; **Escape** closes it and returns to flight. Previewing never edits the original file. Text files also have **Preview / Source**, **Copy source**, and **Wrap lines** controls. The optional Node server can offer a separate desktop-app action on macOS; a static deployment cannot launch native apps.

The built-in sample folder, browser-selected live folders, browser folder snapshots, and the optional local server use the same renderer registry. A snapshot retains the selected `File` objects; reselect the folder to read later changes. Live folders obtain the current file when it is opened.

## Formats and reading controls

| Files | Reading experience | Deliberate limits and fallback |
| --- | --- | --- |
| `.md`, `.markdown` | Headings, lists, task markers, tables, links, code fences, and approved local raster images. | Embedded HTML is disabled. Complex or slow documents fall back to readable source. MDX is shown as source; components are not executed. |
| Source code, configuration, plain text, `.html`, `.svg`, `.xml` | Selectable source with line numbers and syntax highlighting for the bundled common languages. | Unknown languages remain readable. HTML and SVG are always inert source; they never become a live page or active image. Highlighting is skipped when its work limits are exceeded. |
| `.json`, `.geojson`, `.jsonl`, `.ndjson` | Validated, indented text with an original/formatted toggle. | Formatting preserves numeric tokens, string escapes, key order, and duplicate keys. Invalid, deeply nested, or truncated JSON stays as original text. JSON Lines is limited to 1,000 records. GeoJSON is shown as JSON, not as a geographic map. |
| `.csv`, `.tsv` | A horizontally scrollable table, 50 rows per page, optional first-row headers, and row navigation. | Cell values remain text. No formulas are executed or inferred. Truncated source can leave an incomplete final record; malformed quoted data falls back to Source. |
| `.docx` | Reading layout for document text, headings, lists, tables, and accepted embedded raster images. | This is not a page-layout reproduction. Unsupported features or images may be omitted with a notice. Macros, scripts, embedded applications, and external document resources are not executed or fetched. |
| `.xlsx`, `.xls`, `.ods` | Sheet picker and the same paginated table controls. Formula cells expose the formula in a tooltip. | Displays saved cell results; formulas are not recalculated. Charts, macros, original layout, and workbook interactions are not reproduced. Missing saved results are identified. Encrypted or invalid workbooks show a fallback message. |
| `.pdf` | One page at a time, previous/next buttons, page-number input, fit width, zoom, and selectable text where the PDF supplies it. | Uses a local PDF.js worker. Links, annotations, forms, scripts and XFA are not rendered. No OCR is performed. Encrypted, corrupt, oversized, or slow files receive an explanatory fallback. Very large embedded images may be omitted. |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.bmp`, `.ico` | Native image decoding with fit and zoom controls. | Actual decoding depends on the browser. A decode failure displays a message; the original remains unchanged. |
| Audio: `.mp3`, `.wav`, `.ogg`, `.opus`, `.flac`, `.m4a`, `.aac` | Native playback, seeking, volume and other browser-provided controls. | Codec support depends on the browser and OS. Unsupported codecs display an explanatory message. |
| Video: `.mp4`, `.webm`, `.mov`, `.ogv` | Native playback controls and inline playback where supported. | A supported container extension does not guarantee support for its audio/video codecs. |
| Other files, including `.doc`, `.ppt`, `.pptx` | A clear “no preview” message. | Locate the original with the file manager or, when offered by the local macOS server, open it in its usual app. |

The authoritative extension routing lives in `public/file-types.js`. A readable source fallback is still a successful file opening; it does not imply that rich rendering succeeded.

## Work and memory limits

Limits describe the current implementation, not measured browser performance or hard guarantees about a third-party decoder's total memory use. Smaller limits can apply before a later parser is reached.

| Work | Limit |
| --- | --- |
| Text supplied to readers | First **256 KiB** of UTF-8 bytes. An incomplete trailing character is omitted. Binary-looking text is unsupported. A truncation notice remains visible in all reading modes. |
| Syntax highlighting | At most 64 Ki characters, 3,000 lines, 20,000 tokens, and 2,000 characters on any line. Larger input remains source. Only explicit bundled language imports are selectable. |
| Markdown | Nesting 32, 12,000 parsed tokens, 24 highlighted fences sharing a 64 Ki-character budget, and 2 Mi characters of generated HTML. Markdown/highlighting workers have an 8-second job deadline. |
| Tables | At most 1,000 rows, 100 columns, 50,000 cells, and 32,768 characters per cell. Only 50 data rows are mounted in the current table page. |
| JSON/data parser | Additional 4 Mi-character input guard; JSON nesting 64 and formatted output at most 12 Mi characters. Ordinary file text still reaches this parser through the smaller 256 KiB read cap. Data-worker jobs have a 10-second deadline. |
| Office input | At most **12 MiB** per file and 128 workbook sheets. A worker parses only the selected sheet for display; selecting another sheet launches a new bounded job. Office jobs have a 10-second deadline. |
| ZIP-based Office containers | At most 2,048 entries, 8 MiB expanded per entry, 32 MiB total expanded content, and declared compression ratio 200:1 (with a 1 KiB allowance). Expanded byte counts are verified while streaming. Encrypted, multi-volume, ZIP64, invalid, duplicate or traversing archive paths are rejected. |
| DOCX reading layout | At most **1 MiB** of generated UTF-8 HTML and **12,000 HTML tags** (opening and closing tags counted). The worker rejects more complex output before it reaches the browser's DOM sanitizer. This is a preview complexity budget, not a limit on the original document's page count. |
| DOCX images | Validated PNG, JPEG, GIF or WebP only; at most 2 MiB each, 8 MiB total, 40 parser-owned images, 8,192 pixels per side and 16 million pixels per image. The shared HTML view displays at most 24 images. |
| Linked local images | At most 24 images in the rendered document, 4 MiB per file and 16 MiB total. Resolution stays inside the connected root and excludes hidden, unsupported, absolute and remote paths. |
| PDF input | At most **32 MiB** of complete bytes. A truncated PDF is never passed to the decoder. Byte reading, library loading and document decoding each have a 15-second deadline; a complete page render, including its text layer, has a 15-second deadline. |
| PDF display | One current page, canvas and text layer. Canvas backing storage is limited to 8,388,608 pixels and 8,192 pixels per side, reducing resolution/scale when needed. Manual zoom is 25–300%; fit width may use a smaller scale for unusual pages. |
| PDF text and images | At most 20,000 selectable text items and 1 Mi characters per page; a notice identifies omitted text. Embedded PDF images over 16,777,216 pixels are not rendered. |
| Native media | At most **128 MiB** according to file metadata, checked before consuming an owned blob URL or validated local content endpoint. The fallback that creates a blob from `readBytes` also checks actual bytes. Native image dimensions and decode memory are browser-controlled; these image previews do not perform the pre-decode dimension checks used for embedded DOCX images. |

Budget failures offer Source where text exists, or an explanation directing the reader to the original file. A PDF timeout cancels rendering and destroys its worker; the file must be reopened to retry.

## Local resource and lifetime rules

Renderer bundles are loaded only when a file needs them. Opening a PDF does not use the browser's embedded PDF viewer or a remote document service. PDF.js receives bounded bytes, a same-origin worker, and fixed local CMap, standard-font and WASM directories. No document-controlled annotation, scripting, XFA or navigation layer is installed.

Generated document HTML passes through a shared DOMPurify allowlist after URL attributes have been removed. Styles, scripts, frames, forms, SVG, embedded objects and event handlers do not survive. Approved local raster files and parser-owned DOCX image blobs can be restored under the image budget. Remote images and other document resource URLs are not fetched. An explicit HTTPS link can open a separate browser tab with `noopener noreferrer`; following a relative file link stays within the connected folder and opens the shared viewer.

Static hosting serves application code and assets. Browser-selected file contents are read locally and are not uploaded. In optional Node mode, content travels over the local server's validated content route. Every source and preview-mode change cancels the previous render lifetime. Closing also stops audio/video, removes media sources, cancels PDF/text rendering, destroys document workers and revokes viewer-owned URLs. Late results are checked against the active source and request before being displayed.

## Libraries and distribution

Versions and license identifiers below come from the installed package manifests. The build copies top-level license files and emits linked legal notices alongside bundled code. Copied PDF font, CMap and WASM directories retain their accompanying package files. `reader-assets/manifest.json` records dependencies and individual bundle sizes; it is not a benchmark of first-open latency or total browser memory.

| Library | Pinned version | Package license | Purpose |
| --- | --- | --- | --- |
| [markdown-it](https://github.com/markdown-it/markdown-it) | 15.0.2 | MIT | Markdown parsing with embedded HTML disabled; rendering rules keep image references inert until approved. |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.15 | MPL-2.0 OR Apache-2.0 | Shared allowlist boundary for generated Markdown, highlighted code and DOCX HTML. |
| [Shiki](https://github.com/shikijs/shiki) | 4.4.3 | MIT | Syntax tokens from explicitly bundled languages, using the JavaScript regex engine inside a disposable worker. |
| [Papa Parse](https://github.com/mholt/PapaParse) | 5.7.0 | MIT | Quoted CSV/TSV parsing without automatic value coercion. |
| [PDF.js](https://github.com/mozilla/pdf.js) | 6.3.289 | Apache-2.0 | PDF decoding in a local worker, bounded canvas output and a selectable text layer. |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | 1.12.3 | BSD-2-Clause | DOCX reading HTML rather than office-suite page-layout emulation. |
| [SheetJS CE](https://git.sheetjs.com/sheetjs/sheetjs) | 0.20.3 | Apache-2.0 | Workbook values and sheet selection. The dependency uses the pinned official distribution tarball. |
| [JSZip](https://github.com/Stuk/jszip) | 3.10.1 | MIT OR GPL-3.0-or-later | Streaming validation of actual Office archive expansion before document conversion. |

The build requires Node 22.13 or newer. The optional Node server remains separate from the static reader bundles; deployed previews do not require server-side document parsing. PDF API usage is checked against the installed package and [Mozilla's PDF.js API documentation](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html).

## Browser verification matrix

These are the intended coverage paths. Feature detection selects the available folder picker; this table does not claim that every browser/version or codec has been tested.

| Environment | Folder path | Checks to complete |
| --- | --- | --- |
| Desktop Chrome / Edge with `showDirectoryPicker` | Secure-context live directory handle. | All reader types, changing files between openings, closing during reads, real PDF page navigation and text selection, codec support. |
| Desktop Firefox / Safari | Folder-input snapshot where the browser offers it. | Snapshot file opening, worker/WASM loading, text selection, long-table scrolling and native playback. Reselect the folder to refresh files. |
| Mobile / touch browser | Folder-input snapshot where supported, or the built-in sample folder. | Reader toolbar wrapping, horizontal scrolling, PDF fit/zoom, native playback and return-to-flight controls. |
| Static build / Vercel | Sample or browser-selected files. | All reader assets resolve from the same deployment; opening files produces no `/api/*` calls and no content upload. |
| Optional local Node server | Validated mapped file paths. | Matching reader behavior, bounded streamed reads, media range/seek requests and desktop-app fallback on macOS. |

`tests/reader-media.test.mjs` exercises image controls, media cleanup, inert SVG, URL rejection, PDF page/zoom behavior, cancellation, timeouts, size limits, encrypted/corrupt fallbacks and text/canvas budgets using a PDF API boundary fake. These tests do not establish real font rendering, worker startup, visual fidelity or browser codec support.

For browser acceptance, use a real multi-page PDF containing selectable text; navigate in both directions, enter a page number, change zoom, select/copy text, close while a page is rendering, and open a different file immediately. Repeat with an encrypted and corrupt PDF, a large-budget fixture, and unsupported media codecs. Check that the status explains each fallback, old content never reappears, playback stops, and network traffic contains only application assets and authorized local file reads. Performance and cross-browser results should be recorded only after those runs complete.

## Verified implementation results (2026-09-13)

- All **207 Node tests** pass, including file access, renderer limits, cancellation and a Vercel-filtered build. The packaging check uses the bundler's exact import graph and checks PDF workers, fonts, CMaps, WASM and licenses. Test files run sequentially because the existing physics tests contain wall-clock performance ceilings; concurrent browser/build work distorts those measurements.
- `npm run verify:previews` exercises **36 isolated reader opens** across the format families and **15 further opens** through the actual directory, snapshot and optional Node adapters. It verifies real PDF pages and selectable text, Office sheets/images, source switching, interrupted reads, responsive 390/320px layouts, and cleanup. The isolated renderer run observed no remote requests or console/page errors and no surviving workers/object URLs after closing. The malformed PDF fixture emits an expected PDF.js warning.
- `npm run verify:sample` completes all nine real-control objectives at **900 points**, including rendered Markdown and CSV, Preview/Source, close-to-flight, touch controls, reset/replay and handoff to a selected local folder. The updated reader was also inspected in the in-app browser.
- Chrome was tested on this macOS host. A simulated directory handle exercises the real directory adapter; the native OS permission picker and physical mobile/Safari/Firefox hardware still need manual validation. The static build and Vercel upload filtering were tested locally; this branch has not been deployed.

`node scripts/verify-preview-performance.mjs` uses a 100 KiB document with prose, headings, tables, task lists and JavaScript fences. Each profile has 10 cold browser contexts and 10 warm opens, measured from lazy adapter import through two painted frames. Workers are fresh per file; warm modules can benefit from browser caching. The page is an isolated reader, so these numbers do not establish whole-game frame rate or peak process memory.

| Profile | Cold p95 | Warm p95 | Observed tasks over 50 ms |
| --- | ---: | ---: | ---: |
| Desktop Chrome, 1280 × 900 | 171 ms | 119 ms | 0 |
| Chrome at 4× CPU throttling, mobile viewport | 351 ms | 228 ms | 0 |

The 4× profile is CPU emulation, not a physical phone. Control-click round trips, including automation overhead, reached p95 48 ms on desktop and 75 ms at 4×; raw timer drift and sample values are retained in `artifacts/previews/performance.json`. Task yields between HTML transformation and sanitizer phases keep the browser available for close/source controls. These are observations on one host, not guarantees for every file or device.

The initial reader shell adds **3,643 gzip bytes** versus `origin/main` across the viewer, classifier, registry, runtime and local preview modules, below the proposed 10 KiB allowance. No rich renderer is in the initial flight import graph. A selected entry's required static imports currently measure:

| Lazy entry | Gzip with its static imports | Additional work loaded only when needed |
| --- | ---: | --- |
| Markdown | 14.6 KiB | Shared text worker 3.2 KiB; Markdown parser 40.9 KiB; highlighting when fences request supported languages. |
| Code | 15.0 KiB | Shared text worker; Shiki core 35.7 KiB, regex engine 20.7 KiB and selected language grammars. Unknown languages skip Shiki. |
| JSON / delimited data | 3.2 KiB | Data worker and parsers 9.0 KiB. |
| Office | 3.6 KiB | Worker/ZIP validation 33.5 KiB; DOCX conversion 130.0 KiB or workbook parser 160.2 KiB. |
| Native media / PDF controls | 4.7 KiB | PDF module 127.6 KiB and worker 367 KiB only for PDFs; font/CMap/WASM resources requested as needed. |

Shared chunks overlap between rows, so these are not additive download totals. `dist/reader-assets/manifest.json` is the generated per-bundle byte/gzip/import inventory, including pinned dependency versions. Native PDF/Office decoder peak memory was not measured; input, expansion, output and canvas limits provide bounded work policies rather than a process-memory guarantee. Browser verification artifacts are ignored by Git and can be regenerated with the commands above.
