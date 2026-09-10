import { formatBytes } from './model.js';
import { createIcon, setIcon } from './icons.js';
import { awaitWithSignal, createLocalPreviewSession } from './preview.js';

const SERVER_SOURCE = Object.freeze({ kind: 'server' });

/** Files are fetched only when the pilot opens them; text never becomes HTML. */
export function createFileViewer({ onClose = () => {}, getSource = () => SERVER_SOURCE } = {}) {
  const dialog = document.createElement('dialog');
  dialog.id = 'file-viewer';
  dialog.setAttribute('aria-labelledby', 'viewer-title');
  dialog.innerHTML = `
    <div class="viewer-header">
      <div class="viewer-identity"><div class="eyebrow">SPACE DRIFT / FILE VIEWER</div><h2 id="viewer-title"></h2><p id="viewer-path"></p></div>
      <button class="viewer-close" aria-label="Close file and return to flight" title="Return to flight (Escape)"></button>
    </div>
    <div class="viewer-toolbar"><span id="viewer-meta"></span><div class="viewer-actions"><button id="viewer-copy" type="button">Copy path</button><button id="viewer-desktop" type="button" hidden>Open in desktop app</button></div></div>
    <div id="viewer-content" aria-busy="false"></div>
    <div class="viewer-footer"><span id="viewer-status" role="status" aria-live="polite">Opening file…</span><span><kbd>ESC</kbd> Back to flight</span></div>`;
  document.body.append(dialog);
  const find = (id) => dialog.querySelector(`#${id}`);
  setIcon(dialog.querySelector('.viewer-close'), 'close');
  find('viewer-copy').append(createIcon('copy'));
  find('viewer-desktop').append(createIcon('external-link'));
  const content = find('viewer-content');
  let request, filePath = '', requestNumber = 0;
  let activeSource = null;
  const localPreview = createLocalPreviewSession();

  function clearMedia() {
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

  async function open(file) {
    request?.abort(); const number = ++requestNumber;
    request = new AbortController();
    const source = getSource();
    activeSource = source;
    filePath = file.path;
    find('viewer-title').textContent = file.name;
    find('viewer-path').textContent = file.path;
    find('viewer-meta').textContent = formatBytes(file.size);
    find('viewer-desktop').hidden = true; find('viewer-desktop').disabled = false;
    find('viewer-status').textContent = 'Opening local file…';
    clearMedia(); content.dataset.kind = 'loading'; content.setAttribute('aria-busy', 'true');
    const loading = document.createElement('p'); loading.className = 'viewer-message'; loading.textContent = 'Opening your file…'; content.append(loading);
    if (!dialog.open) dialog.showModal();
    const currentRequest = request;
    const timeout = setTimeout(() => currentRequest.abort(), 15000);
    try {
      let result;
      if (!source) throw new Error('Choose a local folder before opening a file.');
      if (source.kind === 'server') {
        const response = await fetch(`/api/file?path=${encodeURIComponent(file.path)}`, { signal: currentRequest.signal });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || 'This file could not be opened.');
      } else if (source.kind === 'directory' || source.kind === 'snapshot') {
        if (typeof source.getFile !== 'function') throw new Error('This folder cannot open files. Choose it again.');
        const selected = await awaitWithSignal(source.getFile(file.path, { signal: currentRequest.signal }), currentRequest.signal);
        if (number !== requestNumber || !dialog.open) return false;
        if (getSource() !== source) { close(); return false; }
        result = await localPreview.open(selected, file.path, { signal: currentRequest.signal });
      } else throw new Error('Choose a local folder before opening a file.');
      if (number !== requestNumber || !dialog.open) return false;
      if (getSource() !== source) { close(); return false; }
      content.replaceChildren();
      content.dataset.kind = result.kind;
      find('viewer-desktop').hidden = source.kind !== 'server' || !result.desktopAction;
      find('viewer-desktop').replaceChildren(document.createTextNode(result.desktopAction === 'reveal' ? 'Show in Finder' : 'Open in desktop app'), createIcon('external-link'));
      const dateLabel = result.modifiedAt ? new Date(result.modifiedAt).toLocaleDateString() : 'Unknown modified date';
      find('viewer-meta').textContent = `${result.kind.toUpperCase()}  /  ${formatBytes(result.size)}  /  ${dateLabel}`;
      const mediaUrl = result.contentUrl;
      if (mediaUrl) {
        if (source.kind === 'server') {
          const url = new URL(mediaUrl, location.href);
          if (url.origin !== location.origin || url.pathname !== '/api/file-content') throw new Error('This file has an invalid local preview address.');
        } else if (!localPreview.owns(mediaUrl)) throw new Error('This preview is no longer available. Open the file again.');
      }
      switch (result.kind) {
        case 'text': {
          const pre = document.createElement('pre'); const code = document.createElement('code');
          code.textContent = result.text || ''; pre.append(code); pre.tabIndex = 0; pre.setAttribute('aria-label', `Contents of ${file.name}`); content.append(pre);
          break;
        }
        case 'image': {
          const image = document.createElement('img'); image.alt = file.name; image.src = mediaUrl;
          image.addEventListener('error', () => { if (number === requestNumber && dialog.open) find('viewer-status').textContent = 'This image could not be decoded, or the file has moved.'; });
          content.append(image); break;
        }
        case 'pdf': {
          const iframe = document.createElement('iframe'); iframe.title = file.name; iframe.src = `${mediaUrl}#view=FitH&navpanes=0`; iframe.referrerPolicy = 'no-referrer';
          content.append(iframe); break;
        }
        case 'audio':
        case 'video': {
          const media = document.createElement(result.kind); media.controls = true; media.preload = 'metadata'; media.src = mediaUrl;
          media.setAttribute('aria-label', file.name);
          if (result.kind === 'video') media.playsInline = true;
          media.addEventListener('error', () => { if (number === requestNumber && dialog.open) find('viewer-status').textContent = 'This media format is not supported by this browser, or the file has moved.'; });
          content.append(media); break;
        }
        default: {
          const message = document.createElement('div'); message.className = 'viewer-message';
          const heading = document.createElement('h3'); heading.textContent = 'No preview for this file type yet.';
          const detail = document.createElement('p'); detail.textContent = source.kind !== 'server'
            ? 'Open this file from your computer’s file manager to view it in its usual application.'
            : result.desktopAction === 'open' ? 'Use “Open in desktop app” above to view this file in its usual application.' : 'Use “Show in Finder” above to locate this file on your computer.';
          message.append(heading, detail); content.append(message);
        }
      }
      find('viewer-status').textContent = result.truncated ? 'Preview shows the first 256 KB. Your full file is unchanged.' : 'Read-only · Your file stays on this computer.';
      return true;
    } catch (error) {
      if (number !== requestNumber || !dialog.open) return false;
      if (getSource() !== source) { close(); return false; }
      clearMedia();
      const message = document.createElement('p'); message.className = 'viewer-message';
      message.textContent = error.name === 'AbortError' ? 'The file took too long to open. Close this viewer and press E to retry.' : error.message;
      content.append(message); find('viewer-status').textContent = 'Could not open file. Return to flight and try again.';
      return false;
    } finally { clearTimeout(timeout); if (number === requestNumber) content.setAttribute('aria-busy', 'false'); }
  }
  return { open, close, get isOpen() { return dialog.open; }, get path() { return dialog.open ? filePath : null; } };
}
