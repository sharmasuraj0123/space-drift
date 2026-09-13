export const DATA_BYTES = 4 * 1024 * 1024;
export const OFFICE_BYTES = 12 * 1024 * 1024;
export const MAX_ROWS = 1000;
export const MAX_COLUMNS = 100;
export const MAX_CELLS = 50000;
export const MAX_CELL_CHARS = 32768;
export const MAX_DEPTH = 64;
export const ZIP_LIMITS = Object.freeze({ entries: 2048, expanded: 32 * 1024 * 1024, entry: 8 * 1024 * 1024, ratio: 200 });

export function extension(result) {
  return String(result.name || result.path || '').split('.').at(-1).toLowerCase();
}

export function requireBytes(value, limit = OFFICE_BYTES) {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw new Error('The file is empty or unreadable.');
  if (bytes.byteLength > limit) throw new Error(`This preview is limited to ${limit / 1024 / 1024} MiB files.`);
  return bytes;
}
