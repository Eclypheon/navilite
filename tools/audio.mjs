/**
 * Synthetic audio for the mock library — real PCM, not silence.
 *
 * The point is that the analyser test can be exact: each track is a chord of known
 * sine partials with a slow tremolo, so a real spectrum must show energy at those
 * frequencies and nowhere near the ones a track does not contain.
 */

export const SAMPLE_RATE = 44100;
export const CHANNELS = 2;
export const BITS = 16;
const HEADER_BYTES = 44;

/** A few distinct chords; track index picks one. */
export const TRACK_PARTIALS = [
  [110, 330, 1320],
  [220, 440, 880],
  [440, 1760, 3520],
  [165, 660, 2640],
];

export function trackDurationSeconds(index) {
  return 20 + (index % 3) * 5;
}

/** Whole-file WAV bytes for a track index, cached by the caller if it wants. */
export function renderWav(trackIndex) {
  const partials = TRACK_PARTIALS[trackIndex % TRACK_PARTIALS.length];
  const seconds = trackDurationSeconds(trackIndex);
  const frames = Math.floor(seconds * SAMPLE_RATE);
  const dataBytes = frames * CHANNELS * (BITS / 8);
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * CHANNELS * (BITS / 8), 28);
  buffer.writeUInt16LE(CHANNELS * (BITS / 8), 32);
  buffer.writeUInt16LE(BITS, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  const gain = 0.7 / partials.length;
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / SAMPLE_RATE;
    // Tremolo keeps the spectrum animated instead of a frozen picture.
    const tremolo = 0.72 + 0.28 * Math.sin(2 * Math.PI * 1.7 * t);
    let sample = 0;
    for (const partial of partials) sample += Math.sin(2 * Math.PI * partial * t);
    const value = Math.max(-1, Math.min(1, sample * gain * tremolo));
    const pcm = Math.round(value * 32767);
    const offset = HEADER_BYTES + frame * 4;
    buffer.writeInt16LE(pcm, offset);
    buffer.writeInt16LE(pcm, offset + 2);
  }
  return buffer;
}

/** Cover art as RGBA pixels: a two-tone gradient, distinct per seed. */
export function coverPixels(seed, size) {
  const pixels = new Uint8Array(size * size * 4);
  const baseHue = (seed * 47) % 360;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const hue = (baseHue + (x / size) * 60 + (y / size) * 30) % 360;
      const lightness = 0.22 + 0.4 * (1 - y / size);
      const [r, g, b] = hslToRgb(hue, 0.55, lightness);
      const i = (y * size + x) * 4;
      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

function hslToRgb(hue, saturation, lightness) {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = hue / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb;
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = lightness - c / 2;
  return rgb.map((channel) => Math.round((channel + m) * 255));
}
