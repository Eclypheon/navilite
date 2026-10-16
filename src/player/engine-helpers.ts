/*
 * v2.0-beta slice E1 — the engine's three pure helpers, out of `engine.ts`.
 *
 * They share one property: they are functions of their arguments and the clock, with no `this` and
 * no state — `withDeadline` bounds a promise (the bridge build), `askedRate` reads the bitrate a
 * stream URL asked for, `spectrumChecksum` fingerprints one frame of bands. Nothing here reads the
 * engine back, so the edge points one way.
 */

/**
 * A promise that resolves to `fallback` if `work` has not answered within `ms` (v1.9.2).
 *
 * Used for the one thing outside the bridge calls that could still hold a start for ever: building
 * the bridge itself. The timer is always cleared, so a fast answer leaves nothing running.
 */
export function withDeadline<T>(work: Promise<T>, fallback: T, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    work,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.warn(`[navilite] ${what} did not answer within ${ms} ms`);
        resolve(fallback);
      }, ms);
    }),
  ]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * The bitrate a stream URL asks Navidrome for, as a word (v1.9.8).
 *
 * Used in one sentence only — the boundary's account of a warm asset that is not the stream the
 * play request asks for — and it exists because "a different stream" was not enough to tell a rung
 * move from a re-created client, which is what the sentence has to distinguish.
 */
export function askedRate(url: string): string {
  const match = /[?&]maxBitRate=(\d+)/.exec(url);
  return match ? `${match[1]} kbps` : 'the original file';
}

/**
 * A cheap fingerprint of one frame of bands.
 *
 * Zero only for a frame that is entirely silent, which is the case the "is it frozen?" question must
 * not confuse with "has it changed?" — silence is already its own answer (the zero-frame counter).
 */
export function spectrumChecksum(bands: readonly number[]): number {
  let checksum = 0;
  for (let index = 0; index < bands.length; index += 1) {
    checksum = (checksum + (bands[index] ?? 0) * (index + 1)) % 2147483647;
  }
  return checksum;
}
