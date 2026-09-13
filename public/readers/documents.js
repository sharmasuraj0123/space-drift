import { runWorker } from './runtime.js';
import { renderTable } from './table.js';
import { OFFICE_BYTES, extension } from './limits.js';

export async function render(ctx) {
  const format = extension(ctx.result), bytes = await ctx.readBytes(OFFICE_BYTES);
  const read = sheet => {
    const copy = bytes.slice(0);
    return runWorker('/reader-assets/documents.worker.js', { bytes: copy, format, sheet }, { signal: ctx.signal, timeout: 10000, transfer: [copy] });
  };
  const result = await read(0);
  ctx.signal.throwIfAborted();
  if (result.type === 'document') {
    const images = new Map(result.images.map(image => [String(image.id), ctx.ownUrl(new Blob([image.bytes], { type: image.mime }))]));
    // Only parser-owned, validated image bytes become blob URLs. No document URL
    // is fetched while reading; the shared HTML policy handles links/resources.
    const html = result.html.replace(/src="space-drift-image:(\d+)"/g, (_, id) => `src="${images.get(id) || ''}"`);
    const view = await ctx.renderHTML(html, { allowBlobImages: [...images.values()] });
    ctx.status(`DOCX reading mode · page layout may differ.${result.warning ? ' ' + result.warning : ''}`);
    return view;
  }
  const label = document.createElement('label'); label.className = 'reader-sheet-picker'; label.append(document.createTextNode('Sheet '));
  const select = document.createElement('select'); select.setAttribute('aria-label', 'Workbook sheet');
  result.sheets.forEach((name, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = name; select.append(option); });
  label.append(select); ctx.tools.append(label);
  let table, job = 0;
  const show = parsed => {
    table?.dispose();
    table = renderTable(ctx.container, parsed.rows, { name: parsed.sheets[parsed.selected], signal: ctx.signal });
    ctx.status(`Workbook values · formulas show saved results and are not recalculated. Charts and original layout are not shown.${parsed.warning ? ' ' + parsed.warning : ''}`);
  };
  show(result);
  select.addEventListener('change', async () => {
    const current = ++job; select.disabled = true; ctx.status('Reading sheet…');
    try {
      const parsed = await read(Number(select.value));
      if (!ctx.signal.aborted && current === job) show(parsed);
    } catch (error) { if (!ctx.signal.aborted && current === job) ctx.status(error.message); }
    finally { if (!ctx.signal.aborted && current === job) select.disabled = false; }
  }, { signal: ctx.signal });
  return { dispose() { job++; table?.dispose(); label.remove(); } };
}
