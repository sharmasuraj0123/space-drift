import { runWorker } from './runtime.js';
import { renderHTML } from './html.js';

export async function render(ctx) {
  const text = String(ctx.result.text || '').slice(0, 256 * 1024);
  if (!text) { ctx.container.replaceChildren(); ctx.status('This file is empty.'); return; }
  let result;
  try {
    result = await runWorker('/reader-assets/text.worker.js', { kind: 'markdown', text }, { signal: ctx.signal, timeout: 8000 });
  } catch (error) {
    if (ctx.signal.aborted || error.name === 'AbortError') throw error;
    const pre = ctx.container.ownerDocument.createElement('pre');
    pre.className = 'reader-source'; pre.textContent = text;
    ctx.container.replaceChildren(pre);
    ctx.status('Markdown preview took too long or could not load. Showing readable source.');
    return;
  }
  if (ctx.signal.aborted) return;
  const view = await renderHTML(ctx, result.html, { className: 'reader-markdown' });
  if (result.warning) ctx.status(result.warning);
  return view;
}
