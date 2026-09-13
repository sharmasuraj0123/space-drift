const PAGE_SIZE = 50;
const cellText = value => typeof value === 'object' && value !== null ? String(value.text ?? '') : String(value ?? '');

/** A bounded read-only table. Cells are always text, never document HTML. */
export function renderTable(container, rows, { name = 'Data', signal, header = false } = {}) {
  const lifetime = new AbortController(), stop = () => lifetime.abort();
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  const doc = container.ownerDocument;
  const root = doc.createElement('section'); root.className = 'reader-table';
  const controls = doc.createElement('div'); controls.className = 'reader-table-controls';
  const label = doc.createElement('label'), checkbox = doc.createElement('input');
  checkbox.type = 'checkbox'; checkbox.checked = header;
  label.append(checkbox, doc.createTextNode(' First row contains headers'));
  const previous = doc.createElement('button'), next = doc.createElement('button'), count = doc.createElement('span');
  previous.type = next.type = 'button'; previous.textContent = 'Previous rows'; next.textContent = 'Next rows';
  count.setAttribute('role', 'status');
  const viewport = doc.createElement('div'); viewport.className = 'reader-table-scroll'; viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', `${name} table; scroll horizontally for more columns`);
  controls.append(label, previous, count, next); root.append(controls, viewport); container.append(root);
  let page = 0;
  function draw() {
    const offset = checkbox.checked && rows.length ? 1 : 0, total = Math.max(0, rows.length - offset);
    page = Math.min(page, Math.max(0, Math.ceil(total / PAGE_SIZE) - 1));
    const begin = page * PAGE_SIZE + offset, end = Math.min(rows.length, begin + PAGE_SIZE);
    const columns = Math.max(0, ...rows.map(row => row.length));
    const table = doc.createElement('table'), caption = doc.createElement('caption');
    caption.textContent = `${name} · ${total} preview rows`;
    const thead = doc.createElement('thead'), headings = doc.createElement('tr'), corner = doc.createElement('th');
    corner.textContent = 'Row'; corner.scope = 'col'; headings.append(corner);
    for (let column = 0; column < columns; column++) {
      const th = doc.createElement('th'); th.scope = 'col';
      th.textContent = offset ? cellText(rows[0]?.[column]) || `Column ${column + 1}` : `Column ${column + 1}`;
      headings.append(th);
    }
    thead.append(headings);
    const tbody = doc.createElement('tbody');
    for (let index = begin; index < end; index++) {
      const tr = doc.createElement('tr'), rowNumber = doc.createElement('th');
      rowNumber.scope = 'row'; rowNumber.textContent = String(index + 1); tr.append(rowNumber);
      for (let column = 0; column < columns; column++) {
        const td = doc.createElement('td'), value = rows[index][column]; td.textContent = cellText(value);
        if (value?.formula) td.title = `Formula: =${value.formula} (saved result; not recalculated)`;
        if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(td.textContent)) td.dataset.numeric = 'true';
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(caption, thead, tbody); viewport.replaceChildren(table);
    count.textContent = total ? `${begin - offset + 1}–${end - offset} of ${total}` : 'No rows';
    previous.disabled = page === 0; next.disabled = end >= rows.length;
  }
  previous.addEventListener('click', () => { page--; draw(); }, { signal: lifetime.signal });
  next.addEventListener('click', () => { page++; draw(); }, { signal: lifetime.signal });
  checkbox.addEventListener('change', () => { page = 0; draw(); }, { signal: lifetime.signal });
  draw();
  return { dispose() { stop(); signal?.removeEventListener('abort', stop); root.remove(); } };
}
