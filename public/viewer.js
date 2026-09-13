import { formatBytes } from './model.js';
import { createIcon, setIcon } from './icons.js';
import { awaitWithSignal, createLocalPreviewSession } from './preview.js';
import { classifyFile } from './file-types.js';
import { loadRenderer, rendererFor, renderHTML } from './readers/registry.js';
import { fetchBounded, relativeFilePath } from './readers/runtime.js';

const SERVER_SOURCE = Object.freeze({ kind: 'server' });

/** Read-only, lazy previews. A new file/source or close cancels the entire prior lifetime. */
export function createFileViewer({ onClose = () => {}, getSource = () => SERVER_SOURCE } = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'file-viewer';
  dialog.setAttribute('aria-labelledby', 'viewer-title');
  dialog.innerHTML = `
    <div class="viewer-header">
      <div class="viewer-identity"><div class="eyebrow">SPACE DRIFT / LOCAL READER</div><h2 id="viewer-title"></h2><p id="viewer-path"></p></div>
      <button class="viewer-close" aria-label="Close file and return to flight" title="Return to flight (Escape)"></button>
    </div>
    <div class="viewer-toolbar"><span id="viewer-meta"></span><div class="viewer-actions"><button id="viewer-copy" type="button">Copy path</button><button id="viewer-desktop" type="button" hidden>Open in desktop app</button></div></div>
    <div class="viewer-reader-bar"><div id="viewer-modes" role="group" aria-label="Reading mode" hidden><button id="viewer-preview" type="button" aria-pressed="true">Preview</button><button id="viewer-source" type="button" aria-pressed="false">Source</button></div><div id="viewer-renderer-tools"></div></div>
    <div id="viewer-content" tabindex="0" aria-label="File preview" aria-busy="false"></div>
    <div class="viewer-footer"><span id="viewer-status" role="status" aria-live="polite">Opening file…</span><span><kbd>ESC</kbd> Back to flight</span></div>`;
  document.body.append(dialog);
  const find = (id) => dialog.querySelector(`#${id}`);
  setIcon(dialog.querySelector('.viewer-close'), 'close');
  find('viewer-copy').append(createIcon('copy'));
  find('viewer-desktop').append(createIcon('external-link'));
  const content = find('viewer-content');
  let request, filePath = '', requestNumber = 0;
  let activeSource = null, rendering = null, renderDispose = null;
  const ownedUrls = new Set();
  const localPreview = createLocalPreviewSession();

  function clearRender() {
    rendering?.abort(); rendering = null;
    renderDispose?.(); renderDispose = null;
    for (const url of ownedUrls) URL.revokeObjectURL(url);
    ownedUrls.clear();
    find('viewer-renderer-tools').replaceChildren();
  }
  function clearMedia() {
    clearRender();
    find('viewer-preview').onclick = null; find('viewer-source').onclick = null;
    find('viewer-modes').hidden = true;
    content.querySelectorAll('audio,video').forEach((element) => { element.pause(); element.removeAttribute('src'); element.load(); });
    content.replaceChildren();
    localPreview.clear();
  }
  function close() {
    requestNumber++; request?.abort(); clearMedia(); activeSource = null;
    if (dialog.open) dialog.close();
  }
  dialog.querySelector('.viewer-close').addEventListener('click', close);
  dialog.addEventListener('close', () => {
    // A new file may already have opened before this queued close event runs.
    if (dialog.open) return;
    requestNumber++; request?.abort(); clearMedia(); activeSource = null; onClose();
  });
  find('viewer-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(filePath); find('viewer-status').textContent = 'Relative path copied.'; }
    catch { find('viewer-status').textContent = 'Select the path above to copy it.'; }
  });
  find('viewer-desktop').addEventListener('click', async () => {
    if (activeSource?.kind !== 'server' || getSource() !== activeSource || !dialog.open) return;
    const number = requestNumber;
    find('viewer-desktop').disabled = true;
    find('viewer-status').textContent = 'Opening on your computer…';
    try {
      const response = await fetch('/api/open-file', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath }), signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The desktop app could not be opened.');
      if (number === requestNumber && dialog.open) find('viewer-status').textContent = result.action === 'revealed' ? 'Shown in Finder. Return to Space Drift whenever you’re ready.' : 'Opened in your desktop app. Return to Space Drift whenever you’re ready.';
    } catch (error) {
      if (number === requestNumber && dialog.open) find('viewer-status').textContent = error.name === 'TimeoutError' ? 'Opening took too long. You can try again.' : error.message;
    } finally { if (number === requestNumber) find('viewer-desktop').disabled = false; }
  });

  const note = (parent, message) => {
    const element = document.createElement('p'); element.className = 'viewer-message'; element.textContent = message; parent.append(element);
  };
  function serverURL(result) {
    const url = new URL(result.contentUrl, location.href);
    if (url.origin !== location.origin || url.pathname !== '/api/file-content' || url.searchParams.get('path') !== result.path) throw new Error('This file has an invalid local preview address.');
    return url.href;
  }

  async function open(file) {
    request?.abort(); const number = ++requestNumber;
    request = new AbortController();
    const currentRequest = request, source = getSource();
    const current = () => number === requestNumber && dialog.open && getSource() === source && !currentRequest.signal.aborted;
    activeSource = source; filePath = file.path;
    find('viewer-title').textContent = file.name;
    find('viewer-path').textContent = file.path;
    find('viewer-meta').textContent = formatBytes(file.size);
    find('viewer-desktop').hidden = true; find('viewer-desktop').disabled = false;
    find('viewer-status').textContent = 'Opening local file…';
    clearMedia(); content.dataset.kind = 'loading'; content.setAttribute('aria-busy', 'true');
    note(content, 'Opening your file…');
    if (!dialog.open) dialog.showModal();
    const timeout = setTimeout(() => currentRequest.abort(), 20000);
    try {
      let result, selected;
      if (!source) throw new Error('Choose a local folder before opening a file.');
      if (source.kind === 'server') {
        const response = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`, { signal: currentRequest.signal });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || 'This file could not be opened.');
      } else if (['directory', 'snapshot', 'sample'].includes(source.kind)) {
        if (typeof source.getFile !== 'function') throw new Error('This folder cannot open files. Choose it again.');
        selected = await awaitWithSignal(source.getFile(file.path, { signal: currentRequest.signal }), currentRequest.signal);
        if (!current()) { if (getSource() !== source) close(); return false; }
        result = await localPreview.open(selected, file.path, { signal: currentRequest.signal });
      } else throw new Error('Choose a local folder before opening a file.');
      if (!current()) { if (getSource() !== source) close(); return false; }
      if (result.contentUrl) {
        if (source.kind === 'server') result.contentUrl = serverURL(result);
        else if (!localPreview.owns(result.contentUrl)) throw new Error('This preview is no longer available. Open the file again.');
      }
      content.dataset.kind = result.kind;
      content.dataset.renderer = rendererFor(result) || 'unsupported';
      find('viewer-desktop').hidden = source.kind !== 'server' || !result.desktopAction;
      find('viewer-desktop').replaceChildren(document.createTextNode(result.desktopAction === 'reveal' ? 'Show in Finder' : 'Open in desktop app'), createIcon('external-link'));
      const dateLabel = result.modifiedAt ? new Date(result.modifiedAt).toLocaleDateString() : 'Unknown modified date';
      const extension = result.name.includes('.') ? result.name.split('.').at(-1).toUpperCase() : result.kind.toUpperCase();
      find('viewer-meta').textContent = `${extension}  /  ${formatBytes(result.size)}  /  ${dateLabel}`;
      const defaultStatus = result.truncated ? 'First 256 KiB shown · Preview may be incomplete · Original file unchanged.' : 'Read-only · Your file stays on this computer.';
      find('viewer-modes').hidden = typeof result.text !== 'string';

      async function show(mode = 'preview') {
        clearRender();
        const controller = new AbortController(); rendering = controller;
        const cancel = () => controller.abort();
        currentRequest.signal.addEventListener('abort', cancel, { once: true });
        controller.signal.addEventListener('abort', () => currentRequest.signal.removeEventListener('abort', cancel), { once: true });
        const valid = () => current() && !controller.signal.aborted;
        const body = document.createElement('div'); body.className = 'reader-body';
        const tools = document.createElement('div'); tools.className = 'reader-tools';
        content.replaceChildren(body); find('viewer-renderer-tools').append(tools);
        content.dataset.mode = mode; content.setAttribute('aria-busy', 'true');
        find('viewer-preview').setAttribute('aria-pressed', String(mode === 'preview'));
        find('viewer-source').setAttribute('aria-pressed', String(mode === 'source'));
        find('viewer-status').textContent = defaultStatus;
        let imageBytes = 0;
        const ctx = {
          container: body, tools, result, signal: controller.signal,
          status(message) { if (valid()) find('viewer-status').textContent = result.truncated ? `${message} · First 256 KiB only.` : message; },
          ownUrl(blob) {
            if (!valid()) throw new DOMException('Preview cancelled.', 'AbortError');
            const url = URL.createObjectURL(blob); ownedUrls.add(url); return url;
          },
          async readBytes(limit) {
            if (result.size > limit) throw new Error(`This file exceeds the ${formatBytes(limit)} preview limit. Open it in its usual app.`);
            const buffer = selected ? await awaitWithSignal(selected.arrayBuffer(), controller.signal) : await fetchBounded(serverURL(result), limit, controller.signal);
            if (!valid()) throw new DOMException('Preview cancelled.', 'AbortError');
            if (buffer.byteLength > limit) throw new Error('This file exceeds the preview size limit.');
            return buffer;
          },
          async resolveAsset(reference, kind) {
            const path = relativeFilePath(result.path, reference);
            if (!path || kind !== 'image' || classifyFile(path.split('/').at(-1)).kind !== 'image' || imageBytes >= 16 * 1024 * 1024) return null;
            const limit = Math.min(4 * 1024 * 1024, 16 * 1024 * 1024 - imageBytes);
            try {
              let blob;
              if (source.kind === 'server') {
                const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { signal: controller.signal });
                if (!response.ok) return null;
                const metadata = await response.json();
                if (metadata.kind !== 'image' || metadata.size > limit) return null;
                blob = new Blob([await fetchBounded(serverURL(metadata), limit, controller.signal)], { type: metadata.mime });
              } else {
                const asset = await awaitWithSignal(source.getFile(path, { signal: controller.signal }), controller.signal);
                if (asset.size > limit) return null;
                blob = asset.slice(0, asset.size, classifyFile(asset.name).mime);
              }
              if (!valid() || imageBytes + blob.size > 16 * 1024 * 1024) return null;
              imageBytes += blob.size; return { url: ctx.ownUrl(blob) };
            } catch { return null; }
          },
          async openPath(path) {
            if (!valid() || typeof path !== 'string' || !path || /[\\\0:]/.test(path) || path.split('/').some(part => !part || part.startsWith('.'))) return;
            await open({ name: path.split('/').at(-1), path, size: 0 });
          },
          renderHTML(html, options) { return renderHTML(ctx, html, options); },
        };
        const sourceView = () => {
          body.replaceChildren();
          const pre = document.createElement('pre'); pre.className = 'reader-source'; pre.tabIndex = 0;
          pre.setAttribute('aria-label', `Source of ${result.name}`); pre.textContent = result.text || ''; body.append(pre);
          const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy source';
          copy.onclick = async () => { try { await navigator.clipboard.writeText(result.text || ''); ctx.status('Source copied.'); } catch { ctx.status('Select the source to copy it.'); } };
          const wrap = document.createElement('button'); wrap.type = 'button'; wrap.textContent = 'Wrap lines'; wrap.setAttribute('aria-pressed', 'false');
          wrap.onclick = () => { const active = pre.classList.toggle('is-wrapped'); wrap.setAttribute('aria-pressed', String(active)); };
          tools.replaceChildren(copy, wrap);
          if (!result.text) ctx.status('This file is empty.');
        };
        const renderTimeout = setTimeout(() => {
          if (!valid()) return;
          controller.abort();
          if (typeof result.text === 'string') sourceView();
          else { body.replaceChildren(); tools.replaceChildren(); note(body, 'This file exceeded the preview time budget. Open the original in its usual application.'); }
          find('viewer-status').textContent = 'Preview time limit reached · Original file unchanged.';
          content.setAttribute('aria-busy', 'false');
        }, 20000);
        controller.signal.addEventListener('abort', () => clearTimeout(renderTimeout), { once: true });
        try {
          if (mode === 'source') sourceView();
          else {
            note(body, 'Preparing local preview…');
            const adapter = await loadRenderer(result);
            if (!valid()) return;
            body.replaceChildren();
            if (adapter) {
              const rendered = await adapter.render(ctx);
              if (!valid()) { rendered?.dispose?.(); return; }
              renderDispose = rendered?.dispose;
            } else note(body, 'No preview for this file type yet. Open it in its usual application from your file manager.');
          }
        } catch (error) {
          if (!valid()) return;
          if (typeof result.text === 'string') { sourceView(); ctx.status(`Showing source. ${error.message}`); }
          else { body.replaceChildren(); tools.replaceChildren(); note(body, error.message); ctx.status('Preview unavailable · Your original file is unchanged.'); }
        } finally { clearTimeout(renderTimeout); if (valid()) content.setAttribute('aria-busy', 'false'); }
      }
      find('viewer-preview').onclick = () => show('preview');
      find('viewer-source').onclick = () => show('source');
      // Resolve opening once the file is read. Missions count the opened atom;
      // expensive rendering continues with its own cancellable lifetime.
      clearTimeout(timeout);
      void show();
      return true;
    } catch (error) {
      if (number !== requestNumber || !dialog.open) return false;
      if (getSource() !== source) { close(); return false; }
      clearMedia();
      note(content, error.name === 'AbortError' ? 'The file took too long to open. Close this viewer and press E to retry.' : error.message);
      find('viewer-status').textContent = 'Could not open file. Return to flight and try again.';
      return false;
    } finally { clearTimeout(timeout); if (number === requestNumber && content.dataset.kind === 'loading') content.setAttribute('aria-busy', 'false'); }
  }
  return { open, close, get isOpen() { return dialog.open; }, get path() { return dialog.open ? filePath : null; } };
}
