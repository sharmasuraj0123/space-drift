import JSZip from 'jszip';
import { requireBytes, ZIP_LIMITS } from './limits.js';

/** Inspect archive declarations before a ZIP/XML parser allocates expanded data. */
export function inspectZIP(input, limits = ZIP_LIMITS) {
  const bytes = requireBytes(input), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = message => { throw new Error(`Cannot preview this Office archive: ${message}`); };
  const u16 = offset => view.getUint16(offset, true), u32 = offset => view.getUint32(offset, true);
  if (bytes.length < 22 || u32(0) !== 0x04034b50) fail('not a supported ZIP document.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) fail('missing ZIP directory.');
  const count = u16(end + 10), directorySize = u32(end + 12), directoryOffset = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count) fail('multi-volume archives are unsupported.');
  if (!count || count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) fail('empty or ZIP64 archives are unsupported.');
  if (count > limits.entries) fail(`more than ${limits.entries} ZIP entries.`);
  if (directoryOffset + directorySize !== end) fail('invalid ZIP directory bounds.');
  const entries = [], names = new Set();
  let offset = directoryOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || u32(offset) !== 0x02014b50) fail('invalid ZIP directory entry.');
    const flags = u16(offset + 8), method = u16(offset + 10), compressed = u32(offset + 20), size = u32(offset + 24);
    const nameLength = u16(offset + 28), extraLength = u16(offset + 30), commentLength = u16(offset + 32), local = u32(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLength > end) fail('truncated ZIP entry.');
    if (flags & 1) fail('encrypted documents are unsupported.');
    if (![0, 8].includes(method)) fail('unsupported ZIP compression.');
    if ([compressed, size, local].includes(0xffffffff)) fail('ZIP64 entries are unsupported.');
    if (size > limits.entry || (expanded += size) > limits.expanded) fail('expanded content exceeds the preview limit.');
    if (size > Math.max(1024, compressed * limits.ratio)) fail('suspicious compression ratio.');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength), name = new TextDecoder().decode(nameBytes);
    if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) fail('invalid or duplicate ZIP path.');
    names.add(name);
    if (local + 30 > directoryOffset || u32(local) !== 0x04034b50 || u16(local + 8) !== method || (u16(local + 6) & 1)) fail('invalid ZIP local header.');
    const localNameLength = u16(local + 26), dataOffset = local + 30 + localNameLength + u16(local + 28);
    if (localNameLength !== nameLength || dataOffset + compressed > directoryOffset) fail('invalid ZIP data bounds.');
    for (let i = 0; i < nameLength; i++) if (bytes[local + 30 + i] !== nameBytes[i]) fail('conflicting ZIP paths.');
    entries.push({ name, size });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) fail('inconsistent ZIP entry count.');
  return entries;
}

/** Verify actual decompressed byte counts incrementally, without accumulating. */
export async function validateZIP(input, limits = ZIP_LIMITS) {
  const bytes = requireBytes(input), entries = inspectZIP(bytes, limits);
  const zip = await JSZip.loadAsync(bytes);
  let expanded = 0;
  for (const entry of entries) {
    const file = zip.file(entry.name);
    if (!file) { if (entry.name.endsWith('/') && entry.size === 0) continue; throw new Error('Missing ZIP document entry.'); }
    await new Promise((resolve, reject) => {
      let size = 0, done = false;
      const stream = file.internalStream('uint8array');
      const fail = message => { if (!done) { done = true; stream.pause(); reject(new Error(message)); } };
      stream.on('data', chunk => {
        if (done) return;
        size += chunk.length; expanded += chunk.length;
        if (size > entry.size || size > limits.entry || expanded > limits.expanded) fail('Expanded Office content exceeds the preview limit.');
      });
      stream.on('error', error => fail(`Invalid compressed Office content: ${error.message}`));
      stream.on('end', () => {
        if (done) return;
        if (size !== entry.size) return fail('Invalid expanded Office entry size.');
        done = true; resolve();
      });
      stream.resume();
    });
  }
  return entries.map(entry => entry.name);
}
