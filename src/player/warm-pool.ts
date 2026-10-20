/*
 * v2.0-beta slice E3 — the warm pool, out of `engine.ts`.
 *
 * What the pool is: the claim map the engine keeps beside the bridge's own prepared slots —
 * `songId -> the exact URL it was warmed under` (v1.9.5, one prepared slot since v1.9.1). The player
 * holds those tracks buffered and silent, each under its own asset id, so when one of them is played
 * from the start there is nothing to load: the warmed asset is played and the first audio arrives
 * in a seek's time instead of after a cold fetch. The URL is kept beside the id because the stream
 * URL is the bitrate the link had been measured at when the track was warmed, and the play request
 * must carry **exactly that string** for the match to be of the same bytes (`startNative` refuses
 * to use it unless the two agree).
 *
 * What the pool is not: a transport. It holds no `AudioEngine`, no bridge and no clock — every
 * method is a fact about `(songId, url)` — which is what makes the rules here readable on their own.
 * Calling the bridge, clearing the player and telling the native side about the new order all stay
 * in the engine; this file only says what the map does.
 *
 * Insertion order is the drop order, exactly as in the bridge: see {@link trim}.
 */
export class WarmPool {
  private readonly held = new Map<string, string>();
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Is exactly this URL the one this song is warm under? (the same bytes, not another rung) */
  matches(songId: string, url: string): boolean {
    return this.held.get(songId) === url;
  }

  /**
   * The exact URL a track is warm under, or `null` when the pool does not hold it (v1.9.5).
   *
   * This is the queue's single source of truth about warmth, and it is the engine's on purpose: the
   * engine is what drops a claim a cold load invalidated, so a queue keeping its own copy could
   * believe a track was warm that the player had long since forgotten — and would then never warm it
   * again.
   */
  urlOf(songId: string): string | null {
    return this.held.get(songId) ?? null;
  }

  /** Every song the pool holds, in claim order. */
  ids(): string[] {
    return [...this.held.keys()];
  }

  get size(): number {
    return this.held.size;
  }

  /**
   * Claim a slot for a warm that is about to be attempted.
   *
   * Claimed before the call, not after: two warms for the same track (the queue's own, then a start
   * that reads it back) must not both go out, and the claim is what makes the second one a no-op.
   */
  claim(songId: string, url: string): void {
    this.held.set(songId, url);
  }

  /**
   * Give a claim back **only if it is still the one this caller made** — a warm that timed out, or
   * that the bridge refused because the listener had already moved on, must not take a newer claim
   * with it.
   */
  release(songId: string, url: string): void {
    if (this.held.get(songId) === url) this.held.delete(songId);
  }

  /** Drop a claim outright, whoever made it. */
  forget(songId: string): void {
    this.held.delete(songId);
  }

  /**
   * Keep the claims inside the pool the bridge actually has (v1.9.5).
   *
   * Three tracks are warm at once (the previous one and the next two), which is the number of slots
   * the bridge keeps that are not the audible one; a fourth claim would be a claim on a track whose
   * slot has just been reused. The oldest is dropped first, exactly as the bridge drops the oldest
   * slot.
   */
  trim(): void {
    while (this.held.size > this.capacity) {
      const oldest = this.held.keys().next();
      if (oldest.done) return;
      this.held.delete(oldest.value);
    }
  }

  /**
   * Drop the claims for tracks the queue is no longer around (v1.9.5).
   *
   * Called when a selection moves the queue: a claim for a track nobody is going to hear is a claim
   * that would make a later start use an asset the player no longer holds. The bridge's own
   * slots are not touched — they are reused by the next warm, and the pool is fixed, so dropping a
   * claim costs nothing and removes a whole class of stale state.
   */
  prune(keep: readonly string[]): void {
    for (const songId of [...this.held.keys()]) if (!keep.includes(songId)) this.held.delete(songId);
  }

  /** Throw every claim away — the queue is not going where they were warmed for. */
  clear(): void {
    this.held.clear();
  }
}
