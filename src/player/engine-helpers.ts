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

/** How far a player's own reading may sit from the track's duration and still be believed (ms). */
export const MEASURED_DURATION_SLACK_MS = 1_000;

/** The same, as a fraction — a long track may be a second and a bit out without being a liar. */
export const MEASURED_DURATION_SLACK_RATIO = 0.02;

/**
 * **Is the player's own measurement of this item's length believable?** (`t_644f6085`)
 *
 * The owner, on the iOS build: *"The song Tank! initially appears to be 3:30 long but when it ends
 * or i try to seek on it it suddenly becomes 70:01 long — not sure how this error even came about."*
 *
 * It came about because the app asked the player, and the player estimated. `RemoteAudioAsset`
 * (the vendored transport) builds its item from an `AVURLAsset` whose
 * `AVURLAssetPreferPreciseDurationAndTimingKey` this project **sets to false**
 * (`tools/patch-native-audio.mjs`, patch `ios-precise-duration`, for time to first sound). With
 * precise duration off, AVFoundation does not read the container: it answers with an estimate — and
 * for Ogg/Opus, the one container it cannot index from the header, the estimate is fiction. Measured
 * on this machine, through that transport, over HTTP with range requests:
 *
 * | file | the file (ffprobe) | `precise: false` (shipped) | `precise: true` |
 * |---|---|---|---|
 * | Tank!.opus (Opus, VBR) | 210.3475 s | **4201.84 s** | 210.3335 s |
 * | 以朋友的身份.opus    | 210.6275 s | 296.08 s | 210.6135 s |
 * | 那些你不能给我的.opus | 219.2875 s | 190.14 s | 219.2735 s |
 * | a.mp3 (CBR)        | 180.6667 s | 180.696 s | 180.6667 s |
 * | a.flac (lossless)  | 206.0732 s | 206.080 s | 206.0732 s |
 *
 * So the estimate is not a measurement, it is a guess about a container nobody opened — 20× too long
 * for one Opus track and 13% too *short* for another, while MP3 and FLAC come back within 30 ms.
 * The app adopted it verbatim (v1.9.5: "the player's own numbers replace our guesses about them"),
 * which is what turned 3:30 into 70:01 on the bar **and** stopped every Opus track from ever being
 * judged finished — `reportIsAtEnd` compared a position of 210 s against a "duration" of 4202 s.
 *
 * **The rule, stated once:** a number the player reports is used when the track has no duration of
 * its own, or when the two agree. When they disagree beyond the slack the *library's* number stands
 * — Navidrome's duration is computed from the file's own container (`media_file.duration` = 210.34 s
 * for this track), and the player's is what its transport could work out about a remote item.
 *
 * The slack is a separation, not a preference: every *working* measurement on this machine is
 * within 30 ms of its file and every wrong one is out by 13% or 1900%, so nothing real sits
 * anywhere near it. `knownMs <= 0` is the one case with nothing to check against — a stream, a
 * radio item, a row whose duration is blank — and there the measurement is all there is.
 */
export function measuredDurationIsBelievable(knownMs: number, measuredMs: number): boolean {
  if (!Number.isFinite(measuredMs) || measuredMs <= 0) return false;
  if (!Number.isFinite(knownMs) || knownMs <= 0) return true;
  const slack = Math.max(MEASURED_DURATION_SLACK_MS, knownMs * MEASURED_DURATION_SLACK_RATIO);
  return Math.abs(measuredMs - knownMs) <= slack;
}
