import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'public');
const css = await readFile(path.join(output, 'styles.css'), 'utf8');
const palette = Object.fromEntries([...css.matchAll(/--(ink|accent|cyan|soft|muted|coral):([^;]+)/g)].map(([, name, value]) => [name, value]));
const background = '#080b18';
const sprite = await readFile(path.join(output, 'icons.svg'), 'utf8');
const mark = sprite.match(/<symbol id="brand"[^>]*>([\s\S]*?)<\/symbol>/)?.[1];
if (!mark) throw new Error('The approved brand symbol is missing from public/icons.svg.');
await mkdir(path.join(output, 'assets'), { recursive: true });

function appIcon({ maskable = false, adaptive = false } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
${adaptive ? `<style>@media(prefers-color-scheme:light){.tile{fill:${palette.ink}}.mark{color:${background}}}</style>` : ''}
<rect class="tile" width="100" height="100" rx="${maskable ? 0 : 22}" fill="${background}"/>
<g class="mark" color="${palette.accent}" transform="${maskable ? 'translate(30 23.6) scale(.4)' : 'translate(22 13.04) scale(.56)'}">${mark}</g></svg>`;
}
await writeFile(path.join(output, 'favicon.svg'), appIcon({ adaptive: true }));
for (const [filename, size, maskable] of [
  ['favicon-16.png', 16, false], ['favicon-32.png', 32, false],
  ['apple-touch-icon.png', 180, true], ['icon-192.png', 192, false],
  ['icon-512.png', 512, false], ['icon-maskable-512.png', 512, true],
]) {
  await sharp(Buffer.from(appIcon({ maskable }))).resize(size, size).png().toFile(path.join(output, filename));
}

// SVG image consumers (including GitHub's renderer) reliably support embedded PNG.
const art = (await sharp(path.join(output, 'assets/orbital-scene.webp')).png().toBuffer()).toString('base64');
function card(width, height) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 1200 630" role="img" aria-labelledby="title desc">
<title id="title">Space Drift — Your files. In orbit.</title>
<desc id="desc">A ceramic explorer ship flies between a ringed blue planet, a coral moon, and molecular satellites. A product by quirq.ai.</desc>
<defs><linearGradient id="scrim"><stop stop-color="${background}"/><stop offset=".43" stop-color="${background}" stop-opacity=".9"/><stop offset=".62" stop-color="${background}" stop-opacity="0"/></linearGradient></defs>
<rect width="1200" height="630" fill="${background}"/>
<image href="data:image/png;base64,${art}" width="1200" height="750" y="-60"/>
<rect width="1200" height="630" fill="url(#scrim)"/>
<g transform="translate(64 48) scale(.25)" color="${palette.accent}">${mark}</g>
<g font-family="Arial, Helvetica, sans-serif">
<text x="104" y="72" font-size="19" font-weight="600" letter-spacing="4" fill="${palette.ink}">SPACE DRIFT</text>
<text x="64" y="176" font-size="11" letter-spacing="2.8" fill="${palette.cyan}">A WORLD IN YOUR WORKSPACE</text>
<text x="60" y="266" font-size="78" letter-spacing="-4" fill="${palette.ink}">Your files.</text>
<text x="60" y="355" font-size="96" font-family="Georgia, 'Times New Roman', serif" font-style="italic" letter-spacing="-4" fill="${palette.accent}">In orbit.</text>
<text x="64" y="409" font-size="19" fill="${palette.soft}">Fly through your folders.</text>
<text x="64" y="437" font-size="19" fill="${palette.soft}">Discover a universe that’s already yours.</text>
<path d="M65 487h38" stroke="${palette.cyan}" stroke-width="2"/>
<text x="116" y="491" font-size="12" letter-spacing="1.2" fill="${palette.soft}">YOUR FILES STAY ON YOUR DEVICE</text>
<text x="64" y="574" font-size="13" fill="${palette.muted}">A product by <tspan fill="${palette.ink}">quirq.ai</tspan></text>
<text x="1136" y="574" text-anchor="end" font-size="11" letter-spacing="2" fill="${palette.soft}">EXPLORE / LAND / DISCOVER</text>
</g></svg>`;
}
await writeFile(path.join(root, 'assets/space-drift-hero.svg'), card(1600, 840));
await sharp(Buffer.from(card(1200, 630))).png().toFile(path.join(output, 'assets/social-card.png'));
console.log('Exported app icons, 1200×630 social card, and 1600×840 README hero.');
