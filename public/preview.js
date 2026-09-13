/** Browser-only previews read user-selected Files; they never request a URL. */
export const TEXT_PREVIEW_LIMIT = 256 * 1024;

import { classifyFile as classifyLocalFile } from './file-types.js';
export { classifyFile as classifyLocalFile } from './file-types.js';

function abortError() { return new DOMException('This preview was cancelled.', 'AbortError'); }

/** Blob.arrayBuffer has no abort option; stop waiting and ignore its later result. */
export function awaitWithSignal(promise, signal) {
  const task = Promise.resolve(promise);
  if (!signal) return task;
  if (signal.aborted) {
    task.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortError());
    signal.addEventListener('abort', cancel, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

/** Own at most one URL. A stale read cannot replace or revoke a newer preview. */
export function createLocalPreviewSession({ createObjectURL = (blob) => URL.createObjectURL(blob), revokeObjectURL = (url) => URL.revokeObjectURL(url) } = {}) {
  let generation = 0;
  let activeUrl = null;
  let removeAbortListener = null;

  function clear() {
    generation += 1;
    removeAbortListener?.();
    removeAbortListener = null;
    if (activeUrl) revokeObjectURL(activeUrl);
    activeUrl = null;
  }

  async function open(file, relativePath, { signal } = {}) {
    clear();
    const number = generation;
    const current = () => number === generation && !signal?.aborted;
    if (!current()) throw abortError();
    if (signal) {
      const cancel = () => { if (number === generation) clear(); };
      signal.addEventListener('abort', cancel, { once: true });
      removeAbortListener = () => signal.removeEventListener('abort', cancel);
    }
    if (!file || typeof file.slice !== 'function' || !Number.isFinite(file.size)) throw new Error('This file is no longer available. Choose the folder again.');
    const classification = classifyLocalFile(file.name);
    const modified = new Date(file.lastModified);
    const metadata = {
      path: relativePath, name: file.name, size: file.size,
      modifiedAt: Number.isFinite(modified.getTime()) ? modified.toISOString() : null,
      ...classification,
    };
    if (classification.kind === 'text') {
      const buffer = await awaitWithSignal(file.slice(0, TEXT_PREVIEW_LIMIT).arrayBuffer(), signal);
      if (!current()) throw abortError();
      const bytes = new Uint8Array(buffer);
      if (bytes.includes(0)) return { ...metadata, kind: 'unsupported', mime: 'application/octet-stream' };
      const truncated = file.size > bytes.length;
      const text = new TextDecoder('utf-8').decode(bytes, { stream: truncated });
      return { ...metadata, text, truncated };
    }
    if (['unsupported', 'document'].includes(classification.kind)) return metadata;
    // Force the allowlisted media MIME; never trust an HTML MIME on a .png File.
    const url = createObjectURL(file.slice(0, file.size, classification.mime));
    if (!current()) { revokeObjectURL(url); throw abortError(); }
    activeUrl = url;
    return { ...metadata, contentUrl: url };
  }

  return { open, clear, owns: (url) => typeof url === 'string' && activeUrl !== null && url === activeUrl };
}
