import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaRenderer, MEDIA_BYTE_LIMIT, PDF_BYTE_LIMIT, PDF_PIXEL_LIMIT, PDF_TEXT_ITEM_LIMIT, pdfRenderSize, render } from '../public/readers/media.js';

// Small DOM boundary fake: rendering/lifecycle work is exercised without a GPU.
class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.ownerDocument = document; this.children = []; this.attributes = new Map();
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.clientWidth = 800; this.clientHeight = 600; this.pauseCalls = 0; this.loadCalls = 0;
  }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { for (const node of this.children) node.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; } }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'src') delete this.src; }
  getContext() { return {}; }
  pause() { this.pauseCalls++; }
  load() { this.loadCalls++; }
  click() { if (!this.disabled) this.dispatchEvent(new Event('click')); }
}
function elements(root, predicate) {
  return [root, ...root.children.flatMap(child => elements(child, predicate))].filter(predicate);
}
function byClass(root, name) { return elements(root, node => node.className?.split(' ').includes(name)); }
function button(ctx, label) { return elements(ctx.tools, node => node.tagName === 'button' && node.textContent === label)[0]; }
function context(kind = 'pdf', overrides = {}) {
  const document = { location: { href: 'https://space.test/' }, createElement(tag) { return new Element(tag, this); } };
  const controller = new AbortController(), statuses = [], reads = [], blobs = [];
  return { container: document.createElement('main'), tools: document.createElement('div'), signal: controller.signal, controller,
    result: { kind, size: 40, name: `example.${kind === 'image' ? 'png' : kind}`, path: 'example', contentUrl: 'blob:https://space.test/owned', ...overrides },
    status: message => statuses.push(message), statuses, reads, blobs,
    async readBytes(limit) { reads.push(limit); return new TextEncoder().encode('local bytes').buffer; },
    ownUrl(blob) { blobs.push(blob); return 'blob:https://space.test/generated'; } };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fakePDF({ loading, rendering, textChunks, numPages = 3 } = {}) {
  const calls = { documents: [], pages: [], renders: [], text: [], destroyed: 0 };
  const pdf = { numPages, async getPage(number) {
    const page = { number, cleaned: 0, getViewport({ scale }) { return { width: 600 * scale, height: 800 * scale, scale, userUnit: 1 }; },
      render(options) {
        const task = { promise: rendering?.promise || Promise.resolve(), cancelled: 0, cancel() { this.cancelled++; rendering?.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
        calls.renders.push({ number, options, task }); return task;
      },
      streamTextContent() { return new ReadableStream({ start(controller) {
        for (const chunk of textChunks || [{ items: [{ str: `Selectable page ${number}` }], styles: {} }]) controller.enqueue(chunk);
        controller.close();
      } }); }, cleanup() { this.cleaned++; } };
    calls.pages.push(page); return page;
  } };
  class TextLayer {
    constructor(options) { this.options = options; this.cancelled = 0; calls.text.push(this); }
    async render() {
      this.reader = this.options.textContentSource.getReader();
      while (true) {
        const chunk = await this.reader.read(); if (chunk.done) break;
        for (const item of chunk.value.items) { const span = this.options.container.ownerDocument.createElement('span'); span.textContent = item.str; this.options.container.append(span); }
      }
    }
    cancel() { this.cancelled++; this.reader?.cancel().catch(() => {}); }
  }
  const library = { GlobalWorkerOptions: {}, AnnotationMode: { DISABLE: 0 }, TextLayer, getDocument(options) {
    calls.documents.push(options);
    return { promise: loading?.promise || Promise.resolve(pdf), destroy() { calls.destroyed++; loading?.reject(new Error('Worker destroyed')); return Promise.resolve(); } };
  } };
  return { calls, library, pdf, render: createMediaRenderer({ loadPDF: async () => library }) };
}

test('native image fits, zooms, reports decode errors, and releases its owned UI on abort', async () => {
  const ctx = context('image');
  const view = await render(ctx), image = byClass(ctx.container, 'reader-image')[0];
  image.naturalWidth = 1600; image.naturalHeight = 1200; image.dispatchEvent(new Event('load'));
  assert.equal(image.style.width, '757px');
  button(ctx, 'Zoom in').click(); assert.ok(parseFloat(image.style.width) > 757);
  button(ctx, 'Fit image').click(); assert.equal(image.style.width, '757px');
  image.dispatchEvent(new Event('error')); assert.match(ctx.statuses.at(-1), /could not be decoded/);
  assert.equal(byClass(ctx.container, 'reader-media-error')[0].hidden, false);
  ctx.controller.abort(); view.dispose();
  assert.equal(image.src, undefined); assert.equal(ctx.tools.children.length, 0); assert.equal(ctx.container.children.length, 0);
  const previous = ctx.statuses.length; image.dispatchEvent(new Event('error')); assert.equal(ctx.statuses.length, previous);
});

test('audio and video preserve native controls, explain codec failure, and stop on disposal', async () => {
  for (const kind of ['audio', 'video']) {
    const ctx = context(kind), view = await render(ctx), media = byClass(ctx.container, 'reader-playback')[0];
    assert.equal(media.controls, true); assert.equal(media.preload, 'metadata');
    if (kind === 'video') assert.equal(media.playsInline, true);
    media.dispatchEvent(new Event('error')); assert.match(ctx.statuses.at(-1), /codec/);
    view.dispose(); view.dispose();
    assert.equal(media.pauseCalls, 1); assert.equal(media.loadCalls, 1); assert.equal(media.src, undefined);
  }
});

test('only owned local URLs are consumed; SVG remains inert source even when misclassified', async () => {
  for (const contentUrl of ['https://example.com/image.png', 'https://space.test/unrelated', 'data:image/png;base64,aA==', 'javascript:alert(1)', 'blob:https://foreign.test/id']) {
    const ctx = context('image', { contentUrl }); await assert.rejects(render(ctx), /invalid local preview address/);
    assert.equal(ctx.container.children.length, 0);
  }
  const local = context('image', { contentUrl: '/api/file-content?path=picture.png' });
  (await render(local)).dispose();
  const generated = context('audio', { contentUrl: undefined, mime: 'audio/mpeg' });
  const generatedView = await render(generated); assert.equal(generated.blobs.length, 1); generatedView.dispose();
  const svg = context('image', { name: 'diagram.svg', text: '<svg onload="alert(1)"><script>fetch("https://example.com")</script></svg>' });
  const view = await render(svg);
  assert.equal(elements(svg.container, node => ['img', 'svg', 'script'].includes(node.tagName)).length, 0);
  assert.equal(elements(svg.container, node => node.tagName === 'code')[0].textContent, svg.result.text);
  assert.equal(svg.reads.length, 0); view.dispose();
});

test('native media size limits apply before consuming an existing local content URL', async () => {
  for (const kind of ['image', 'audio', 'video']) {
    for (const contentUrl of ['blob:https://space.test/owned', '/api/file-content?path=large']) {
      const ctx = context(kind, { contentUrl, size: MEDIA_BYTE_LIMIT + 1 });
      await assert.rejects(render(ctx), /128 MiB/);
      assert.equal(ctx.reads.length, 0); assert.equal(ctx.container.children.length, 0);
    }
  }
});

test('PDF uses bounded bytes and local worker assets with one canvas/text layer during page navigation', async () => {
  const mock = fakePDF(), ctx = context();
  const view = await mock.render(ctx);
  assert.deepEqual(ctx.reads, [PDF_BYTE_LIMIT]);
  assert.equal(mock.library.GlobalWorkerOptions.workerSrc, '/reader-assets/pdf.worker.mjs');
  const options = mock.calls.documents[0];
  assert.ok(options.data instanceof Uint8Array); assert.equal(options.url, undefined);
  assert.equal(options.enableXfa, false); assert.equal(options.useSystemFonts, false);
  assert.equal(options.disableAutoFetch, true); assert.equal(options.cMapUrl, '/reader-assets/pdf/cmaps/');
  assert.equal(options.standardFontDataUrl, '/reader-assets/pdf/standard_fonts/'); assert.equal(options.wasmUrl, '/reader-assets/pdf/wasm/');
  assert.equal(mock.calls.renders[0].options.annotationMode, 0);
  assert.equal(button(ctx, 'Previous page').disabled, true);
  assert.equal(byClass(ctx.container, 'textLayer')[0].children[0].textContent, 'Selectable page 1');
  const firstCanvas = byClass(ctx.container, 'reader-pdf-canvas')[0];
  button(ctx, 'Next page').click(); button(ctx, 'Next page').click(); await flush();
  assert.equal(mock.calls.pages.length, 2); assert.equal(mock.calls.pages[0].cleaned, 1); assert.equal(firstCanvas.width, 0);
  assert.equal(byClass(ctx.container, 'reader-pdf-canvas').length, 1); assert.equal(byClass(ctx.container, 'textLayer').length, 1);
  assert.equal(button(ctx, 'Previous page').disabled, false);
  const input = byClass(ctx.tools, 'reader-pdf-page-number')[0];
  input.value = '999'; input.dispatchEvent(new Event('change')); await flush();
  assert.equal(input.value, '3'); assert.equal(button(ctx, 'Next page').disabled, true);
  button(ctx, 'Zoom in').click(); await flush(); assert.match(byClass(ctx.tools, 'reader-media-zoom')[0].textContent, /160%/);
  button(ctx, 'Fit width').click(); await flush(); assert.match(byClass(ctx.tools, 'reader-media-zoom')[0].textContent, /Fit/);
  view.dispose(); view.dispose();
  assert.equal(mock.calls.destroyed, 1); assert.equal(ctx.container.children.length, 0); assert.equal(ctx.tools.children.length, 0);
});

test('closing a PDF during document load or canvas rendering destroys its worker and cancels work', async () => {
  for (const phase of ['loading', 'rendering']) {
    const wait = deferred(), mock = fakePDF({ [phase]: wait }), ctx = context();
    const pending = mock.render(ctx); const rejected = assert.rejects(pending, { name: 'AbortError' });
    await flush(); ctx.controller.abort(); await rejected;
    assert.equal(mock.calls.destroyed, 1); assert.equal(ctx.container.children.length, 0); assert.equal(ctx.tools.children.length, 0);
    if (phase === 'rendering') assert.equal(mock.calls.renders[0].task.cancelled, 1);
  }
});

test('PDF reads, document decoding, and page rendering have cancellable time budgets', async () => {
  for (const phase of ['read', 'loading', 'rendering']) {
    const waiting = deferred(), mock = fakePDF({ [phase]: waiting }), ctx = context();
    if (phase === 'read') ctx.readBytes = () => waiting.promise;
    const bounded = createMediaRenderer({ loadPDF: async () => mock.library, timeout: 10 });
    await assert.rejects(bounded(ctx), /preview time budget/);
    assert.equal(mock.calls.destroyed, phase === 'read' ? 0 : 1);
    assert.equal(ctx.container.children.length, 0); assert.equal(ctx.tools.children.length, 0);
    ctx.controller.abort();
  }
});

test('PDF rejects oversized inputs before decoding and gives encrypted/corrupt fallbacks', async () => {
  const mock = fakePDF(), ctx = context('pdf', { size: PDF_BYTE_LIMIT + 1 });
  await assert.rejects(mock.render(ctx), /32 MiB/); assert.equal(ctx.reads.length, 0); assert.equal(mock.calls.documents.length, 0);
  const bytes = context(); bytes.readBytes = async () => new ArrayBuffer(PDF_BYTE_LIMIT + 1);
  await assert.rejects(mock.render(bytes), /32 MiB/); assert.equal(mock.calls.documents.length, 0);
  for (const name of ['PasswordException', 'InvalidPDFException']) {
    const loading = deferred(), invalid = fakePDF({ loading }), local = context();
    const pending = invalid.render(local); const rejected = assert.rejects(pending, name === 'PasswordException' ? /encrypted or password/ : /corrupt or is not/);
    await flush(); loading.reject(Object.assign(new Error('untrusted library detail'), { name })); await rejected;
    assert.equal(invalid.calls.destroyed, 1); assert.equal(local.tools.children.length, 0);
  }
});

test('selectable PDF text stops at a bounded item budget while the visual page remains available', async () => {
  const mock = fakePDF({ textChunks: [{ items: [{ str: 'Allowed content' }], styles: {} },
    { items: Array.from({ length: PDF_TEXT_ITEM_LIMIT }, () => ({ str: 'x' })), styles: {} }] });
  const ctx = context(), view = await mock.render(ctx);
  assert.equal(byClass(ctx.container, 'reader-pdf-canvas').length, 1);
  assert.equal(byClass(ctx.container, 'textLayer')[0].children.length, 1);
  assert.match(ctx.statuses.at(-1), /Some selectable text is omitted/); view.dispose();
});

test('unusual PDF dimensions and zoom cannot exceed the canvas allocation budget', () => {
  for (const [width, height, scale, dpr] of [[600,800,1,2],[1e7,1e7,3,4],[50000,1,3,2],[1200,7000,3,1]]) {
    const size = pdfRenderSize(width, height, scale, dpr);
    assert.ok(size.pixelWidth * size.pixelHeight <= PDF_PIXEL_LIMIT);
    assert.ok(size.pixelWidth <= 8192 && size.pixelHeight <= 8192);
  }
  for (const dimensions of [[NaN,100,1],[0,10,1],[100,Infinity,1],[1e300,1e300,1]]) assert.throws(() => pdfRenderSize(...dimensions), /invalid dimensions/);
});
