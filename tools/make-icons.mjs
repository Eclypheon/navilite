#!/usr/bin/env node
/**
 * Generates the PWA icons into public/.
 *
 * Kept as a script rather than a build step: icons change roughly never, and this way
 * `npm install` stays free of image tooling. The PNG encoder lives in tools/png.mjs
 * and needs nothing but zlib.
 *
 *   node tools/make-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'public');
mkdirSync(outDir, { recursive: true });

const BG = [11, 11, 16];
const ACCENTS = [
  [124, 210, 255],
  [168, 140, 255],
  [255, 128, 180],
];

/** Spectrum bars, tallest in the middle — the app's mark. */
function bars(size, inset) {
  const width = size - inset * 2;
  const height = size - inset * 2;
  const count = 7;
  const gap = Math.max(2, Math.round(size * 0.035));
  const barWidth = Math.floor((width - gap * (count - 1)) / count);
  const heights = [0.34, 0.52, 0.74, 1, 0.82, 0.58, 0.4];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const h = Math.round(height * heights[i]);
    out.push({
      x: inset + i * (barWidth + gap),
      y: inset + height - h,
      w: barWidth,
      h,
      color: ACCENTS[i % ACCENTS.length],
    });
  }
  return out;
}

function render(size, { inset = Math.round(size * 0.18) } = {}) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      pixels[i] = BG[0];
      pixels[i + 1] = BG[1];
      pixels[i + 2] = BG[2];
      pixels[i + 3] = 255;
    }
  }
  for (const bar of bars(size, inset)) {
    for (let y = 0; y < bar.h; y += 1) {
      const fade = 1 - 0.35 * (y / Math.max(1, bar.h - 1));
      for (let x = 0; x < bar.w; x += 1) {
        const i = ((bar.y + y) * size + (bar.x + x)) * 4;
        pixels[i] = Math.round(bar.color[0] * fade);
        pixels[i + 1] = Math.round(bar.color[1] * fade);
        pixels[i + 2] = Math.round(bar.color[2] * fade);
        pixels[i + 3] = 255;
      }
    }
  }
  return pixels;
}

const targets = [
  ['icon-192.png', 192, { inset: 34 }],
  ['icon-512.png', 512, { inset: 92 }],
  // Maskable icons must survive having their outer ~10% cropped: smaller mark, more padding.
  ['icon-maskable-512.png', 512, { inset: 128 }],
];

for (const [name, size, opts] of targets) {
  writeFileSync(resolve(outDir, name), encodePng(render(size, opts), size));
  console.log(`wrote public/${name} (${size}x${size})`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#0b0b10"/>
  <g fill="#7cd2ff">
    <rect x="12" y="36" width="5" height="14" rx="2"/>
    <rect x="19" y="28" width="5" height="22" rx="2" fill="#a88cff"/>
    <rect x="26" y="18" width="5" height="32" rx="2" fill="#ff80b4"/>
    <rect x="33" y="24" width="5" height="26" rx="2" fill="#a88cff"/>
    <rect x="40" y="32" width="5" height="18" rx="2"/>
  </g>
</svg>
`;
writeFileSync(resolve(outDir, 'favicon.svg'), svg);
console.log('wrote public/favicon.svg');
