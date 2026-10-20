/**
 * Album-art colour themes, in the spirit of kew.
 *
 * The cover is drawn to a tiny canvas and reduced to a few dominant hues. If the
 * canvas is tainted (cross-origin art with no ACAO) or there is no art at all, we
 * fall back to a fixed palette and say so — `fromArt: false`.
 */

export interface Palette {
  primary: string;
  secondary: string;
  accent: string;
  /** False when these are Navilite's defaults rather than colours from the artwork. */
  fromArt: boolean;
}

export const DEFAULT_PALETTE: Palette = {
  primary: '#7cd2ff',
  secondary: '#a88cff',
  accent: '#ff80b4',
  fromArt: false,
};

const SAMPLE_SIZE = 32;

/**
 * The cover is fetched (rather than drawn straight from an <img>) so the canvas is
 * never tainted: a same-origin fetch is trivial, and a cross-origin one is governed by
 * CORS, which this instance of Navidrome does allow on getCoverArt. If the fetch or the
 * decode fails we keep the defaults rather than throwing a SecurityError into the UI.
 */
export async function paletteFromArtwork(url: string | null): Promise<Palette> {
  if (!url) return DEFAULT_PALETTE;
  try {
    const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) return DEFAULT_PALETTE;
    const blob = await response.blob();
    const image = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return DEFAULT_PALETTE;
    ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    image.close();
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return paletteFromPixels(data) ?? DEFAULT_PALETTE;
  } catch {
    // No art, no CORS, or no createImageBitmap. Defaults, labelled as such.
    return DEFAULT_PALETTE;
  }
}

interface Bucket {
  weight: number;
  lightness: number;
  count: number;
}

/** Dominant hues by hue bucket, weighted by saturation so greys lose. */
function paletteFromPixels(data: Uint8ClampedArray): Palette | null {
  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (alpha < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (l < 0.08 || l > 0.95) continue;
    const key = Math.round(h / 15); // 24 buckets of 15°
    const bucket = buckets.get(key) ?? { weight: 0, lightness: 0, count: 0 };
    bucket.weight += s * (1 - Math.abs(l - 0.55));
    bucket.lightness += l;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  if (buckets.size === 0) return null;

  const ranked = [...buckets.entries()]
    .map(([key, bucket]) => ({
      hue: key * 15 + 7,
      score: bucket.weight * Math.log(1 + bucket.count),
      lightness: bucket.lightness / bucket.count,
    }))
    .sort((a, b) => b.score - a.score);

  const picked = spread(ranked, 3);
  return {
    primary: hsl(picked[0].hue, Math.min(0.85, Math.max(0.45, 1 - Math.abs(picked[0].lightness - 0.55))), 0.66),
    secondary: hsl(picked[1].hue, 0.6, 0.6),
    accent: hsl(picked[2].hue, 0.7, 0.72),
    fromArt: true,
  };
}

/** Pick up to `count` hues that are actually far apart from each other. */
function spread(
  ranked: Array<{ hue: number; score: number; lightness: number }>,
  count: number,
): Array<{ hue: number; score: number; lightness: number }> {
  const chosen: Array<{ hue: number; score: number; lightness: number }> = [];
  for (const candidate of ranked) {
    const far = chosen.every((other) => Math.abs(hueDistance(other.hue, candidate.hue)) > 35);
    if (far) chosen.push(candidate);
    if (chosen.length === count) break;
  }
  for (const candidate of ranked) {
    if (chosen.length >= count) break;
    if (!chosen.includes(candidate)) chosen.push(candidate);
  }
  while (chosen.length < count) chosen.push(chosen[chosen.length - 1] ?? { hue: 210, score: 0, lightness: 0.5 });
  return chosen;
}

function hueDistance(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return [0, 0, lightness];
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === red) hue = ((green - blue) / delta) % 6;
  else if (max === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return [hue, saturation, lightness];
}
