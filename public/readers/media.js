/** Local media only. The viewer owns URLs; this adapter owns decoders and DOM. */
export const PDF_BYTE_LIMIT = 32 * 1024 * 1024;
export const PDF_PIXEL_LIMIT = 8 * 1024 * 1024;
export const PDF_TEXT_ITEM_LIMIT = 20000;
export const PDF_OPERATION_TIMEOUT_MS = 15000;
const MAX_CANVAS_SIDE = 8192;
export const MEDIA_BYTE_LIMIT = 128 * 1024 * 1024;
const SVG_BYTE_LIMIT = 256 * 1024;

function aborted() { return new DOMException('This preview was cancelled.', 'AbortError'); }
function check(signal) { if (signal?.aborted) throw aborted(); }
function settle(promise) { Promise.resolve(promise).catch(() => {}); }

/** Shrink unusual pages rather than allocating an unbounded canvas. */
export function pdfRenderSize(width, height, scale, devicePixelRatio = 1) {
  if (![width, height, scale].every(value => Number.isFinite(value) && value > 0) || !Number.isFinite(width * height)) {
    throw new Error('This PDF page has invalid dimensions. Open it in a desktop PDF reader.');
  }
  const safeScale = Math.min(scale, MAX_CANVAS_SIDE / width, MAX_CANVAS_SIDE / height, Math.sqrt(PDF_PIXEL_LIMIT / (width * height)));
  const cssWidth = width * safeScale, cssHeight = height * safeScale;
  const outputScale = Math.min(Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1), 2,
    MAX_CANVAS_SIDE / cssWidth, MAX_CANVAS_SIDE / cssHeight, Math.sqrt(PDF_PIXEL_LIMIT / (cssWidth * cssHeight)));
  return { scale: safeScale, outputScale, width: cssWidth, height: cssHeight,
    pixelWidth: Math.max(1, Math.floor(cssWidth * outputScale)), pixelHeight: Math.max(1, Math.floor(cssHeight * outputScale)),
    limited: safeScale < scale || outputScale < Math.min(2, devicePixelRatio || 1) };
}

export function pdfErrorMessage(error) {
  if (error?.name === 'PasswordException') return 'This PDF is encrypted or password protected. Open it in a desktop PDF reader.';
  if (error?.name === 'InvalidPDFException') return 'This PDF is corrupt or is not a valid PDF. Open the original in a desktop PDF reader.';
  return error?.message || 'This PDF could not be rendered. Open it in a desktop PDF reader.';
}

function make(ctx, tag, className, text) {
  const node = ctx.container.ownerDocument.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lifecycle(ctx) {
  let disposed = false;
  const cleanups = [];
  const active = () => !disposed && !ctx.signal?.aborted;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    ctx.signal?.removeEventListener('abort', dispose);
    for (const cleanup of cleanups.reverse()) cleanup();
  };
  ctx.signal?.addEventListener('abort', dispose, { once: true });
  return { active, dispose, own(cleanup) { cleanups.push(cleanup); },
    listen(node, event, handler) { node.addEventListener(event, handler); cleanups.push(() => node.removeEventListener(event, handler)); },
    assert() { if (!active()) throw aborted(); } };
}

function controls(ctx, life) {
  const row = make(ctx, 'div', 'reader-media-tools');
  ctx.tools.append(row);
  life.own(() => row.remove());
  return { row, button(label, handler) {
    const button = make(ctx, 'button', '', label);
    button.type = 'button';
    life.listen(button, 'click', handler); row.append(button); return button;
  } };
}

// contentUrl has already passed the viewer's ownership check. Still reject all
// active schemes and arbitrary HTTP endpoints if a caller bypasses that check.
function localURL(ctx, value) {
  const base = ctx.container.ownerDocument.location?.href || globalThis.location?.href;
  let url, origin;
  try { origin = new URL(base).origin; url = new URL(value, base); } catch { /* invalid below */ }
  if (!url || url.origin !== origin || !((url.protocol === 'blob:') ||
    (['http:', 'https:'].includes(url.protocol) && url.pathname === '/api/file-content'))) {
    throw new Error('This file has an invalid local preview address. Open it again.');
  }
  return url.href;
}

async function mediaURL(ctx, life) {
  if (ctx.result.size > MEDIA_BYTE_LIMIT) throw new Error('This media file exceeds the 128 MiB in-browser preview limit. Open it on your computer.');
  if (ctx.result.contentUrl) return localURL(ctx, ctx.result.contentUrl);
  const bytes = await ctx.readBytes(MEDIA_BYTE_LIMIT); life.assert();
  if (bytes.byteLength > MEDIA_BYTE_LIMIT) throw new Error('This media file exceeds the 128 MiB in-browser preview limit.');
  return localURL(ctx, ctx.ownUrl(new Blob([bytes], { type: ctx.result.mime || 'application/octet-stream' })));
}

