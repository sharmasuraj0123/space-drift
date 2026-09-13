import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { classifyFile } from '../public/file-types.js';

export const TEXT_PREVIEW_LIMIT = 256 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'pages', 'numbers', 'keynote', 'rtf']);
const runFile = promisify(execFile);

export class FileAccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validatePath(requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath || requestedPath.includes('\0') || requestedPath.includes('\\') ||
      path.isAbsolute(requestedPath) || /^[a-z]:/i.test(requestedPath) ||
      requestedPath.split('/').some((part) => !part || part.startsWith('.'))) {
    throw new FileAccessError(403, 'This file is not available on the map.');
  }
  return requestedPath;
}

function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.birthtimeMs === after.birthtimeMs;
}

function desktopOptions(name, kind) {
  const extension = path.extname(name).slice(1).toLowerCase();
  if (kind === 'text' || extension === 'svg') return { action: 'open', flags: ['-t'] };
  if (['image', 'audio', 'video', 'pdf'].includes(kind) || DOCUMENT_EXTENSIONS.has(extension)) return { action: 'open', flags: [] };
  return { action: 'reveal', flags: ['-R'] };
}

/** Open only an eligible map entry; validate every directory before and after open.
 * All content is read through the checked descriptor, never by reopening its path.
 */
export async function openMappedFile(root, requestedPath, readWorld) {
  const relativePath = validatePath(requestedPath);
  const world = await readWorld();
  if (!world.files.some((file) => file.path === relativePath)) {
    throw new FileAccessError(404, 'This file is no longer on the map.');
  }
  const rootPath = path.resolve(root);
  const absolutePath = path.join(rootPath, ...relativePath.split('/'));
  const segments = [rootPath];
  for (const segment of relativePath.split('/')) segments.push(path.join(segments.at(-1), segment));
  const states = [];
  for (let index = 0; index < segments.length; index += 1) {
    const state = await lstat(segments[index]);
    if (state.isSymbolicLink() || (index < segments.length - 1 ? !state.isDirectory() : !state.isFile())) {
      throw new FileAccessError(403, 'Linked files and folders cannot be opened.');
    }
    states.push(state);
  }
  const canonicalRoot = await realpath(rootPath);
  const canonicalFile = await realpath(absolutePath);
  if (!canonicalFile.startsWith(canonicalRoot + path.sep)) {
    throw new FileAccessError(403, 'This file is outside the mapped folder.');
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const state = await handle.stat();
    if (!state.isFile() || !sameFile(states.at(-1), state)) {
      throw new FileAccessError(409, 'This file changed while opening. Try again.');
    }
    for (let index = 0; index < segments.length; index += 1) {
      const after = await lstat(segments[index]);
      if (after.isSymbolicLink() || !sameFile(states[index], after)) {
        throw new FileAccessError(409, 'This file moved while opening. Try again.');
      }
    }
    if (await realpath(absolutePath) !== canonicalFile) {
      throw new FileAccessError(409, 'This file moved while opening. Try again.');
    }
    const name = path.basename(relativePath);
    const { kind, mime } = classifyFile(name);
    return { handle, absolutePath, canonicalPath: canonicalFile, metadata: {
      path: relativePath, name, kind, mime, size: state.size, modifiedAt: state.mtime.toISOString(),
      desktopAction: desktopOptions(name, kind).action,
    } };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Native opening is deliberately macOS-only. Test callers inject an executor.
 * Source files go to a text editor; unrecognized/executable formats only reveal.
 */
export async function launchMappedFile(root, requestedPath, readWorld, { platform = process.platform, execute = runFile } = {}) {
  if (platform !== 'darwin') throw new FileAccessError(501, 'Desktop opening is currently available on macOS only.');
  const { handle, absolutePath, canonicalPath, metadata } = await openMappedFile(root, requestedPath, readWorld);
  try {
    const current = await lstat(absolutePath);
    if (current.isSymbolicLink() || !sameFile(current, await handle.stat()) || await realpath(absolutePath) !== canonicalPath) {
      throw new FileAccessError(409, 'This file moved while opening. Try again.');
    }
    const { action, flags } = desktopOptions(metadata.name, metadata.kind);
    // Absolute paths cannot be interpreted as command flags. No shell is involved.
    await execute('/usr/bin/open', [...flags, absolutePath], { timeout: 10000, maxBuffer: 16 * 1024 });
    return { ok: true, action: action === 'open' ? 'opened' : 'revealed' };
  } finally {
    await handle.close();
  }
}

export async function readFilePreview(root, requestedPath, readWorld) {
  const { handle, metadata } = await openMappedFile(root, requestedPath, readWorld);
  try {
    if (metadata.kind === 'text') {
      const buffer = Buffer.alloc(Math.min(metadata.size, TEXT_PREVIEW_LIMIT));
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      // Treat mislabeled binary files as unsupported, and never interpret markup.
      const contents = buffer.subarray(0, length);
      if (contents.includes(0)) return { ...metadata, kind: 'unsupported', mime: 'application/octet-stream' };
      const truncated = metadata.size > length;
      // Streaming decode discards an incomplete final UTF-8 code point at the cap.
      const text = new TextDecoder('utf-8').decode(contents, { stream: truncated });
      return { ...metadata, text, truncated };
    }
    if (metadata.kind !== 'unsupported') return { ...metadata, contentUrl: `/api/file-content?path=${encodeURIComponent(metadata.path)}` };
    return metadata;
  } finally {
    await handle.close();
  }
}

/** Single byte ranges keep media seekable without loading a whole file in memory. */
export function parseByteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) throw new FileAccessError(416, 'This byte range is unavailable.');
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new FileAccessError(416, 'This byte range is unavailable.');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
      throw new FileAccessError(416, 'This byte range is unavailable.');
    }
    end = Math.min(end, size - 1);
  }
  return { start, end };
}
