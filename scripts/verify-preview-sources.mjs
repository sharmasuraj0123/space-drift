import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';
import { previewFixtures } from './preview-fixtures.mjs';

// The actual source adapters and optional Node content route, through the reader UI.
const temp = await mkdtemp(path.join(os.tmpdir(), 'drift-reader-sources-'));
const fixtures = (await previewFixtures()).filter(file => ['notes/README.md', 'notes/orbit.png', 'notes/next.md', 'data/precise.json', 'office/report.docx', 'office/signals.xlsx', 'media/report.pdf'].includes(file.path));
const encoded = JSON.stringify(fixtures).replaceAll('<', '\\u003c');
const dist = new URL('../dist/', import.meta.url).pathname;
let server, browser;
try {
  for (const file of fixtures) { const target = path.join(temp, file.path); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, Buffer.from(file.base64, 'base64')); }
  server = createServer({ root: temp, publicDirectory: dist, readerDirectory: path.join(dist, 'reader-assets') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/viewer.css"></head><body><main id="files"></main><script type="module">
import {createFileViewer} from '/viewer.js';
import {createDirectorySource,createSnapshotSource} from '/folder-source.js';
const definitions=${encoded};
const files=definitions.map(({path,base64,mime})=>{const file=new File([Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],path.split('/').at(-1),{type:mime,lastModified:1700000000000});Object.defineProperty(file,'webkitRelativePath',{value:'workspace/'+path});return file;});
const directory=name=>({kind:'directory',name,children:new Map(),async *entries(){yield* this.children;},async getDirectoryHandle(name){const entry=this.children.get(name);if(entry?.kind!=='directory')throw new Error('Missing folder');return entry;},async getFileHandle(name){const entry=this.children.get(name);if(entry?.kind!=='file')throw new Error('Missing file');return entry;}});
const root=directory('workspace');
files.forEach((file,index)=>{const parts=definitions[index].path.split('/');const name=parts.pop();let parent=root;for(const part of parts){if(!parent.children.has(part))parent.children.set(part,directory(part));parent=parent.children.get(part);}parent.children.set(name,{kind:'file',name,getFile:async()=>file});});
const mode=new URL(location.href).searchParams.get('mode');
const source=mode==='directory'?createDirectorySource(root):mode==='snapshot'?createSnapshotSource(files):{kind:'server'};
if(mode==='server')await fetch('/api/planet?id=__belt__');else await source.readWorld();
const viewer=createFileViewer({getSource:()=>source});
for(const file of definitions){const button=document.createElement('button');button.textContent='Open '+file.path;button.onclick=()=>viewer.open({path:file.path,name:file.path.split('/').at(-1),size:0});document.querySelector('#files').append(button);}
document.body.dataset.ready=mode;
</script></body></html>`;
  browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.route(`${origin}/__sources?*`, route => route.fulfill({ contentType: 'text/html', body: html }));
  for (const mode of ['directory', 'snapshot', 'server']) {
    requests.length = 0;
    await page.goto(`${origin}/__sources?mode=${mode}`);
    await page.waitForFunction(mode => document.body.dataset.ready === mode, mode);
    for (const file of ['notes/README.md', 'data/precise.json', 'office/report.docx', 'office/signals.xlsx', 'media/report.pdf']) {
      await page.getByRole('button', { name: `Open ${file}`, exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#viewer-content').getAttribute('aria-busy') === 'false');
      const status = await page.locator('#viewer-status').innerText();
      assert.doesNotMatch(status, /unavailable|Could not|Showing source|time limit/i, `${mode} ${file}: ${status}`);
      if (file.endsWith('.md')) assert.equal(await page.locator('#viewer-content h1').innerText(), 'The Kepler observatory');
      if (file.endsWith('.docx')) assert.match(await page.locator('#viewer-content').innerText(), /Observatory field report/);
      if (file.endsWith('.xlsx')) assert.equal(await page.locator('select[aria-label="Workbook sheet"] option').count(), 2);
      if (file.endsWith('.pdf')) assert.equal(await page.locator('.reader-pdf-canvas').count(), 1);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#file-viewer').open);
      console.log(`${mode}: ${file} rendered and closed.`);
    }
    if (mode !== 'server') assert.equal(requests.some(url => new URL(url).pathname.startsWith('/api/')), false);
  }
  assert.deepEqual(errors, []);
  await mkdir(new URL('../artifacts/previews/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/previews/source-verification.json', import.meta.url), JSON.stringify({ modes: ['directory', 'snapshot', 'server'], opens: 15, pageErrors: errors }, null, 2));
  console.log('Verified the actual directory, snapshot, and Node source adapters.');
} finally { await browser?.close(); await new Promise(resolve => server ? server.close(resolve) : resolve()); await rm(temp, { recursive: true, force: true }); }
