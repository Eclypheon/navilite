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

  const message = (text: string, className = 'lyrics-empty'): void => {
    lineNodes = [];
    times = [];
    activeIndex = -1;
    replace(body, h('p', { class: className, text }));
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
      const node = lineNodes[index];
      node.classList.add('active');
      // Keep the current line in view. Inside a scroll container this moves the container,
      // not the page behind it.
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
        message('Nothing playing.');
        return;
      }
      if (song.id === songId) return;
      songId = song.id;
      doc = null;
      loaded = false;
      lastPositionMs = 0;
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
