/**
 * The lyrics panel: the playing track's lyrics, from the library, highlighted in time with
 * playback *when* the lyrics carry timings.
 *
 * Untimed text is the normal case for this library, so the panel is built for it first: a
 * comfortable, scrollable column of lines that never depends on timing. The highlight is a
 * bonus that lights up only when the server answered with a `.lrc`-style file — nothing is
 * ever gated on it.
 *
 * Three honesty rules, because the alternative is a screen that lies or spins forever:
 *
 *   - No lyrics for a track → one line: "no romaji lyrics for this track yet". Never a
 *     spinner that never ends, never invented text.
 *   - No answer at all within `PATIENCE_MS` (a slow network) → the same message. The fetch
 *     may still land later, and when it does the panel fills in.
 *   - Kanji that survived the local kana → romaji conversion is shown as it is, with one
 *     muted line saying why. It is never presented as the romaji of the song.
 */
import type { LyricsDoc } from '../api/lyrics.ts';
import type { Song } from '../api/types.ts';
import type { LyricsService } from '../lyrics/service.ts';
import { h, replace } from './dom.ts';

export interface LyricsView {
  readonly element: HTMLElement;
  /** Load (or re-load) for this track. `null` clears the panel. */
  show(song: Song | null): void;
  /** Playback position in ms; drives the highlight when the source is synced. */
  position(positionMs: number): void;
  /** What the panel is currently showing — read by the end-to-end harness. */
  state(): { songId: string | null; loaded: boolean; lines: number; message: string | null };
}

/** After this long with no answer the panel says so — but a late answer still paints. */
const PATIENCE_MS = 15000;
const EMPTY_MESSAGE = 'no romaji lyrics for this track yet';
/**
 * v1.5: how long a hand scroll wins over the auto-scroll.
 *
 * The follow used to be unconditional, so reading back over a verse was impossible — the next line
 * pulled the panel out from under the finger. A scroll the panel did not make buys this much quiet.
 */
const GRACE_MS = 4000;
/** Our own smooth scroll keeps moving the panel for about this long, and those events are ours. */
const SETTLE_MS = 700;
/** How much room the upcoming line is given before it is scrolled to. */
const LEAD_MARGIN_PX = 6;

