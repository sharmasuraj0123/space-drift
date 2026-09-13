import { runWorker } from './runtime.js';
import { renderHTML } from './html.js';

export async function render(ctx) {
  const text = String(ctx.result.text || '').slice(0, 256 * 1024);
  const doc = ctx.container.ownerDocument;
  const copy = doc.createElement('button'), wrap = doc.createElement('button');
  copy.type = wrap.type = 'button'; copy.textContent = 'Copy source'; wrap.textContent = 'Wrap lines';
  wrap.setAttribute('aria-pressed', 'false');
  let wrapped = false, view;
  const applyWrap = () => ctx.container.querySelectorAll('pre').forEach(node => node.classList.toggle('is-wrapped', wrapped));
  const copySource = async () => {
    try { await doc.defaultView.navigator.clipboard.writeText(text); if (!ctx.signal.aborted) ctx.status('Preview source copied.'); }
    catch { if (!ctx.signal.aborted) ctx.status('Select the source to copy it.'); }
  };
  const toggleWrap = () => { wrapped = !wrapped; wrap.setAttribute('aria-pressed', String(wrapped)); applyWrap(); };
  copy.addEventListener('click', copySource, { signal: ctx.signal });
  wrap.addEventListener('click', toggleWrap, { signal: ctx.signal });
  ctx.tools.append(copy, wrap);
  const dispose = () => {
    view?.dispose(); copy.removeEventListener('click', copySource); wrap.removeEventListener('click', toggleWrap);
    copy.remove(); wrap.remove();
  };
  const pre = ctx.container.ownerDocument.createElement('pre');
  pre.className = 'reader-source'; pre.textContent = text;
  ctx.container.replaceChildren(pre);
  if (!text) { ctx.status('This file is empty.'); return { dispose }; }
  let result;
  try {
    result = await runWorker('/reader-assets/text.worker.js', { kind: 'code', text, name: ctx.result.name }, { signal: ctx.signal, timeout: 8000 });
  } catch (error) {
    if (ctx.signal.aborted || error.name === 'AbortError') throw error;
    ctx.status('Syntax highlighting is unavailable for this preview. Showing readable source.');
    return { dispose };
  }
  if (ctx.signal.aborted) return;
  view = await renderHTML(ctx, result.html, { className: 'reader-code' });
  applyWrap();
  if (!result.highlighted) ctx.status('Showing readable source. Highlighting is limited to common languages and smaller files.');
  return { dispose };
}
