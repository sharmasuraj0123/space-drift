import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from '../server.mjs';

// Install Chromium with `npx playwright install chromium`, or use CHANNEL=chrome.
// Every flight is driven through the UI; telemetry is read only for navigation and assertions.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'assets', 'screenshots');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'space-drift-capture-'));
const root = path.join(temporary, 'mission-control');
let browser, server, page;
const errors = [], consoleErrors = [];

async function fixtureFile(relative, content, ageHours = 0) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  const modified = new Date(Date.now() - ageHours * 3600000);
  await utimes(file, modified, modified);
}

async function buildFixture() {
  for (const repo of ['observatory', 'orbital-engine', 'field-notes']) {
    // An empty marker identifies a synthetic repository; no Git history is read.
    await mkdir(path.join(root, repo, '.git'), { recursive: true });
  }
  await fixtureFile('observatory/README.md', `# Observatory\n\nA small laboratory for watching our local universe.\n\n## Flight notes\n\n- Repositories become worlds.\n- Folders become molecules.\n- Every file becomes an atom you can explore.\n\nThis workspace is synthetic. It contains no personal or customer data.\n`);
  await fixtureFile('orbital-engine/README.md', '# Orbital engine\n\nExperiments in gravity, navigation, and light.\n', 3);
  await fixtureFile('field-notes/README.md', '# Field notes\n\nObservations from the places between the stars.\n', 6);
  for (let i = 0; i < 12; i++) {
    const index = String(i + 1).padStart(2, '0');
    await fixtureFile(`observatory/signals/spectrum-${index}.csv`, 'wavelength,intensity\n' + Array.from({ length: 80 + i * 11 }, (_, n) => `${380 + n * 2},${(Math.sin(n / 9 + i) * .35 + .6).toFixed(4)}`).join('\n'), i * 2);
    await fixtureFile(`orbital-engine/navigation/vector-${index}.js`, `// Synthetic navigation study ${index}\nexport const waypoints = [\n` + Array.from({ length: 22 + i * 4 }, (_, n) => `  { x: ${n * 3}, y: ${n % 7}, z: ${n * 5} },`).join('\n') + '\n];\n', i * 5);
    await fixtureFile(`field-notes/expeditions/log-${index}.md`, `# Expedition ${index}\n\n` + 'We mapped a quiet constellation and returned to the landing site.\n'.repeat(12 + i), i * 8);
  }
  await fixtureFile('flight-plan.md', '# Mission control\n\nVisit the observatory, chart a signal, and return home.\n', 2);
}