async function renderNative(ctx) {
  check(ctx.signal);
  const life = lifecycle(ctx), kind = ctx.result.kind;
  try {
    // SVG markup is always inert, including if an upstream caller misclassifies it.
    if (/\.svg$/i.test(ctx.result.name || ctx.result.path || '') || /^image\/svg\+xml/i.test(ctx.result.mime || '')) {
      const pre = make(ctx, 'pre', 'reader-media reader-svg-source');
      pre.tabIndex = 0; pre.setAttribute('aria-label', `SVG source of ${ctx.result.name}`);
      const code = make(ctx, 'code');
      code.textContent = ctx.result.text ?? new TextDecoder().decode(await ctx.readBytes(SVG_BYTE_LIMIT));
      life.assert(); pre.append(code); ctx.container.append(pre); life.own(() => pre.remove());
      ctx.status(ctx.result.size > SVG_BYTE_LIMIT ? 'SVG source only · first 256 KiB shown.' : 'SVG source only · active markup is not rendered.');
      return { dispose: life.dispose };
    }
    if (!['image', 'audio', 'video'].includes(kind)) throw new Error('This file has no supported media preview.');
    const url = await mediaURL(ctx, life); life.assert();
    const stage = make(ctx, 'div', `reader-media ${kind === 'image' ? 'reader-image-stage' : 'reader-playback-stage'}`);
    const element = make(ctx, kind === 'image' ? 'img' : kind, kind === 'image' ? 'reader-image' : 'reader-playback');
    const error = make(ctx, 'p', 'reader-media-error'); error.hidden = true;
    stage.append(element, error); ctx.container.append(stage); life.own(() => stage.remove());
    element.setAttribute('aria-label', ctx.result.name || 'Local media');
    life.listen(element, 'error', () => {
      if (!life.active()) return;
      error.hidden = false;
      error.textContent = kind === 'image' ? 'This image could not be decoded. Open the original image on your computer.'
        : 'This browser cannot decode this media file or codec. Open the original in a media player on your computer.';
      ctx.status(error.textContent);
    });
    if (kind === 'image') {
      element.alt = ctx.result.name || 'Local image'; element.draggable = false;
      const bar = controls(ctx, life), label = make(ctx, 'span', 'reader-media-zoom');
      let zoom = null;
      const apply = () => {
        if (!life.active() || !element.naturalWidth || !element.naturalHeight) return;
        const fit = Math.min(1, Math.max(160, stage.clientWidth - 32) / element.naturalWidth,
          Math.max(160, (stage.clientHeight || 600) - 32) / element.naturalHeight);
        const scale = zoom ?? fit;
        element.style.width = `${Math.round(element.naturalWidth * scale)}px`;
        element.style.height = `${Math.round(element.naturalHeight * scale)}px`;
        label.textContent = `${Math.round(scale * 100)}%${zoom === null ? ' · Fit' : ''}`;
      };
      const change = multiplier => {
        const current = zoom ?? (parseFloat(element.style.width) / element.naturalWidth || 1);
        zoom = Math.min(4, Math.max(.05, current * multiplier)); apply();
      };
      bar.button('Zoom out', () => change(1 / 1.25)); bar.button('Fit image', () => { zoom = null; apply(); });
      bar.button('Zoom in', () => change(1.25)); bar.row.append(label);
      life.listen(element, 'load', apply);
      if (typeof ResizeObserver !== 'undefined') { const observer = new ResizeObserver(apply); observer.observe(stage); life.own(() => observer.disconnect()); }
      life.own(() => element.removeAttribute('src'));
    } else {
      element.controls = true; element.preload = 'metadata';
      if (kind === 'video') element.playsInline = true;
      life.own(() => { element.pause(); element.removeAttribute('src'); element.load(); });
    }
    element.src = url;
    ctx.status('Read-only local media · nothing is uploaded.');
    return { dispose: life.dispose };
  } catch (error) { life.dispose(); throw error; }
}

