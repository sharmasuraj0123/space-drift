import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createPreviewServer } from './preview.mjs';

// All mission objectives are earned with real controls; telemetry is read-only.
const temporary = await mkdtemp(path.join(os.tmpdir(), 'space-drift-demo-'));
const output = new URL('../artifacts/sample/', import.meta.url);
const state = () => JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
let browser, server;
try {
  await mkdir(output, { recursive: true });
  const folder = path.join(temporary, 'my-workspace');
  await mkdir(folder);
  await writeFile(path.join(folder, 'README.md'), '# My workspace\nA separate local folder for verifying the demo handoff.\n');
  server = await createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  let choosers = 0;
  page.on('filechooser', () => choosers++);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const step = id => page.waitForFunction(id => {
    const s = JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}');
    return s.tutorial?.active && s.tutorial.id === id && s.tutorial.status === 'playing';
  }, id, { timeout: 45000 });
  const ready = () => page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}').modelAssets?.ready);
  const capture = name => page.screenshot({ path: new URL(name, output).pathname });
  const readAndClose = async text => {
    await page.locator('#scene').press('KeyE');
    await page.waitForFunction(() => document.querySelector('#viewer-content').dataset.kind === 'text');
    assert.match(await page.locator('#viewer-content').innerText(), text);
    await page.getByRole('button', { name: 'Close file and return to flight', exact: true }).click();
  };
  const flyGate = async id => {
    await step(id);
    const target = (await page.evaluate(state)).tutorial.target.position;
    const angle = await page.evaluate(target => {
      const s = JSON.parse(document.querySelector('#scene').dataset.telemetry);
      const desired = Math.atan2(s.position.x - target.x, s.position.z - target.z);
      return Math.atan2(Math.sin(desired - s.yaw), Math.cos(desired - s.yaw));
    }, target);
    await page.locator('#scene').focus();
    if (Math.abs(angle) > .04) {
      const key = angle > 0 ? 'a' : 'd';
      await page.keyboard.down(key);
      try {
        await page.waitForFunction(target => {
          const s = JSON.parse(document.querySelector('#scene').dataset.telemetry);
          const desired = Math.atan2(s.position.x - target.x, s.position.z - target.z);
          return Math.abs(Math.atan2(Math.sin(desired - s.yaw), Math.cos(desired - s.yaw))) < .09;
        }, target);
      } finally { await page.keyboard.up(key); }
    }
    await page.keyboard.down('w');
    try {
      await page.waitForFunction(id => JSON.parse(document.querySelector('#scene').dataset.telemetry).tutorial.completed.includes(id), id);
    } finally { await page.keyboard.up('w'); }
    console.log(`Earned ${id} by flying through its gate.`);
  };
  await page.goto(origin);
  await ready();
  await capture('welcome-desktop.png');
  await page.locator('#explore-sample').click();
  await step('thrust');
  assert.equal(choosers, 0);
  assert.equal(await page.locator('.tutorial-next').count(), 0, 'Progress cannot be clicked through.');
  await page.waitForTimeout(1000); // Let the chase camera settle for the artifact.
  assert.equal((await page.evaluate(state)).tutorial.score, 0, 'Waiting does not earn a mission objective.');
  await capture('mission-desktop.png');
  await flyGate('thrust');
  await step('steer');
  // Pause and reset do not award a checkpoint.
  await page.locator('#scene').press('Escape');
  const pausedScore = (await page.evaluate(state)).tutorial.score;
  await page.waitForTimeout(300);
  assert.equal((await page.evaluate(state)).tutorial.score, pausedScore);
  await page.locator('.demo-primary').filter({ hasText: 'Resume flight' }).click();
  const checkpointTarget = (await page.evaluate(state)).tutorial.target.position;
  await page.locator('#scene').press('Home');
  await page.waitForTimeout(200);
  assert.equal((await page.evaluate(state)).tutorial.score, 100, 'Home resets the flight checkpoint without awarding a gate.');
  assert.deepEqual((await page.evaluate(state)).tutorial.target.position, checkpointTarget);
  await flyGate('steer');
  await step('brake');
  await page.locator('#scene').focus();
  await page.keyboard.down('Space');
  try { await step('approach'); } finally { await page.keyboard.up('Space'); }
  assert.equal((await page.evaluate(state)).tutorial.score, 300);
  await page.locator('.demo-primary').click();
  await step('land');
  await page.locator('#scene').press('KeyL');
  await step('open');
  await capture('mission-surface.png');
  await readAndClose(/Welcome to the observatory/);
  await step('overlay');
  await page.locator('#scene').press('KeyG');
  await step('discover');
  await page.locator('.demo-primary').click();
  await page.waitForFunction(() => document.querySelector('#atlas-results').textContent.includes('spectrum-01.csv'));
  const result = page.locator('.atlas-row').filter({ hasText: 'spectrum-01.csv' });
  await result.getByRole('button', { name: 'Fly there', exact: true }).click();
  await page.waitForFunction(() => {
    const s = JSON.parse(document.querySelector('#scene').dataset.telemetry);
    return !s.route && s.scanCandidate?.id === 'observatory/signals/spectrum-01.csv' && s.scanCandidate.distance < 18;
  }, null, { timeout: 60000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.demo-primary').filter({ hasText: 'Open signal' }).click();
  await page.waitForFunction(() => document.querySelector('#viewer-content').dataset.kind === 'text');
  assert.match(await page.locator('#viewer-content').innerText(), /wavelength_nm,synthetic_intensity/);
  await page.getByRole('button', { name: 'Close file and return to flight', exact: true }).click();
  await step('takeoff');
  await page.locator('.demo-primary').filter({ hasText: 'Lift off' }).click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).tutorial.status === 'complete');
  const completed = (await page.evaluate(state)).tutorial;
  assert.equal(completed.score, 900);
  assert.equal(completed.completed.length, 9);
  await page.setViewportSize({ width: 1280, height: 800 });
  await capture('mission-complete.png');
  console.log('All nine objectives earned through flight, landing, file reads, Atlas and lift-off. Score: 900.');

  await page.locator('.demo-restart').click();
  await step('thrust');
  assert.equal((await page.evaluate(state)).tutorial.score, 0);
  assert.equal((await page.evaluate(state)).layer.name, 'space');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000); // Let the restarted chase camera settle.
  await capture('mission-mobile.png');
  const hold = page.locator('.demo-controls [data-control="KeyW"]');
  const rect = await hold.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  try { await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).tutorial.completed.includes('thrust')); }
  finally { await page.mouse.up(); }
  await step('steer');
  await page.locator('.demo-primary').click();
  assert.equal((await page.evaluate(state)).tutorial.score, 100);
  await page.setViewportSize({ width: 320, height: 568 });
  await page.waitForTimeout(300);
  await capture('mission-small-mobile.png');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  assert.ok(await page.evaluate(() => {
    const card = document.querySelector('#tutorial-guide').getBoundingClientRect();
    const footer = document.querySelector('footer').getBoundingClientRect();
    const controls = document.querySelector('.demo-controls').getBoundingClientRect();
    return card.bottom < footer.top && card.top > 280 && controls.top >= card.top && controls.bottom <= card.bottom;
  }), 'The mobile cockpit keeps its controls and footer accessible with a clear view above.');
  await page.locator('.demo-exit').click();
  assert.equal((await page.evaluate(state)).source.kind, 'sample');
  await page.locator('#tutorial-guide').waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => { window.showDirectoryPicker = undefined; });
  await page.reload();
  await ready();
  await page.locator('#explore-sample').click();
  await step('thrust');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#folder-button').click();
  await (await chooser).setFiles(folder);
  await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry || '{}').source?.kind === 'snapshot');
  assert.equal(await page.locator('#tutorial-guide').isVisible(), false);
  assert.equal(await page.locator('#demo-target-marker').isVisible(), false);
  await page.locator('#launch').click();
  await page.waitForFunction(() => JSON.parse(document.querySelector('#scene').dataset.telemetry).scanCandidate?.distance < 18);
  await readAndClose(/separate local folder/);
  assert.deepEqual(errors, []);
  assert.ok(requests.every(request => request.method === 'GET' && request.url.startsWith(origin) && !new URL(request.url).pathname.startsWith('/api/')), 'The sample needs only static app assets, without API calls or uploads.');
  console.log('Restart, press-and-hold mobile flight, reset, free flight and local-folder handoff passed.');
} finally {
  await browser?.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
