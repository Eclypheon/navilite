/**
 * v1.9.0 — what bitrate to ask the server for, decided by what the link actually did.
 *
 * Subsonic streams the **original** file unless the client says otherwise: `maxBitRate` on
 * `stream` is what makes Navidrome transcode on demand, so the whole of this feature is one
 * client-side query parameter. There is nothing to change on the server and no downtime.
 *
 * Why it is needed at all: off wifi the tailnet may reach the home server through a DERP relay,
 * so the phone's link has desktop-class latency and mobile-class throughput. Pulling a lossless
 * or 320 kbps original over that is the difference between music and a stall — and the *many
 * small requests* the app makes (cover art, lyrics, the next stream) each pay that latency, which
 * is why queue-ahead and instant paint matter more than bandwidth.
 *
 * The two rules the owner asked for, in his words:
 *   - *"start modest on a slow link, raise it when throughput allows"* → the ladder below rises
 *     with the measurement and falls with it;
 *   - *"never silently cap quality"* → a cap is only ever applied when the app has measured the
 *     link, and while a cap is in force the player bar says the number (`queue.streamKbps` is
 *     what that chip reads). Nothing is capped on a fast link: `null` means the original.
 *
 * Pure, so it can be tested without a network: the measure-then-decide step is a function of
 * samples, and the samples are what the queue's prefetch already produces.
 */

/** One measured transfer: the bytes that arrived, and how long they took. */
export interface ThroughputSample {
  bytes: number;
  ms: number;
}

/**
 * The bitrates worth asking for, ascending. Standard Subsonic/Navidrome ladder values; a request
 * for something in between just transcode-redirects to the same sizes.
 */
export const BITRATE_LADDER = [64, 96, 128, 160, 192, 256, 320] as const;

/**
 * What is asked for before anything has been measured: modest, and not the bottom of the ladder —
 * an unmeasured link is usually a phone on wifi, and 96 kbps would be an audible downgrade for no
 * reason. This is the one value that is a guess, and it is the reason the chip gives the number.
 */
export const STARTING_KBPS = 128;

/** How much of the measured link a stream is allowed to use. The rest buffers the current track. */
const HEADROOM = 0.6;

/** How many samples the window keeps. Recent ones describe where you are now, not the coffee shop. */
const WINDOW = 5;

/** A sample shorter than this is a cached answer, not a network — it says nothing about the link. */
const MIN_SAMPLE_MS = 40;

/** kbps of a sample, or `null` when the sample cannot say anything about the link. */
export function kbpsOf(sample: ThroughputSample): number | null {
  if (!Number.isFinite(sample.bytes) || !Number.isFinite(sample.ms)) return null;
  if (sample.bytes <= 0 || sample.ms < MIN_SAMPLE_MS) return null;
  return (sample.bytes * 8) / sample.ms;
}

/**
 * The bitrate to ask for, from the samples taken so far.
 *
 * `null` = no cap at all (the original file). That is the answer when nothing has been measured
 * (there is nothing honest to cap on yet — see {@link STARTING_KBPS} for the start) *and* when the
 * link is comfortably past the top of the ladder, which is the "raise it when throughput allows"
 * half of the ask: on wifi the app never transcodes.
 */
export function chooseMaxBitRate(samples: readonly ThroughputSample[]): number | null {
  const rates = samples.map(kbpsOf).filter((rate): rate is number => rate !== null);
  if (rates.length === 0) return STARTING_KBPS;
  // The worst recent sample decides: a link that dropped to 90 kbps for the last transfer is a
  // link that cannot carry 320, however fast the one before it was.
  const measured = Math.min(...rates);
  if (measured * HEADROOM >= BITRATE_LADDER[BITRATE_LADDER.length - 1]!) return null;
  const affordable = BITRATE_LADDER.filter((rate) => rate <= measured * HEADROOM).pop();
  return affordable ?? BITRATE_LADDER[0]!;
}

/**
 * The sliding window of samples the queue feeds, and the bitrate it reads off them.
 *
 * A tiny class rather than a loose array so the *decision* has one home: everything that asks
 * "what bitrate now?" (the stream URL, the prefetch URL, the chip) reads this, and the only thing
 * that writes it is a finished transfer.
 */
export class ByteRate {
  private samples: ThroughputSample[] = [];

  add(sample: ThroughputSample): void {
    if (kbpsOf(sample) === null) return;
    this.samples = [...this.samples, sample].slice(-WINDOW);
  }

  /** The median of the window, or `null` when nothing has been measured — the honest number. */
  get effectiveKbps(): number | null {
    const rates = this.samples.map(kbpsOf).filter((rate): rate is number => rate !== null).sort((a, b) => a - b);
    if (rates.length === 0) return null;
    return Math.round(rates[Math.floor(rates.length / 2)]!);
  }

  get maxBitRate(): number | null {
    return chooseMaxBitRate(this.samples);
  }

  /** How many samples the decision stands on — the chip shows a number only when this is not 0. */
  get count(): number {
    return this.samples.length;
  }
}
