import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST_DIRECTORY = fileURLToPath(new URL('../dist/', import.meta.url));
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.glb', 'model/gltf-binary'],
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'], ['.wasm', 'application/wasm'],
]);

export async function createPreviewServer({ root = DIST_DIRECTORY } = {}) {
  const directory = await realpath(root);
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    const send = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : message);
    };
    if (!/^127\.0\.0\.1(?::\d+)?$/.test(request.headers.host || '')) return send(403, 'Use the loopback preview address.');
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      return send(405, 'Only GET and HEAD are supported.');
    }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some((part) => part.startsWith('.'))) {
        return send(403, 'This path is not public.');
      }
      const filename = await realpath(path.join(directory, pathname === '/' ? 'index.html' : pathname));
      if (!filename.startsWith(directory + path.sep)) return send(403, 'This path is not public.');
      const info = await stat(filename);
      if (!info.isFile()) return send(404, 'Not found.');
      response.writeHead(200, {
        'Content-Type': MIME.get(path.extname(filename)) || 'application/octet-stream',
        'Content-Length': info.size,
      });
      if (request.method === 'HEAD') return response.end();
      const stream = createReadStream(filename);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      if (error instanceof URIError || error instanceof TypeError) return send(400, 'Invalid request path.');
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return send(404, 'Not found.');
      if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return send(403, 'This path is not public.');
      send(500, 'Could not read this asset.');
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('Usage: npm run preview -- --port 4190');
  const port = args.length ? Number(args[1]) : 4190;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 to 65535.');
  const server = await createPreviewServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Space Drift static preview: http://127.0.0.1:${port}`);
  console.log('Choose a folder in the browser. Press Ctrl+C to stop.');
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.code === 'ENOENT' ? 'Run npm run build before starting the preview.' : error.message);
    process.exitCode = 1;
  });
}
