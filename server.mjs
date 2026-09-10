import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createUniverseReader } from './lib/universe.mjs';
import { FileAccessError, launchMappedFile, openMappedFile, parseByteRange, readFilePreview } from './lib/files.mjs';

const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = path.join(APP_DIRECTORY, 'public');
const VENDOR_DIRECTORY = path.join(APP_DIRECTORY, 'node_modules/three/build');
const ADDON_DIRECTORY = path.join(APP_DIRECTORY, 'node_modules/three/examples/jsm');
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
};
const VENDOR_FILES = new Map([
  ['/vendor/three.module.js', 'three.module.js'],
  ['/vendor/three.core.js', 'three.core.js'],
]);
const ADDON_FILES = new Map([
  ['/vendor/addons/loaders/GLTFLoader.js', 'loaders/GLTFLoader.js'],
  ['/vendor/addons/utils/BufferGeometryUtils.js', 'utils/BufferGeometryUtils.js'],
  ['/vendor/addons/utils/SkeletonUtils.js', 'utils/SkeletonUtils.js'],
]);

function readJsonBody(request, limit = 4096) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    return Promise.reject(new FileAccessError(413, 'The request is too large.'));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        request.removeListener('data', onData);
        request.resume();
        reject(new FileAccessError(413, 'The request is too large.'));
      } else chunks.push(chunk);
    };
    request.on('data', onData);
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new FileAccessError(400, 'The request must contain valid JSON.')); }
    });
  });
}

