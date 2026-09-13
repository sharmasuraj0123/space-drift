import Papa from 'papaparse';
import { formatJSON } from './json.js';
import { DATA_BYTES, MAX_ROWS, MAX_COLUMNS, MAX_CELLS, MAX_CELL_CHARS } from './limits.js';

export function parseData({ text, format, truncated = false }) {
  if (format === 'geojson') format = 'json';
  if (typeof text !== 'string' || text.length > DATA_BYTES) throw new Error('Data exceeds the preview limit.');
  if (format === 'json' || format === 'jsonl' || format === 'ndjson') {
    if (truncated) return { type: 'text', text, warning: 'The source preview is truncated. Showing original text; incomplete JSON is not formatted.' };
    try {
      if (format === 'json') return { type: 'text', text: formatJSON(text) };
      const lines = text.split(/\r?\n/), blocks = [];
      let outputSize = 0;
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        if (blocks.length >= MAX_ROWS) return { type: 'text', text: blocks.join('\n\n'), warning: `Showing the first ${MAX_ROWS} JSON records.` };
        try {
          const block = formatJSON(line); outputSize += block.length + 2;
          if (outputSize > DATA_BYTES * 3) return { type: 'text', text: blocks.join('\n\n'), warning: 'Formatted JSON records reached the preview size limit.' };
          blocks.push(block);
        } catch (error) { throw new Error(`Line ${index + 1}: ${error.message}`); }
      }
      return { type: 'text', text: blocks.join('\n\n') };
    } catch (error) { return { type: 'text', text, warning: `${error.message} Showing original text.` }; }
  }
  if (!['csv', 'tsv'].includes(format)) throw new Error('Unsupported data preview.');
  const parsed = Papa.parse(text, { delimiter: format === 'tsv' ? '\t' : '', header: false, dynamicTyping: false, preview: MAX_ROWS + 1, skipEmptyLines: false });
  const malformed = parsed.errors.find(error => error.type === 'Quotes');
  if (malformed) throw new Error(`Malformed delimited file: ${malformed.message}`);
  const rows = [], warnings = [];
  let cells = 0, clipped = false;
  for (const row of parsed.data.slice(0, MAX_ROWS)) {
    if (cells + Math.min(row.length, MAX_COLUMNS) > MAX_CELLS) { clipped = true; break; }
    cells += Math.min(row.length, MAX_COLUMNS);
    if (row.length > MAX_COLUMNS) clipped = true;
    rows.push(row.slice(0, MAX_COLUMNS).map(cell => {
      if (cell.length > MAX_CELL_CHARS) { clipped = true; return cell.slice(0, MAX_CELL_CHARS) + '…'; }
      return cell;
    }));
  }
  if (truncated) warnings.push('The source preview is truncated; the final record may be incomplete.');
  if (clipped || parsed.data.length > MAX_ROWS || parsed.meta.truncated) warnings.push(`Preview limited to ${MAX_ROWS} rows, ${MAX_COLUMNS} columns and ${MAX_CELLS.toLocaleString('en-US')} cells.`);
  return { type: 'table', rows, warning: warnings.join(' '), delimiter: parsed.meta.delimiter };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = ({ data }) => {
    try { self.postMessage({ result: parseData(data) }); }
    catch (error) { self.postMessage({ error: error.message }); }
  };
}