/** Injection keeps lifecycle tests independent from a browser canvas/worker. */
export function createMediaRenderer({ loadPDF = () => import('pdfjs-dist/build/pdf.mjs'), timeout = PDF_OPERATION_TIMEOUT_MS } = {}) {
  return async function render(ctx) {
    if (ctx.result.kind !== 'pdf') return renderNative(ctx);
    check(ctx.signal);
    if (ctx.result.size > PDF_BYTE_LIMIT) throw new Error('This PDF exceeds the 32 MiB preview limit. Open the original in a desktop PDF reader.');
    const life = lifecycle(ctx), bar = controls(ctx, life);
    const stage = make(ctx, 'div', 'reader-media reader-pdf-stage');
    stage.tabIndex = 0; stage.setAttribute('aria-label', `PDF pages of ${ctx.result.name}`);
    ctx.container.append(stage); life.own(() => stage.remove());
    let loadingTask, pdf, page, renderTask, textLayer, canvas, busy = false, pageNumber = 1, zoom = null, failed = false, destroyed = false;
    const pageInput = make(ctx, 'input', 'reader-pdf-page-number');
    pageInput.type = 'number'; pageInput.min = '1'; pageInput.step = '1'; pageInput.value = '1';
    pageInput.setAttribute('aria-label', 'PDF page number');
    const countLabel = make(ctx, 'span', 'reader-pdf-page-count', 'of …');
    const zoomLabel = make(ctx, 'span', 'reader-media-zoom');
    const previous = bar.button('Previous page', () => requestPage(pageNumber - 1));
    bar.row.append(pageInput, countLabel);
    const next = bar.button('Next page', () => requestPage(pageNumber + 1));
    const zoomOut = bar.button('Zoom out', () => requestZoom((zoom ?? currentScale()) / 1.25));
    const fit = bar.button('Fit width', () => requestZoom(null));
    const zoomIn = bar.button('Zoom in', () => requestZoom((zoom ?? currentScale()) * 1.25));
    bar.row.append(zoomLabel);
    life.listen(pageInput, 'change', () => requestPage(Number(pageInput.value)));
    life.listen(pageInput, 'keydown', event => { if (event.key === 'Enter') { event.preventDefault(); requestPage(Number(pageInput.value)); } });

    function setBusy(value) {
      busy = value || failed; stage.setAttribute('aria-busy', String(value));
      previous.disabled = busy || pageNumber <= 1;
      next.disabled = busy || !pdf || pageNumber >= pdf.numPages;
      pageInput.disabled = zoomOut.disabled = fit.disabled = zoomIn.disabled = busy;
    }
    function currentScale() { return page ? Math.min(1.5, Math.max(160, stage.clientWidth - 32) / page.getViewport({ scale: 1 }).width) : 1; }
    function clearPage() {
      renderTask?.cancel(); renderTask = null; textLayer?.cancel(); textLayer = null;
      page?.cleanup(); page = null;
      if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
      stage.replaceChildren();
    }
    function stopPDF() {
      clearPage();
      if (loadingTask && !destroyed) { destroyed = true; settle(loadingTask.destroy()); }
    }
    life.own(stopPDF);
    function assertPDF() { life.assert(); if (failed) throw new Error('This PDF exceeded the preview time budget. Open it in a desktop PDF reader.'); }
    function deadline(task) {
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (callback, value) => {
          if (finished) return;
          finished = true; clearTimeout(timer); ctx.signal?.removeEventListener('abort', cancel); callback(value);
        };
        const cancel = () => finish(reject, aborted());
        const timer = setTimeout(() => {
          failed = true; stopPDF();
          finish(reject, new Error('This PDF exceeded the preview time budget. Open it in a desktop PDF reader.'));
        }, timeout);
        ctx.signal?.addEventListener('abort', cancel, { once: true });
        Promise.resolve(task).then(value => finish(resolve, value), error => finish(reject, error));
        if (ctx.signal?.aborted) cancel();
      });
    }

    function showError(error) {
      if (!life.active() || error?.name === 'RenderingCancelledException' || error?.name === 'AbortError') return;
      const message = make(ctx, 'p', 'reader-media-error', pdfErrorMessage(error));
      stage.replaceChildren(message); ctx.status(message.textContent);
    }
    function requestPage(value) {
      if (busy || !life.active() || !pdf) return;
      pageNumber = Math.min(pdf.numPages, Math.max(1, Math.trunc(Number.isFinite(value) ? value : pageNumber)));
      pageInput.value = String(pageNumber);
      void drawPage().catch(showError);
    }
    function requestZoom(value) {
      if (busy || !life.active() || !pdf) return;
      zoom = value === null ? null : Math.min(3, Math.max(.25, value));
      void drawPage().catch(showError);
    }
    async function drawPage() {
      setBusy(true); clearPage();
      try { await deadline((async () => {
        const nextPage = await pdf.getPage(pageNumber);
        if (!life.active() || failed) { nextPage.cleanup(); assertPDF(); }
        page = nextPage;
        const base = page.getViewport({ scale: 1 });
        const size = pdfRenderSize(base.width, base.height, zoom ?? currentScale(), globalThis.devicePixelRatio || 1);
        const viewport = page.getViewport({ scale: size.scale });
        const sheet = make(ctx, 'div', 'reader-pdf-page');
        sheet.style.width = `${viewport.width}px`; sheet.style.height = `${viewport.height}px`;
        sheet.style.setProperty('--total-scale-factor', String(viewport.scale * (viewport.userUnit || 1)));
        sheet.style.setProperty('--scale-round-x', '1px'); sheet.style.setProperty('--scale-round-y', '1px');
        canvas = make(ctx, 'canvas', 'reader-pdf-canvas');
        canvas.width = size.pixelWidth; canvas.height = size.pixelHeight;
        canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute('aria-label', `Page ${pageNumber} of ${pdf.numPages}`);
        const text = make(ctx, 'div', 'textLayer');
        sheet.append(canvas, text); stage.append(sheet);
        zoomLabel.textContent = `${Math.round(size.scale * 100)}%${zoom === null ? ' · Fit' : ''}`;
        renderTask = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport,
          transform: size.outputScale === 1 ? null : [size.outputScale, 0, 0, size.outputScale, 0, 0],
          annotationMode: pdfjs.AnnotationMode.DISABLE, background: '#ffffff' });
        await renderTask.promise; assertPDF(); renderTask = null;
        let textLimited = false, textItems = 0, textCharacters = 0;
        const stream = page.streamTextContent({ includeMarkedContent: false }).pipeThrough(new TransformStream({ transform(chunk, controller) {
          textItems += chunk.items.length;
          for (const item of chunk.items) textCharacters += item.str?.length || 0;
          if (textItems > PDF_TEXT_ITEM_LIMIT || textCharacters > 1024 * 1024) {
            textLimited = true; throw new Error('This page exceeds the selectable-text budget.');
          }
          controller.enqueue(chunk);
        } }));
        textLayer = new pdfjs.TextLayer({ textContentSource: stream, container: text, viewport });
        try { await textLayer.render(); } catch (error) { assertPDF(); if (!textLimited) throw error; }
        assertPDF();
        ctx.status(`Page ${pageNumber} of ${pdf.numPages} · read-only. ${textLimited ? 'Some selectable text is omitted by the page budget. ' : ''}${size.limited ? 'Resolution reduced to fit the canvas budget. ' : ''}Links, forms, scripts and very large embedded images are not rendered.`);
      })()); } finally { if (life.active()) setBusy(false); }
    }

    let pdfjs;
    try {
      setBusy(true); ctx.status('Loading the local PDF reader…');
      const bytes = await deadline(ctx.readBytes(PDF_BYTE_LIMIT)); assertPDF();
      if (bytes.byteLength > PDF_BYTE_LIMIT) throw new Error('This PDF exceeds the 32 MiB preview limit. Open it in a desktop PDF reader.');
      pdfjs = await deadline(loadPDF()); assertPDF();
      pdfjs.GlobalWorkerOptions.workerSrc = '/reader-assets/pdf.worker.mjs';
      // Data (never a document URL) plus fixed local resources prevents document-
      // controlled network requests. No scripting, annotation or XFA layer exists.
      loadingTask = pdfjs.getDocument({ data: new Uint8Array(bytes), ownerDocument: ctx.container.ownerDocument,
        cMapUrl: '/reader-assets/pdf/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/reader-assets/pdf/standard_fonts/', wasmUrl: '/reader-assets/pdf/wasm/',
        useWorkerFetch: true, useSystemFonts: false, enableXfa: false,
        disableAutoFetch: true, disableRange: true, disableStream: true, stopAtErrors: true,
        maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: PDF_PIXEL_LIMIT * 4 });
      pdf = await deadline(loadingTask.promise); assertPDF();
      if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1) throw new Error('This PDF has no readable pages.');
      pageInput.max = String(pdf.numPages); countLabel.textContent = `of ${pdf.numPages}`;
      await drawPage(); life.assert();
      return { dispose: life.dispose };
    } catch (error) { const cancelled = !life.active(); life.dispose(); if (cancelled) throw aborted(); if (error?.name === 'AbortError') throw error; throw new Error(pdfErrorMessage(error)); }
  };
}

export const render = createMediaRenderer();
