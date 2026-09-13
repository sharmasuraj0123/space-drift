import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
export async function buildReaders(output, root = defaultRoot) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const names = ['markdown', 'code', 'data', 'documents', 'media', 'html', 'text.worker', 'data.worker', 'documents.worker'];
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(names.map(name => [name, `public/readers/${name}.js`])),
    outdir: output, bundle: true, splitting: true, format: 'esm', platform: 'browser',
    target: ['es2022'], minify: true, sourcemap: false, metafile: true,
    chunkNames: 'chunks/[name]-[hash]', legalComments: 'linked',
  });
  const pdf = path.join(root, 'node_modules/pdfjs-dist');
  await cp(path.join(pdf, 'build/pdf.worker.min.mjs'), path.join(output, 'pdf.worker.mjs'));
  for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(path.join(pdf, directory), path.join(output, 'pdf', directory), { recursive: true });
  }
  const dependencies = [];
  for (const name of ['markdown-it', 'dompurify', 'shiki', 'papaparse', 'mammoth', 'xlsx', 'jszip', 'pdfjs-dist']) {
    const directory = path.join(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    const license = (await readdir(directory)).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
    if (license) await cp(path.join(directory, license), path.join(output, `${name}.LICENSE.txt`));
    dependencies.push({ name, version: pkg.version, license: pkg.license, homepage: pkg.homepage });
  }
  const bundles = [];
  for (const [filename, details] of Object.entries(result.metafile.outputs)) {
    const absolute = path.resolve(root, filename);
    const bytes = await readFile(absolute);
    bundles.push({ file: path.relative(output, absolute), bytes: bytes.length, gzip: gzipSync(bytes).length,
      imports: details.imports.filter(item => !item.external).map(item => ({ file: path.relative(output, path.resolve(root, item.path)), kind: item.kind })) });
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ dependencies, bundles }, null, 2) + '\n');
  return result.metafile;
}