async function verifyInstanceEmission(browser, origin) {
  const probe = await browser.newPage({ viewport: { width: 48, height: 48 } });
  probe.on('pageerror', error => errors.push(error.message));
  probe.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await probe.route('**/__asset-gpu-regression__', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
<title>Space Drift isolated emission check</title><link rel="icon" href="/favicon.svg">
<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/vendor/addons/"}}</script>
<script type="module">
import * as THREE from 'three';
import { instanceEmission } from '/render-common.js';
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setSize(48,48); renderer.setClearColor(0); renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping; document.body.append(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.OrthographicCamera(-1,1,1,-1,.1,10); camera.position.z = 2;
const geometry = new THREE.PlaneGeometry(2,2);
geometry.setAttribute('color', new THREE.Float32BufferAttribute(Array(4).fill([1,1,1]).flat(),3));
geometry.setAttribute('emission', new THREE.InstancedBufferAttribute(new Float32Array([0]),1));
const material = new THREE.MeshStandardMaterial({ vertexColors:true, color:0xffffff, emissive:0xffffff, emissiveIntensity:1, metalness:0 });
instanceEmission(material);
const mesh = new THREE.InstancedMesh(geometry,material,1); mesh.setMatrixAt(0,new THREE.Matrix4()); mesh.setColorAt(0,new THREE.Color(.8,.1,.02)); scene.add(mesh);
const pixel = () => { renderer.render(scene,camera); const bytes = new Uint8Array(4), gl = renderer.getContext(); gl.readPixels(24,24,1,1,gl.RGBA,gl.UNSIGNED_BYTE,bytes); return [...bytes]; };
const cold = pixel(); geometry.attributes.emission.setX(0,.5); geometry.attributes.emission.needsUpdate = true; const excited = pixel();
document.body.dataset.result = JSON.stringify({ threeRevision: THREE.REVISION, cold, excited });
mesh.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
</script>` }));
  try {
    await probe.goto(`${origin}/__asset-gpu-regression__`);
    await probe.waitForFunction(() => !!document.body.dataset.result);
    const result = await probe.evaluate(() => JSON.parse(document.body.dataset.result));
    assert.ok(result.cold.slice(0,3).every(value => value <= 1), 'A cold instance must render black with no scene lights.');
    assert.ok(result.excited[0] > 80 && result.excited[0] > result.excited[1] * 2 && result.excited[1] > result.excited[2], 'Excitation must retain the instance tint instead of turning white.');
    await writeFile(path.join(output, 'gpu-emission.json'), JSON.stringify({ ...result, passed: true }, null, 2) + '\n');
    console.log(`GPU emission check passed: cold=${result.cold.join(',')}; excited=${result.excited.join(',')}`);
  } finally { await probe.close(); }
}

function telemetry() {
  return JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
}

async function faceTarget(target) {
  const angleTo = target => {
    const data = JSON.parse(document.querySelector('#scene').dataset.telemetry);
    const yaw = Math.atan2(data.position.x - target.x, data.position.z - target.z);
    return Math.atan2(Math.sin(yaw - data.yaw), Math.cos(yaw - data.yaw));
  };
  const angle = await page.evaluate(angleTo, target);
  if (Math.abs(angle) <= .12) return;
  const key = angle > 0 ? 'a' : 'd';
  await page.locator('#scene').focus();
  await page.keyboard.down(key);
  try {
    await page.waitForFunction(target => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry);
      const yaw = Math.atan2(data.position.x - target.x, data.position.z - target.z);
      return Math.abs(Math.atan2(Math.sin(yaw - data.yaw), Math.cos(yaw - data.yaw))) < .12;
    }, target);
  } finally { await page.keyboard.up(key); }
}

try {
  await buildFixture();
  await mkdir(output, { recursive: true });
  server = createServer({ root, universeOptions: { git: false } });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
    args: ['--enable-unsafe-swiftshader'],
  });
  await verifyInstanceEmission(browser, `http://127.0.0.1:${server.address().port}`);
  if (process.env.GPU_ONLY !== '1') {
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`); });
    page.on('console', message => {
      if (message.type() === 'error' || /shader error|VALIDATE_STATUS|program not valid/i.test(message.text())) consoleErrors.push(`${message.text()} (${message.location().url || 'browser'})`);
    });
    page.setDefaultTimeout(15000);
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
      return data.ready && data.modelAssets?.ready && data.modelAssets.names.length === 11 && data.bodies?.length === 4 && data.bodies.every(body => !body.pending);
    });
    assert.equal((await page.evaluate(telemetry)).modelAssets.source, 'Blender / GLB');
    // Real edits to the synthetic files excite the field through the normal refresh.
    for (const repo of ['observatory', 'orbital-engine', 'field-notes']) {
      await fixtureFile(`${repo}/live-signal.json`, JSON.stringify({ note: 'Synthetic live signal', readings: Array.from({ length: 2400 }, (_, n) => Math.sin(n / 24).toFixed(4)) }, null, 2));
    }
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
      return data.bodies?.filter(body => body.luminosity > 0).length >= 3;
    }, null, { timeout: 40000 });
    await page.getByRole('button', { name: 'Launch expedition' }).click();
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).paused);
    assert.equal(await page.locator('#pause-button use').getAttribute('href'), '/icons.svg#play');
    await page.getByRole('button', { name: 'Resume flight', exact: true }).click();
    await page.waitForFunction(() => !JSON.parse(document.querySelector('#scene').dataset.telemetry).paused);
    assert.equal(await page.locator('#pause-button use').getAttribute('href'), '/icons.svg#pause');

    const capture = async name => {
      // Let transient status text finish through its actual UI timer.
      await page.waitForFunction(() => !document.querySelector('#toast').classList.contains('show') && Number(getComputedStyle(document.querySelector('#toast')).opacity) === 0, null, { timeout: 15000 });
      await page.screenshot({ path: path.join(output, `${name}.png`) });
      const data = await page.evaluate(telemetry);
      console.log(`Captured ${name} (1280 × 800; ${data.drawCalls} draws, ${data.triangles} triangles, ${data.fps} fps)`);
    };
    await page.getByRole('button', { name: 'Atlas M', exact: true }).click();
    await page.locator('#atlas[open]').waitFor();
    const body = page.locator('#atlas-results .atlas-row').filter({ has: page.getByText('observatory', { exact: true }) });
    await body.getByRole('button', { name: 'Fly by', exact: true }).waitFor();
    await capture('atlas');
    await body.getByRole('button', { name: 'Fly by', exact: true }).click();
    await page.waitForFunction(() => !!JSON.parse(document.querySelector('#scene').dataset.telemetry).route);
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
      return data.launched && data.layer?.name === 'space' && !data.route;
    }, null, { timeout: 90000 });
    // Finish with the observatory in front of the camera using normal steering.
    await faceTarget((await page.evaluate(telemetry)).bodies.find(body => body.id === 'observatory').center);
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
    await capture('space');
    await page.getByRole('button', { name: 'Resume flight', exact: true }).click();
    await page.getByRole('button', { name: 'Atlas M', exact: true }).click();
    await body.getByRole('button', { name: 'Land', exact: true }).click();
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
      return data.ready && data.layer?.name === 'planet' && data.layer.planetId === 'observatory';
    }, null, { timeout: 60000 });
    assert.equal(await page.locator('#pause-button use').getAttribute('href'), '/icons.svg#pause');
    await page.getByRole('button', { name: 'Atlas M', exact: true }).click();
    const signals = page.locator('#atlas-results .atlas-row').filter({ has: page.getByText('signals', { exact: true }) });
    await signals.getByRole('button', { name: 'Fly there', exact: true }).click();
    await page.waitForFunction(() => !!JSON.parse(document.querySelector('#scene').dataset.telemetry).route);
    await page.waitForFunction(() => !JSON.parse(document.querySelector('#scene').dataset.telemetry).route, null, { timeout: 60000 });
    // Frame the authored folder cage and files through the same controls as a pilot.
    const molecule = (await page.evaluate(telemetry)).planet.nearest.molecule;
    assert.equal(molecule.id, 'signals');
    await faceTarget(molecule.center);
    const distance = Math.max(45, molecule.clusterRadius * 2.2);
    await page.keyboard.down('s');
    try {
      await page.waitForFunction(({ center, distance }) => {
        const { position } = JSON.parse(document.querySelector('#scene').dataset.telemetry);
        return Math.hypot(position.x - center.x, position.z - center.z) >= distance;
      }, { center: molecule.center, distance });
    } finally { await page.keyboard.up('s'); }
    await page.keyboard.down('r');
    try {
      await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).position.y >= 22);
    } finally { await page.keyboard.up('r'); }
    await faceTarget(molecule.center);
    await page.getByRole('button', { name: 'Pause flight', exact: true }).click();
    await capture('surface');
    await page.getByRole('button', { name: 'Resume flight', exact: true }).click();

    await page.getByRole('button', { name: 'Atlas M', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Find a folder or file' }).fill('README.md');
    const file = page.locator('#atlas-results .atlas-row').filter({ has: page.getByText('README.md', { exact: true }) });
    await file.getByRole('button', { name: 'Fly there', exact: true }).click();
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
      return !data.route && data.scanCandidate?.distance < 18;
    }, null, { timeout: 60000 });
    await page.locator('#scene').press('KeyE');
    await page.locator('#file-viewer[open]').waitFor();
    await page.waitForFunction(() => document.querySelector('#viewer-content').dataset.kind === 'text');
    assert.match(await page.locator('#viewer-content').innerText(), /A small laboratory/);
    assert.equal(await page.locator('#viewer-desktop use').getAttribute('href'), '/icons.svg#external-link');
    await capture('viewer');
    await page.getByRole('button', { name: 'Close file and return to flight', exact: true }).click();
    await page.waitForFunction(() => !JSON.parse(document.querySelector('#scene').dataset.telemetry).viewerOpen);
    assert.equal((await page.evaluate(telemetry)).layer.name, 'planet');
    await page.getByRole('button', { name: 'L Lift off', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).layer.name === 'space');
    assert.equal(await page.locator('#pause-button use').getAttribute('href'), '/icons.svg#pause');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry);
      return !data.source && !data.ready && data.bodies.length === 0 && data.files === 0 && !data.viewerOpen && !data.route;
    });
    // Reconnect on the same page through the supported snapshot picker, not app state.
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('button', { name: 'Use the snapshot folder picker' }).click(),
    ]);
    await picker.setFiles(root);
    await page.waitForFunction(() => {
      const data = JSON.parse(document.querySelector('#scene').dataset.telemetry);
      return data.ready && data.source?.kind === 'snapshot' && data.modelAssets.ready && data.modelAssets.names.length === 11;
    });
    await page.getByRole('button', { name: 'Launch expedition' }).click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).launched);
    console.log('Verified 11 Blender models, launch, pause/resume, atlas routing, landing, preview, return to flight, lift-off, disconnect, and same-page snapshot reconnect.');
  }
  assert.deepEqual(errors, [], 'The capture flow must have no uncaught browser errors.');
  assert.deepEqual(consoleErrors, [], 'The capture flow must have no console or GPU shader errors.');
} catch (error) {
  if (page) console.error('Capture diagnostics:', JSON.stringify(await page.evaluate(() => ({
    error: document.querySelector('#error-message')?.textContent,
    telemetry: document.querySelector('#scene')?.dataset.telemetry,
  })).catch(() => null)), { errors, consoleErrors });
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server?.listening ? server.close(resolve) : resolve());
  await rm(temporary, { recursive: true, force: true });
}
