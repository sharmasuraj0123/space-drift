import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createPreviewServer } from './preview.mjs';

// Run after `npm run build`, with other browser/build/test jobs stopped. These
// are isolated reader timings, not whole-game or physical-mobile benchmarks.
const samples = Math.max(3, Math.min(30, Number(process.env.PREVIEW_PERF_SAMPLES) || 10));
const bytes = 100 * 1024;
let fixture = '# Observatory field notes\n\n';
let section = 0;
while (Buffer.byteLength(fixture) < bytes) {
  fixture += `\n## Observation ${++section}\n\n`;
  fixture += ('The observatory records local signals as readable files. Each measurement links the instrument, its timing, and the surrounding conditions. **Preserve the original reading** and compare it with the next observation before choosing a route. ').repeat(4);
  fixture += '\n\n- [x] Capture the reading\n- [ ] Compare the next interval\n\n| Channel | Reading |\n| --- | --- |\n| Visible | 42 |\n| Infrared | 17 |\n';
  if (section % 4 === 0) fixture += '\n```js\nconst signal = { channel: "visible", reading: 42 };\nconsole.log(signal.reading);\n```\n';
}
fixture = fixture.slice(0, bytes);
assert.equal(Buffer.byteLength(fixture), bytes);
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const summarize = values => ({
  samples: values.length,
  readableMs: { median: percentile(values.map(value => value.readableMs), .5), p95: percentile(values.map(value => value.readableMs), .95) },
  worstMainThreadTaskMs: Math.max(...values.map(value => value.longestTaskMs)),
  worstTimerDriftMs: Math.max(...values.map(value => value.timerDriftMs)),
  controlClickRoundTripMs: { median: percentile(values.map(value => value.controlClickMs), .5), p95: percentile(values.map(value => value.controlClickMs), .95) },
});
const documentHTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/viewer.css"><style>body{margin:0;background:#080b18;color:#dbe4ff;font:15px sans-serif}#probe{position:fixed;z-index:100;top:8px;right:8px;padding:12px;border:1px solid #aab8ff;background:#141d35;color:white}#viewer-content{margin:50px auto;height:calc(100vh - 50px);overflow:auto;max-width:1000px}</style></head><body><button id="probe">Reader control</button><div id="tools"></div><div id="viewer-content"><article id="reader"></article></div></body></html>`;
const output = new URL('../artifacts/previews/performance.json', import.meta.url);
let browser, server;
const report = {
  measuredAt: new Date().toISOString(), fixture: { bytes, sections: section, content: 'Headings, prose, emphasis, task lists, tables and JavaScript fences' },
  method: 'First lazy adapter import through two animation frames after rendering. Cold uses a new browser context; warm repeats in that same page. Each file still gets a new worker. Loopback preview sends no-store responses. Control metric includes automation round trip; timer drift and long tasks describe main-thread work. The 4× case is CPU emulation, not physical mobile hardware. No whole-game performance claim.',
  profiles: {},
};
try {
  server = await createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.CHANNEL || 'chrome', headless: true });
  report.browser = browser.version();
  for (const [profile, rate, viewport] of [['desktop', 1, { width: 1280, height: 900 }], ['mobileEmulated4x', 4, { width: 390, height: 844 }]]) {
    const results = { cold: [], warm: [] };
    for (let index = 0; index < samples; index++) {
      const context = await browser.newContext({ viewport });
      try {
        const page = await context.newPage();
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate });
        await page.route('**/__reader_benchmark__', route => route.fulfill({ body: documentHTML, contentType: 'text/html' }));
        await page.goto(`${origin}/__reader_benchmark__`);
        await page.evaluate(() => {
          window.readerLongTasks = [];
          window.readerObserver = new PerformanceObserver(list => window.readerLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration }))));
          window.readerObserver.observe({ type: 'longtask', buffered: true });
          document.getElementById('probe').addEventListener('click', () => { window.readerClicks = (window.readerClicks || 0) + 1; });
        });
        for (const temperature of ['cold', 'warm']) {
          await page.evaluate(text => {
            const started = performance.now(), beforeClicks = window.readerClicks || 0;
            window.readerDispose?.dispose();
            const container = document.getElementById('reader'); container.replaceChildren();
            document.getElementById('viewer-content').scrollTop = 0;
            const controller = new AbortController();
            let timerDriftMs = 0, previous = started;
            const tick = setInterval(() => { const now = performance.now(); timerDriftMs = Math.max(timerDriftMs, now - previous - 20); previous = now; }, 20);
            window.readerRun = (async () => {
              try {
                const { render } = await import('/reader-assets/markdown.js');
                window.readerDispose = await render({ container, tools: document.getElementById('tools'), result: { name: 'field-notes.md', path: 'docs/field-notes.md', text, size: text.length }, signal: controller.signal, status: message => { window.readerStatus = message; }, resolveAsset: async () => null, openPath: () => {} });
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const end = performance.now();
                const tasks = window.readerLongTasks.filter(entry => entry.start >= started && entry.start <= end);
                return { readableMs: end - started, longestTaskMs: Math.max(0, ...tasks.map(entry => entry.duration)), timerDriftMs, headingCount: container.querySelectorAll('h1,h2').length, beforeClicks };
              } finally { clearInterval(tick); }
            })();
          }, fixture);
          const clickStarted = performance.now();
          await page.locator('#probe').click();
          const controlClickMs = performance.now() - clickStarted;
          const result = await page.evaluate(() => window.readerRun);
          assert.ok(result.headingCount > 10, 'Fixture must render as Markdown, not a source fallback.');
          assert.ok(await page.evaluate(before => window.readerClicks > before, result.beforeClicks), 'Reader controls must remain usable.');
          results[temperature].push({ ...result, controlClickMs });
        }
      } finally { await context.close(); }
    }
    report.profiles[profile] = { viewport, cpuRate: rate, cold: summarize(results.cold), warm: summarize(results.warm), raw: results };
    console.log(`${profile}: cold p95 ${report.profiles[profile].cold.readableMs.p95.toFixed(1)}ms; warm p95 ${report.profiles[profile].warm.readableMs.p95.toFixed(1)}ms.`);
  }
  await mkdir(new URL('../artifacts/previews/', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(`Performance observations saved to ${output.pathname}.`);
} finally { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); }
