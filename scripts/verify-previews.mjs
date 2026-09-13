import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPreviewServer } from './preview.mjs';
import { previewFixtures } from './preview-fixtures.mjs';

// Isolated viewer integration evidence. This does not simulate a game journey.
const output = new URL('../artifacts/previews/', import.meta.url);
const fixtures = await previewFixtures();
const encoded = JSON.stringify(fixtures).replaceAll('<', '\\u003c');
const harness = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Space Drift reader verification</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/viewer.css"><style>#fixture-list{position:fixed;inset:20px;overflow:auto;display:flex;align-content:start;align-items:start;gap:8px;flex-wrap:wrap}#fixture-list button{padding:8px}#harness-switch{position:fixed;right:20px;top:20px;z-index:3}</style></head><body><main id="fixture-list" aria-label="Synthetic viewer fixtures"></main><script type="module">
import {createFileViewer} from '/viewer.js';
const definitions=${encoded};
const files=new Map(definitions.map(({path,mime,base64,size})=>[path,new File([size?new Uint8Array(size):Uint8Array.from(atob(base64),c=>c.charCodeAt(0))],path.split('/').at(-1),{type:mime,lastModified:1700000000000})]));
let source={kind:'directory',getFile:async path=>{if(!files.has(path))throw new Error('Missing synthetic file');return files.get(path);}};
const viewer=createFileViewer({getSource:()=>source});
function button(path){const button=document.createElement('button');button.textContent='Open '+path;button.onclick=()=>viewer.open({path,name:path.split('/').at(-1),size:files.get(path).size});document.querySelector('#fixture-list').append(button);}
for(const path of files.keys())button(path);
const switchButton=document.createElement('button');switchButton.id='harness-switch';switchButton.textContent='Switch synthetic source';switchButton.hidden=true;
switchButton.onclick=()=>{viewer.close();source={kind:'directory',getFile:async path=>path==='notes/README.md'?new File(['# Alternate source\\n\\nThe previous file lifetime has ended.'],'README.md'):files.get(path)};};
document.querySelector('#file-viewer').append(switchButton);
const race=document.createElement('button');race.textContent='Open dense workbook for source switch';race.onclick=()=>{switchButton.hidden=false;viewer.open({path:'office/dense.xlsx',name:'dense.xlsx',size:files.get('office/dense.xlsx').size});};document.querySelector('#fixture-list').append(race);
// A tiny original video avoids external media fixtures and optional CLI codecs.
const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;const paint=canvas.getContext('2d');
const stream=canvas.captureStream(10), recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'}), chunks=[];
recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
const videoReady=new Promise(resolve=>recorder.onstop=()=>{files.set('media/orbit.webm',new File(chunks,'orbit.webm',{type:'video/webm'}));button('media/orbit.webm');stream.getTracks().forEach(track=>track.stop());resolve();});
recorder.start();let frames=0;const animation=setInterval(()=>{paint.fillStyle='#101c32';paint.fillRect(0,0,160,100);paint.fillStyle='#5be1cc';paint.beginPath();paint.arc(40+frames*8,50,18,0,Math.PI*2);paint.fill();if(++frames===8){clearInterval(animation);recorder.stop();}},100);
await videoReady;document.body.dataset.ready='true';
</script></body></html>`;

let server, browser;
const metrics = [], captures = [], errors = [], remote = [], warnings = [];
try {
  await mkdir(output, { recursive: true });
  server = await createPreviewServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20000);
  await page.addInitScript(() => {
    const audit = window.__previewAudit = { urls: new Set(), workers: new Set(), jobs: [], revocations: 0 };
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL), OriginalWorker = Worker;
    URL.createObjectURL = blob => { const url = create(blob); audit.urls.add(url); return url; };
    URL.revokeObjectURL = url => { audit.urls.delete(url); audit.revocations++; revoke(url); };
    window.Worker = class extends OriginalWorker {
      constructor(url, options) { super(url, options); audit.workers.add(this); }
      postMessage(data, transfer) { audit.jobs.push({ format: data?.format || 'other', at: performance.now() }); return super.postMessage(data, transfer); }
      terminate() { audit.workers.delete(this); return super.terminate(); }
    };
  });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); else if (message.type() === 'warning') warnings.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === `${origin}/__preview-harness`) return route.fulfill({ contentType: 'text/html', body: harness });
    if (/^https?:/.test(url) && !url.startsWith(origin + '/')) { remote.push(url); return route.abort(); }
    return route.continue();
  });
  await page.goto(`${origin}/__preview-harness`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  const close = async () => {
    if (await page.locator('#file-viewer').evaluate(dialog => dialog.open)) await page.getByRole('button', { name: 'Close file and return to flight', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#file-viewer').open && window.__previewAudit.urls.size === 0 && window.__previewAudit.workers.size === 0);
  };
  const settle = async path => {
    await page.waitForFunction(path => document.querySelector('#viewer-path').textContent === path && document.querySelector('#viewer-content').getAttribute('aria-busy') === 'false', path);
  };
  const open = async path => {
    await close(); const start = performance.now();
    await page.getByRole('button', { name: `Open ${path}`, exact: true }).click();
    await settle(path);
    const state = await page.locator('#viewer-content').evaluate(element => ({ kind: element.dataset.kind, renderer: element.dataset.renderer, mode: element.dataset.mode }));
    metrics.push({ path, elapsedMs: Math.round(performance.now() - start), ...state });
    console.log(`Preview ${path}: ${state.renderer} (${metrics.at(-1).elapsedMs} ms observed)`);
  };
  const screenshot = async name => {
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('#viewer-content img')].map(image => image.decode().catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    captures.push({ name, images: await page.locator('#viewer-content img').evaluateAll(images => images.map(image => ({ naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, ...image.getBoundingClientRect().toJSON() }))) });
    await page.screenshot({ path: new URL(name, output).pathname });
  };
  const assertNoOverflow = async width => {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    assert.ok(await page.locator('#file-viewer').evaluate(dialog => { const r = dialog.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; }), 'Viewer fits viewport.');
  };

  await open('notes/README.md');
  assert.equal(await page.locator('#viewer-content h1').innerText(), 'The Kepler observatory');
  await page.waitForFunction(() => [...document.querySelectorAll('#viewer-content img')].some(image => image.complete && image.naturalWidth === 720));
  await screenshot('markdown-desktop.png');
  await page.locator('#viewer-source').click();
  await page.waitForFunction(() => document.querySelector('#viewer-content').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('.reader-source').innerText(), /^# The Kepler/);
  assert.equal(await page.evaluate(() => window.__previewAudit.urls.size), 0, 'Source mode revokes image URLs.');
  await page.locator('#viewer-preview').click(); await settle('notes/README.md');
  await page.getByRole('link', { name: 'Read the next note', exact: true }).click(); await settle('notes/next.md');
  assert.match(await page.locator('#viewer-content').innerText(), /scoped local link/);
  await open('notes/security.md');
  assert.equal(await page.evaluate(() => !!window.__unsafe), false);
  assert.equal(await page.locator('#viewer-content script,#viewer-content iframe,#viewer-content [onerror]').count(), 0);
  assert.equal(await page.locator('#viewer-content img').count(), 1);
  assert.deepEqual(remote, []);

  await open('notes/snippet.js');
  assert.ok(await page.locator('#viewer-content pre code span').count());
  assert.match(await page.locator('#viewer-content').innerText(), /export function approach/);
  assert.equal(await page.evaluate(() => !!window.__unsafe), false);
  await screenshot('code-desktop.png');
  await open('notes/raw.html'); assert.match(await page.locator('#viewer-content').innerText(), /<script>/);
  await open('notes/active.svg'); assert.match(await page.locator('#viewer-content').innerText(), /<svg/);
  assert.equal(await page.locator('#viewer-content svg').count(), 0);
  await open('notes/empty.txt'); assert.equal(await page.locator('#viewer-content pre').innerText(), '');
  await open('notes/large.txt'); assert.match(await page.locator('#viewer-status').innerText(), /256 KiB/);

  await open('data/precise.json'); assert.match(await page.locator('#viewer-content').innerText(), /900719925474099312345/);
  await page.getByRole('button', { name: 'Show original', exact: true }).click();
  assert.match(await page.locator('#viewer-content').innerText(), /1\.2300e\+99/);
  await open('data/events.jsonl'); assert.match(await page.locator('#viewer-content').innerText(), /9007199254740995/);
  await open('data/broken.json'); assert.match(await page.locator('#viewer-status').innerText(), /Invalid JSON/);
  await open('data/signals.csv'); assert.equal(await page.locator('.reader-table tbody tr').count(), 50);
  await page.getByLabel('First row contains headers').check();
  assert.equal(await page.locator('.reader-table thead th').nth(1).innerText(), 'id');
  assert.match(await page.locator('.reader-table tbody tr').first().innerText(), /00000/);
  await page.getByRole('button', { name: 'Next rows', exact: true }).click();
  assert.match(await page.locator('.reader-table-controls').innerText(), /51–100/);
  await screenshot('table-desktop.png');
  await open('data/signals.tsv'); assert.match(await page.locator('#viewer-content').innerText(), /00123/);
  await open('data/broken.csv'); assert.match(await page.locator('#viewer-status').innerText(), /Malformed/);

  await open('office/report.docx'); assert.match(await page.locator('#viewer-content h1').innerText(), /Observatory/);
  await page.waitForFunction(() => [...document.querySelectorAll('#viewer-content img')].some(image => image.complete && image.naturalWidth === 720));
  assert.equal(await page.evaluate(() => window.__previewAudit.urls.size), 1);
  await screenshot('docx-desktop.png');
  for (const format of ['xlsx', 'xls', 'ods']) {
    await open(`office/signals.${format}`); assert.match(await page.locator('#viewer-content').innerText(), /00123/);
    await page.getByRole('combobox', { name: 'Workbook sheet' }).selectOption('1');
    await page.waitForFunction(() => document.querySelector('#viewer-content').textContent.includes('Second sheet confirmed'));
    assert.equal(await page.locator('#viewer-content script').count(), 0);
  }
  for (const name of ['broken', 'encrypted', 'oversized']) { await open(`office/${name}.docx`); assert.match(await page.locator('#viewer-status').innerText(), /unavailable/i); }
  await open('office/unknown.pptx'); assert.match(await page.locator('#viewer-content').innerText(), /No preview/);

  await open('media/report.pdf'); assert.equal(await page.locator('.reader-pdf-canvas').count(), 1);
  assert.match(await page.locator('.textLayer').innerText(), /Kepler field report/);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#viewer-status').textContent.startsWith('Page 2 of 2'));
  assert.match(await page.locator('.textLayer').innerText(), /Second page/);
  await screenshot('pdf-desktop.png');
  await open('media/broken.pdf'); assert.match(await page.locator('#viewer-content').innerText(), /corrupt|valid PDF/i);
  for (const format of ['png', 'jpg', 'webp']) {
    await open(`notes/orbit.${format}`);
    await page.waitForFunction(() => document.querySelector('.reader-image')?.naturalWidth === 720);
  }
  await open('media/tone.wav'); await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  assert.equal(await page.locator('audio').evaluate(audio => audio.paused && audio.controls), true);
  await open('media/orbit.webm'); await page.waitForFunction(() => document.querySelector('video')?.readyState >= 1);
  assert.equal(await page.locator('video').evaluate(video => video.paused && video.controls), true);

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 568 });
    await open('notes/README.md'); await assertNoOverflow(width); await screenshot(`markdown-${width}.png`);
    await open('data/signals.csv'); await assertNoOverflow(width); await screenshot(`table-${width}.png`);
    await open('office/report.docx'); await assertNoOverflow(width); await screenshot(`docx-${width}.png`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await close();
  const jobsBefore = await page.evaluate(() => window.__previewAudit.jobs.length);
  await page.getByRole('button', { name: 'Open office/dense.xlsx', exact: true }).click();
  await page.waitForFunction(before => window.__previewAudit.jobs.length > before, jobsBefore);
  await close();
  await open('notes/README.md'); assert.match(await page.locator('#viewer-content').innerText(), /Kepler observatory/);
  await close();
  const switchJobs = await page.evaluate(() => window.__previewAudit.jobs.length);
  await page.getByRole('button', { name: 'Open dense workbook for source switch', exact: true }).click();
  await page.waitForFunction(before => window.__previewAudit.jobs.length > before, switchJobs);
  await page.getByRole('button', { name: 'Switch synthetic source', exact: true }).click();
  await page.waitForFunction(() => window.__previewAudit.workers.size === 0);
  await open('notes/README.md'); assert.match(await page.locator('#viewer-content').innerText(), /Alternate source/);
  await close();
  const resources = await page.evaluate(() => ({ liveUrls: window.__previewAudit.urls.size, liveWorkers: window.__previewAudit.workers.size, revocations: window.__previewAudit.revocations, workerJobs: window.__previewAudit.jobs.length }));
  assert.deepEqual(remote, [], 'No document-controlled remote request may start.');
  assert.deepEqual(errors, [], 'Viewer must not log errors or reject unexpectedly.');
  assert.equal(resources.liveUrls, 0); assert.equal(resources.liveWorkers, 0);
  const report = { scope: 'Isolated createFileViewer integration, not a game journey or percentile benchmark', metrics, captures, resources, errors, remote, warnings };
  await writeFile(new URL('verification.json', output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(new URL('failure.json', output), JSON.stringify({ error: error.stack, metrics, errors, remote, warnings }, null, 2));
  throw error;
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