export function createServer({ root = path.dirname(APP_DIRECTORY), scannerOptions, universeOptions, publicDirectory = PUBLIC_DIRECTORY, vendorDirectory = VENDOR_DIRECTORY, addonDirectory = ADDON_DIRECTORY, nativeExecutor, nativePlatform } = {}) {
  const universe = createUniverseReader(root, { ...universeOptions, scannerOptions });
  const readWorld = () => universe.mappedAtoms();
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(value));
    };
    try {
      // Restrict host and origin to this exact loopback listener (including its port).
      const allowedHosts = new Set([`127.0.0.1:${request.socket.localPort}`, `localhost:${request.socket.localPort}`]);
      if (!allowedHosts.has(request.headers.host)) return send(403, { error: 'Local connections only.' });
      if (request.headers.origin && ![...allowedHosts].some((host) => request.headers.origin === `http://${host}`)) {
        return send(403, { error: 'This server accepts requests from its own local page only.' });
      }
      let pathname;
      try {
        pathname = decodeURIComponent((request.url || '/').split('?')[0]);
      } catch {
        return send(400, { error: 'Invalid URL.' });
      }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) {
        return send(403, { error: 'Path is not available.' });
      }
      if (pathname === '/api/open-file') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          return send(405, { error: 'Use POST to open a file on the desktop.' });
        }
        if (request.headers.origin !== `http://${request.headers.host}`) return send(403, { error: 'Open files from the local Space Drift page.' });
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          return send(415, { error: 'This request must use application/json.' });
        }
        const body = await readJsonBody(request);
        if (!body || Array.isArray(body) || typeof body !== 'object') return send(400, { error: 'A file path is required.' });
        try {
          return send(200, await launchMappedFile(root, body.path, readWorld, { execute: nativeExecutor, platform: nativePlatform }));
        } catch (error) {
          if (error instanceof FileAccessError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code)) throw error;
          return send(502, { error: 'The desktop app could not open this file. You can still view supported files here.' });
        }
      }
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return send(405, { error: 'Only GET requests are supported on this route.' });
      }
      if (pathname === '/runtime.json') return send(200, { localServer: true });
      if (pathname === '/api/health') return send(200, { ok: true, name: 'Space Drift', protocolVersion: 3, capabilities: ['file-preview', 'native-file-open', 'layers', 'space', 'planet', 'search', 'tours'] });
      if (pathname === '/api/world') return send(200, await universe.readSpace());
      const parameters = new URL(request.url, `http://${request.headers.host}`).searchParams;
      if (pathname === '/api/planet' || pathname.startsWith('/api/planet/')) {
        const id = pathname === '/api/planet' ? parameters.get('id') : pathname.slice('/api/planet/'.length);
        if (!id) return send(400, { error: 'A body ID is required.' });
        return send(200, await universe.readPlanet(id));
      }
      if (pathname === '/api/search') return send(200, { results: universe.search(parameters.get('q') || '', parameters.has('limit') ? parameters.get('limit') : 60) });
      if (pathname === '/api/tours') return send(200, await universe.tours());
      if (pathname === '/api/file' || pathname === '/api/file-content') {
        const filePath = new URL(request.url, `http://${request.headers.host}`).searchParams.get('path');
        if (pathname === '/api/file') return send(200, await readFilePreview(root, filePath, readWorld));
        const { handle, metadata } = await openMappedFile(root, filePath, readWorld);
        try {
          if (metadata.kind === 'unsupported' || metadata.kind === 'text') {
            return send(415, { error: 'This file has no browser media preview.' });
          }
          let range;
          try {
            range = parseByteRange(request.headers.range, metadata.size);
          } catch (error) {
            if (error.status === 416) response.setHeader('Content-Range', `bytes */${metadata.size}`);
            throw error;
          }
          // Even a directly opened SVG/PDF cannot run scripts or load remote resources.
          response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'none'; sandbox");
          response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(metadata.name).replace(/'/g, '%27')}`);
          response.setHeader('Accept-Ranges', 'bytes');
          response.setHeader('Content-Type', metadata.mime);
          response.setHeader('Content-Length', range ? range.end - range.start + 1 : metadata.size);
          if (range) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${metadata.size}`);
          response.writeHead(range ? 206 : 200);
          if (metadata.size === 0) return response.end();
          await pipeline(handle.createReadStream({ autoClose: false, start: range?.start ?? 0, end: range?.end ?? metadata.size - 1 }), response);
          return;
        } finally {
          await handle.close();
        }
      }
      if (pathname.startsWith('/api/')) return send(404, { error: 'Unknown API route.' });
      let filePath;
      const vendorFile = VENDOR_FILES.get(pathname);
      const addonFile = ADDON_FILES.get(pathname);
      if (vendorFile || addonFile) {
        const vendorPath = await realpath(addonFile ? addonDirectory : vendorDirectory);
        filePath = await realpath(path.join(vendorPath, addonFile || vendorFile));
        if (!filePath.startsWith(vendorPath + path.sep)) return send(403, { error: 'Path is not available.' });
      } else {
        if (pathname.startsWith('/vendor/') || pathname.split('/').some((part) => part.startsWith('.'))) {
          return send(404, { error: 'File not found.' });
        }
        const publicPath = await realpath(publicDirectory);
        const requestedPath = path.resolve(publicPath, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!requestedPath.startsWith(publicPath + path.sep)) return send(403, { error: 'Path is not available.' });
        filePath = await realpath(requestedPath);
        if (!filePath.startsWith(publicPath + path.sep)) return send(403, { error: 'Path is not available.' });
      }
      if (!(await stat(filePath)).isFile()) return send(404, { error: 'File not found.' });
      const body = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream' });
      response.end(body);
    } catch (error) {
      if (response.headersSent || response.destroyed) {
        if (!response.destroyed) response.destroy();
        return;
      }
      if (error instanceof FileAccessError || error.status === 404) return send(error.status, { error: error.message });
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return send(404, { error: 'File not found.' });
      if (error.code === 'ELOOP') return send(403, { error: 'Linked files and folders cannot be opened.' });
      if (error.code === 'EACCES' || error.code === 'EPERM') return send(403, { error: 'Permission denied.' });
      console.error('Space Drift request failed:', error.message);
      send(500, { error: 'Could not scan this folder. Check that it is still available.' });
    }
  });
  server.once('close', () => universe.dispose());
  server.universe = universe;
  return server;
}

export async function main(args = process.argv.slice(2)) {
  let root = path.dirname(APP_DIRECTORY);
  let port = Number(process.env.PORT || 4188);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      console.log('Usage: npm start -- [--root /absolute/folder] [--port 4188]');
      return;
    }
    if (argument === '--root' && args[index + 1]) root = path.resolve(args[++index]);
    else if (argument === '--port' && args[index + 1]) port = Number(args[++index]);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  if (!(await stat(root)).isDirectory()) throw new Error('The selected root must be a directory.');
  root = await realpath(root);
  const server = createServer({ root });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Space Drift is ready: http://127.0.0.1:${port}`);
  console.log(`Mapping metadata in ${root}`);
  console.log('Read-only map. Files open locally on demand. Press Ctrl+C to stop.');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Space Drift: ${error.message}`);
    process.exitCode = 1;
  });
}
