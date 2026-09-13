import { runWorker } from './runtime.js';
import { renderTable } from './table.js';
import { DATA_BYTES, extension } from './limits.js';

export async function render(ctx) {
  const format = extension(ctx.result);
  const raw = typeof ctx.result.text === 'string' ? ctx.result.text : new TextDecoder().decode(await ctx.readBytes(DATA_BYTES));
  const parsed = await runWorker('/reader-assets/data.worker.js', { text: raw, format, truncated: !!ctx.result.truncated }, { signal: ctx.signal });
  ctx.signal.throwIfAborted();
  ctx.status(parsed.warning || (parsed.type === 'table' ? 'Read-only table · cell text is preserved.' : 'Formatted for reading · original values are preserved.'));
  if (parsed.type === 'table') return renderTable(ctx.container, parsed.rows, { name: ctx.result.name, signal: ctx.signal });
  const pre = document.createElement('pre'); pre.className = 'reader-json'; pre.textContent = parsed.text;
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = 'Show original'; toggle.setAttribute('aria-pressed', 'false');
  let original = false;
  toggle.addEventListener('click', () => {
    original = !original; pre.textContent = original ? raw : parsed.text;
    toggle.textContent = original ? 'Show formatted' : 'Show original'; toggle.setAttribute('aria-pressed', String(original));
  }, { signal: ctx.signal });
  ctx.tools.append(toggle); ctx.container.append(pre);
  return { dispose() { toggle.remove(); pre.remove(); } };
}
