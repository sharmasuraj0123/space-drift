import { validateZIP } from './zip.js';
import { requireBytes, MAX_ROWS, MAX_COLUMNS, MAX_CELLS, MAX_CELL_CHARS } from './limits.js';

const IMAGE_BYTES = 2 * 1024 * 1024, TOTAL_IMAGE_BYTES = 8 * 1024 * 1024, MAX_IMAGES = 40;
export const DOCX_HTML_BYTES = 1024 * 1024, DOCX_HTML_TAGS = 12000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function validImage(bytes, mime) {
  if (!IMAGE_TYPES.has(mime) || !bytes.length || bytes.length > IMAGE_BYTES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bounded = (width, height) => width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16000000;
  const tag = (start, end) => new TextDecoder().decode(bytes.subarray(start, end));
  if (mime === 'image/png') return bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => bytes[i] === value) && tag(12, 16) === 'IHDR' && bounded(view.getUint32(16), view.getUint32(20));
  if (mime === 'image/gif') return bytes.length >= 10 && /^GIF8[79]a/.test(tag(0, 6)) && bounded(view.getUint16(6, true), view.getUint16(8, true));
  if (mime === 'image/jpeg') {
    if (bytes[0] !== 255 || bytes[1] !== 216) return false;
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return false;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) return false;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return length >= 8 && bounded(view.getUint16(offset + 5), view.getUint16(offset + 3));
      offset += length;
    }
    return false;
  }
  if (bytes.length < 30 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WEBP') return false;
  if (tag(12, 16) === 'VP8X') return bounded(1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16));
  if (tag(12, 16) === 'VP8 ') return bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a && bounded(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
  if (tag(12, 16) === 'VP8L') return bytes[20] === 0x2f && bounded(1 + bytes[21] + ((bytes[22] & 0x3f) << 8), 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0xf) << 10));
  return false;
}

async function readDOCX(bytes, names) {
  if (!names.includes('word/document.xml') || !names.includes('[Content_Types].xml')) throw new Error('This is not a DOCX document.');
  const { default: mammoth } = await import('mammoth');
  const images = [], warnings = [];
  let imageBytes = 0;
  // Mammoth's browser entry reads arrayBuffer; its Node entry reads buffer.
  // Both refer only to the bytes already checked above, never a filesystem path.
  const converted = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), buffer: bytes }, {
    externalFileAccess: false, includeEmbeddedStyleMap: false,
    convertImage: mammoth.images.imgElement(async image => {
      const data = new Uint8Array(await image.readAsArrayBuffer());
      if (!validImage(data, image.contentType) || images.length >= MAX_IMAGES || imageBytes + data.length > TOTAL_IMAGE_BYTES) {
        warnings.push('Some embedded images could not be shown within the preview limits.');
        return { alt: 'Embedded image omitted from this preview' };
      }
      imageBytes += data.length;
      const id = images.length;
      images.push({ id, mime: image.contentType, bytes: data });
      return { src: `space-drift-image:${id}` };
    }),
  });
  if (converted.value.length > DOCX_HTML_BYTES || new TextEncoder().encode(converted.value).byteLength > DOCX_HTML_BYTES || (converted.value.match(/<\/?[a-z][^>]*>/gi) || []).length > DOCX_HTML_TAGS) {
    throw new Error('This document is too large or complex to preview. Open it in its usual app.');
  }
  if (converted.messages.length) warnings.push('Some document features may not be represented in reading mode.');
  return { type: 'document', html: converted.value, images, warning: [...new Set(warnings)].join(' ') };
}

async function readWorkbook(bytes, selected = 0) {
  const XLSX = await import('xlsx');
  const options = { dense: true, sheetRows: MAX_ROWS + 1, cellHTML: false, cellFormula: true, cellText: true, bookVBA: false };
  const metadata = XLSX.read(bytes, { ...options, bookSheets: true });
  const names = metadata.SheetNames;
  if (!Array.isArray(names) || !names.length) throw new Error('No readable sheets were found.');
  if (names.length > 128) throw new Error('This workbook has too many sheets to preview.');
  const index = Number.isInteger(selected) && selected >= 0 && selected < names.length ? selected : 0;
  const workbook = XLSX.read(bytes, { ...options, sheets: index });
  const sheet = workbook.Sheets[names[index]];
  if (!sheet) throw new Error('The selected sheet could not be read.');
  const range = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']) : null;
  const fullRange = sheet['!fullref'] ? XLSX.utils.decode_range(sheet['!fullref']) : range;
  const rows = [];
  let clipped = false, cells = 0;
  if (range) {
    const rowEnd = Math.min(range.e.r + 1, MAX_ROWS), columnEnd = Math.min(range.e.c + 1, MAX_COLUMNS);
    for (let row = 0; row < rowEnd; row++) {
      if (cells + columnEnd > MAX_CELLS) { clipped = true; break; }
      const values = []; cells += columnEnd;
      for (let column = 0; column < columnEnd; column++) {
        const cell = sheet['!data']?.[row]?.[column] || sheet[XLSX.utils.encode_cell({ r: row, c: column })];
        let text = cell ? cell.w ?? (cell.v == null ? '' : String(cell.v)) : '';
        if (cell?.f && cell.v == null) text = `=${cell.f} [saved result unavailable]`;
        if (text.length > MAX_CELL_CHARS) { text = text.slice(0, MAX_CELL_CHARS) + '…'; clipped = true; }
        values.push(cell?.f ? { text, formula: cell.f.slice(0, MAX_CELL_CHARS) } : text);
      }
      rows.push(values);
    }
    clipped ||= fullRange.e.r >= MAX_ROWS || fullRange.e.c >= MAX_COLUMNS;
  }
  return { type: 'workbook', sheets: names, selected: index, rows,
    warning: clipped ? `Preview limited to ${MAX_ROWS} rows, ${MAX_COLUMNS} columns and ${MAX_CELLS.toLocaleString('en-US')} cells.` : '' };
}

export async function parseDocument({ bytes: input, format, sheet = 0 }) {
  const bytes = requireBytes(input);
  if (!['docx', 'xlsx', 'xls', 'ods'].includes(format)) throw new Error('This Office format is not supported.');
  const isZIP = bytes[0] === 80 && bytes[1] === 75;
  let names = [];
  if (isZIP) names = await validateZIP(bytes);
  else if (format !== 'xls') throw new Error('Encrypted or invalid Office documents cannot be previewed.');
  if (format === 'docx') return readDOCX(bytes, names);
  if (format === 'xlsx' && !names.includes('xl/workbook.xml')) throw new Error('This is not an XLSX workbook.');
  if (format === 'ods' && !names.includes('content.xml')) throw new Error('This is not an ODS workbook.');
  if (format === 'xls' && !isZIP && !(bytes[0] === 0xd0 && bytes[1] === 0xcf) && ![0x09, 0x00].includes(bytes[0])) throw new Error('This is not an XLS workbook.');
  try { return await readWorkbook(bytes, sheet); }
  catch (error) {
    if (/password|encrypt/i.test(error.message)) throw new Error('Encrypted workbooks cannot be previewed.');
    throw new Error(`Cannot read this workbook: ${error.message}`);
  }
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = async ({ data }) => {
    try {
      const result = await parseDocument(data);
      const transfers = (result.images || []).map(image => image.bytes.buffer);
      self.postMessage({ result }, transfers);
    } catch (error) { self.postMessage({ error: error.message }); }
  };
}
