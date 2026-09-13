/** A worker owns one file job. Closing, changing view, or timing out terminates it. */
export function runWorker(url, payload, { signal, timeout = 10000, transfer = [] } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Preview cancelled.', 'AbortError'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(url, { type: 'module' });
    const finish = (callback, value) => {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.terminate(); callback(value);
    };
    const cancel = () => finish(reject, new DOMException('Preview cancelled.', 'AbortError'));
    const timer = setTimeout(() => finish(reject, new Error('This file exceeded the preview time budget. Try Source or open it in its usual app.')), timeout);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
    worker.onerror = () => finish(reject, new Error('The local reader could not load. Try again or use Source.'));
    worker.onmessageerror = () => finish(reject, new Error('The reader returned an invalid result.'));
    try { worker.postMessage(payload, transfer); } catch (error) { finish(reject, error); }
  });
}

/** Check both metadata and streamed bytes: a changed file cannot exceed the cap. */
export async function fetchBounded(url, limit, signal) {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('The local file is unavailable. Choose the folder again.');
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw new Error('This file exceeds the preview size limit.');
  }
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('This file exceeds the preview size limit.');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

/** Resolve links inside the selected root, never absolute, hidden, or remote paths. */
export function relativeFilePath(currentPath, reference) {
  if (typeof reference !== 'string' || !reference || /^[a-z][a-z\d+.-]*:/i.test(reference) || /^[\/\\#?]/.test(reference)) return null;
  let decoded;
  try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]); } catch { return null; }
  if (!decoded || /[\\\0:]/.test(decoded) || decoded.startsWith('/')) return null;
  const parts = currentPath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else { if (!part || part.startsWith('.')) return null; parts.push(part); }
  }
  return parts.length ? parts.join('/') : null;
}