export function createLyricsView(service: LyricsService): LyricsView {
  const host = h('div', { class: 'lyrics' });
  const body = h('div', { class: 'lyrics-body' });
  host.append(body);

  let songId: string | null = null;
  let doc: LyricsDoc | null = null;
  let lineNodes: HTMLElement[] = [];
  let times: Array<number | null> = [];
  let activeIndex = -1;
  let loaded = false;
  let lastPositionMs = 0;
  /** When the panel was last scrolled by hand (`-Infinity` until it ever is). */
  let manualScrollAt = Number.NEGATIVE_INFINITY;
  /** Scroll events before this are the tail of a smooth scroll of our own, not the reader's. */
  let autoScrollUntil = 0;

  const message = (text: string, className = 'lyrics-empty'): void => {
    lineNodes = [];
    times = [];
    activeIndex = -1;
    replace(body, h('p', { class: className, text }));
  };

  /**
   * A hand on the panel, recorded the moment it lands.
   *
   * The scroll event alone cannot tell his scroll from ours: a smooth scroll of ours keeps firing
   * scroll events for `SETTLE_MS`, and those are ignored — so a reader who grabs the panel while it is
   * still gliding has his first movement counted as ours, and the follow then pulls it straight back
   * out of his hand. A touch, a wheel or a pointer is never ours.
   */
  const takeHold = (): void => {
    manualScrollAt = performance.now();
  };
  host.addEventListener('touchstart', takeHold, { passive: true });
  host.addEventListener('wheel', takeHold, { passive: true });
  host.addEventListener('pointerdown', takeHold, { passive: true });
  host.addEventListener(
    'scroll',
    () => {
      if (performance.now() < autoScrollUntil) return;
      manualScrollAt = performance.now();
    },
    { passive: true },
  );

  /**
   * Bring the **upcoming** line into view rather than the current one.
   *
   * That is the v1.5 ask in his words: *"he wants to see the next line before the song reaches it,
   * so scroll the upcoming line into view one line early"*. The target is therefore `index + 1`,
   * clamped at both ends — the panel never scrolls past its own last line, and it never dips above
   * the first one.
   *
   * It is arithmetic on `scrollTop`, and deliberately **not** `scrollIntoView`: that walks *every*
   * scrollable ancestor, and v1.5 put these panes inside the pager's strip. Measured, the first
   * highlighted line dragged the strip 379 px sideways as well (the strip is `overflow: hidden`, so
   * it is scrollable), which is the pager showing the wrong pane — a bug with nothing to do with
   * lyrics. Nothing here touches anything but this panel.
   */
  const follow = (index: number): void => {
    const upcoming = lineNodes[Math.min(index + 1, lineNodes.length - 1)];
    const height = host.clientHeight;
    if (!upcoming || height === 0) return;
    // A scroll he just made is his: leave the panel where he put it for a few seconds.
    if (performance.now() - manualScrollAt < GRACE_MS) return;
    const hostBox = host.getBoundingClientRect();
    const box = upcoming.getBoundingClientRect();
    const top = box.top - hostBox.top + host.scrollTop;
    const bottom = top + box.height;
    let next = host.scrollTop;
    // Below the fold: bring it in with a little room to read, so it is never on the last pixel.
    if (bottom > host.scrollTop + height - LEAD_MARGIN_PX) next = bottom - height + LEAD_MARGIN_PX;
    // Above the fold — the top of the song, or a seek backwards — put it back under the top edge.
    if (top < host.scrollTop) next = top - LEAD_MARGIN_PX;
    next = Math.max(0, Math.min(next, Math.max(0, host.scrollHeight - height)));
    if (Math.abs(next - host.scrollTop) < 2) return;
    autoScrollUntil = performance.now() + SETTLE_MS;
    host.scrollTo({ top: next, behavior: 'smooth' });
  };

  const highlight = (positionMs: number): void => {
    if (!doc || !doc.synced || lineNodes.length === 0) return;
    let index = -1;
    for (let i = 0; i < times.length; i += 1) {
      const time = times[i];
      if (time !== null && time <= positionMs) index = i;
    }
    if (index === activeIndex) return;
    if (activeIndex >= 0) lineNodes[activeIndex]?.classList.remove('active');
    activeIndex = index;
    if (index >= 0) {
      lineNodes[index].classList.add('active');
      follow(index);
    }
  };

  const paint = (): void => {
    if (!doc) return;
    lineNodes = doc.lines.map((line, index) => h('p', { class: 'lyric-line', text: line.text, 'data-index': index }));
    times = doc.lines.map((line) => line.timeMs);
    activeIndex = -1;
    const parts: Array<HTMLElement | null> = [...lineNodes];
    if (!doc.fullRomaji) {
      parts.push(
        h('p', {
          class: 'lyrics-note',
          text: 'Kanji is left as it is — reading it out needs a dictionary the app does not carry.',
        }),
      );
    }
    replace(body, ...parts);
    highlight(lastPositionMs);
  };

  const load = async (song: Song): Promise<void> => {
    const answer = await Promise.race([
      service.lyricsFor(song),
      new Promise<'timeout'>((resolve) => window.setTimeout(() => resolve('timeout'), PATIENCE_MS)),
    ]);
    // The track may have changed while this was in flight.
    if (songId !== song.id) return;
    loaded = true;
    if (answer === 'timeout' || answer === null) {
      doc = null;
      message(EMPTY_MESSAGE);
      return;
    }
    doc = answer;
    paint();
  };

  return {
    element: host,
    show(song) {
      if (!song) {
        songId = null;
        doc = null;
        loaded = false;
        manualScrollAt = Number.NEGATIVE_INFINITY;
        autoScrollUntil = 0;
        message('Nothing playing.');
        return;
      }
      if (song.id === songId) return;
      songId = song.id;
      doc = null;
      loaded = false;
      lastPositionMs = 0;
      // A new song starts at the top of its own lines: the grace period and the position of the
      // previous song do not carry over.
      manualScrollAt = Number.NEGATIVE_INFINITY;
      autoScrollUntil = 0;
      host.scrollTop = 0;
      message('Looking in your library…', 'lyrics-note');
      void load(song);
    },
    position(positionMs) {
      lastPositionMs = positionMs;
      if (!loaded || !doc) return;
      highlight(positionMs);
    },
    state() {
      return {
        songId,
        loaded,
        lines: lineNodes.length,
        message: body.querySelector('.lyrics-empty')?.textContent ?? null,
      };
    },
  };
}
