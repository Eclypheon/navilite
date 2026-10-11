/**
 * v1.9.0 — what bitrate to ask the server for. v1.9.2 — decided by how long a start took.
 *
 * Subsonic streams the **original** file unless the client says otherwise: `maxBitRate` on
 * `stream` is what makes Navidrome transcode on demand, so the whole of this feature is one
 * client-side query parameter. There is nothing to change on the server and no downtime.
 *
 * Why it is needed at all: off wifi the tailnet may reach the home server through a DERP relay,
 * so the phone's link has desktop-class latency and mobile-class throughput. Pulling a lossless
 * or 320 kbps original over that is the difference between music and a stall.
 *
 * The two rules the owner asked for, in his words:
 *   - *"start modest on a slow link, raise it when throughput allows"* → the ladder below rises
 *     with the measurement and falls with it;
 *   - *"never silently cap quality"* → a cap is only ever applied when the app has measured the
 *     link, and while a cap is in force the player bar says the number (`queue.streamKbps` is
 *     what that chip reads). Nothing is capped on a fast link: `null` means the original.
 *
 * **What the measurement is changed in v1.9.2, and why.** v1.9.0 measured the link by pulling
 * half a megabyte of the next track through the web view while the current one played. Those
 * bytes are not the player's bytes (a different HTTP stack), the transfer is thrown away when
 * the track changes, and on this link it competed with the stream that was actually playing.
 * It is deleted. What the app measures now is the thing the owner judges the app by: **how long
 * a start took, from the request to the first audio**. That is one number, taken from the
 * player's own first position report (`src/player/engine.ts`), and it needs no extra request at
 * all. Three seconds of silence is a link that cannot carry this rung; two seconds is a link
 * with room for the next one up; in between, the rung stands.
 */
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

/** A start that took at least this long is a link that cannot carry the rung it just carried. */
export const SLOW_START_MS = 6000;

/** A start this quick, over and over, is a link with room for the next rung up. */
export const FAST_START_MS = 2000;

/** One past the top of the ladder: ask for nothing and the server sends the original file. */
const ORIGINAL = BITRATE_LADDER.length;

/**
 * The bitrate to ask for, from the starts this app has timed.
 *
 * A tiny class rather than a loose array so the *decision* has one home: everything that asks
 * "what bitrate now?" (the stream URL, the chip, the retry) reads this, and the only things that
 * write it are a finished start and a start that did not finish.
 */
export class ByteRate {
  /** Index into {@link BITRATE_LADDER}; {@link ORIGINAL} means "no cap — the original file". */
  private rung = BITRATE_LADDER.indexOf(STARTING_KBPS as (typeof BITRATE_LADDER)[number]);
  /** The last start's time to first audio, in ms — `null` until one has been timed. */
  private startMs: number | null = null;
  private timed = 0;

  /**
   * How long a start took, request to first audio: the one measurement this release has.
   *
   * A sample that is not a positive, finite number of milliseconds is not a measurement and is
   * ignored — the rung then stands, which is the honest answer to "nothing was learned".
   */
  noteStart(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.startMs = ms;
    this.timed += 1;
    if (ms >= SLOW_START_MS) this.rung = Math.max(0, this.rung - 1);
    else if (ms <= FAST_START_MS) this.rung = Math.min(ORIGINAL, this.rung + 1);
  }

  /**
   * One rung down, now: the retry after a start that did not start at all (v1.9.2).
   *
   * A start that never produced sound is stronger evidence than a slow one, and the retry has to
   * ask for *something different* — the same URL asking the same question is the same answer.
   */
  demote(): void {
    this.rung = Math.max(0, this.rung - 1);
  }

  /** The bitrate the next stream asks for; `null` = no cap at all, i.e. the original file. */
  get maxBitRate(): number | null {
    return this.rung >= ORIGINAL ? null : BITRATE_LADDER[this.rung]!;
  }

  /** The last start, in ms, or `null` when nothing has been timed yet — the honest number. */
  get lastStartMs(): number | null {
    return this.startMs;
  }

  /** How many starts the decision stands on. */
  get count(): number {
    return this.timed;
  }
}
