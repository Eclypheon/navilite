/**
 * Lyrics: they come from the owner's own library, and nowhere else.
 *
 * The design decision (his, 2026-10-11): a lyrics file sits **next to the audio** in his
 * music folder, and the app shows what is in it. Three ways to the same file, tried in this
 * order (v1.3):
 *
 *   0. **The library's own route** (`src/api/sidecar.ts`) — `/lyrics?path=<song.path>` on the
 *      same door as the app. It serves the `.lrc`/`.txt` sidecar itself, at request time, so
 *      what is on screen is the file rather than Navidrome's opinion of it. Timed or untimed
 *      makes no difference here; untimed is the normal case either way.
 *   1. `getLyricsBySongId` (OpenSubsonic) — what Navidrome 0.64.2 answers from a sidecar.
 *      `.lrc` arrives with per-line timings (`synced: true`), `.txt` arrives as the same
 *      shape without them. Navidrome's own `LyricsPriority` decides which sidecar wins.
 *      This is the fallback when the route has nothing, or is not reachable.
 *   2. `getLyrics` (legacy Subsonic, artist + title) — a plain blob, for a server or a
 *      configuration that only implements the old call. An LRC blob in here is parsed for
 *      timings rather than shown raw.
 *
 * Nothing is fetched from a third party, nothing is committed to this repository, and
 * nothing is bundled into the app or its artifacts: the text is his, it stays on his
 * server and in the device cache (`src/storage/lyrics.ts`).
 *
 * Timing is the **exception**, not the requirement: most of his library has no timings, so
 * untimed text is the normal case and the view is built for it. When timings do exist, the
 * highlight follows playback for free.
 */
import { hasKanji, romanizeLine } from '../lyrics/romanize.ts';
import type { SidecarSource } from './sidecar.ts';
import type { LegacyLyrics, Song, StructuredLyrics } from './types.ts';

/** One lyric line. `timeMs` is null when the source has no timing for it. */
export interface LyricsLine {
  timeMs: number | null;
  text: string;
}

export interface LyricsDoc {
  lines: LyricsLine[];
  /** True only when at least one line carried a usable time. */
  synced: boolean;
  /**
   * `route` = the library's own lyric route served the sidecar file itself (v1.3);
   * `sidecar` = structured lyrics from Navidrome; `blob` = a plain value it returned.
   */
  source: 'route' | 'sidecar' | 'blob';
  /** False when the text still holds kanji, i.e. only partly romaji. */
  fullRomaji: boolean;
}

/** The slice of the Subsonic client this module needs — so tests need no HTTP. */
export interface LyricsSource {
  getLyricsBySongId(id: string): Promise<StructuredLyrics[]>;
  getLyrics(options: { artist?: string; title?: string }): Promise<LegacyLyrics | null>;
}

/** `[01:23.45]` / `[1:23]` / `[01:23:45.6]` at the head of an LRC line. */
const LRC_TAG = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;

/**
 * Parse an LRC body into timed lines. Lines without a tag keep their text and `timeMs: null`
 * only when they carry something — LRC files are full of `[ar:]` metadata that is not a lyric.
 */
export function parseLrc(body: string): LyricsLine[] {
  const lines: LyricsLine[] = [];
  for (const raw of body.split(/\r?\n/)) {
    let rest = raw.trim();
    if (rest === '') continue;
    let timeMs: number | null = null;
    let matched = true;
    while (matched) {
      matched = false;
      const tag = LRC_TAG.exec(rest);
      if (tag) {
        const minutes = Number(tag[1]);
        const seconds = Number(tag[2]);
        const fraction = tag[3] ? Number(tag[3].padEnd(3, '0')) : 0;
        timeMs = (minutes * 60 + seconds) * 1000 + fraction;
        rest = rest.slice(tag[0].length).trim();
        matched = true;
      } else if (/^\[[a-z]+:[^\]]*\]/i.test(rest)) {
        // Metadata tag (`[ar:…]`, `[offset:…]`): drop it, it is not a lyric.
        rest = rest.replace(/^\[[a-z]+:[^\]]*\]/i, '').trim();
        matched = true;
      }
    }
    if (rest === '') continue;
    lines.push({ timeMs, text: rest });
  }
  return lines;
}

/** Bare text → untimed lines. This is the shape a `.txt` sidecar produces. */
export function parsePlain(body: string): LyricsLine[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .map((text) => ({ timeMs: null, text }));
}

/**
 * OpenSubsonic's structured form, which is what Navidrome answers with. Several entries can
 * come back (one per `.lrc`/`.txt`/`.yaml` that exists, in `LyricsPriority` order), so pick
 * the most useful: a synced one if there is one, otherwise the first with text.
 */
export function fromStructured(entries: StructuredLyrics[]): LyricsDoc | null {
  const chosen = pickEntry(entries);
  if (chosen === null) return null;
  const offset = typeof chosen.offset === 'number' && Number.isFinite(chosen.offset) ? chosen.offset : 0;
  const lines: LyricsLine[] = [];
  for (const line of chosen.line ?? []) {
    const text = typeof line?.value === 'string' ? line.value : '';
    if (text === '') continue;
    const start = typeof line?.start === 'number' && Number.isFinite(line.start) ? line.start + offset : null;
    lines.push({ timeMs: start, text });
  }
  return finalize(lines, 'sidecar');
}

/**
 * The entry both readers use: the first **timed** one when there is a timed one, else the first
 * with text. Shared so that the doc on screen and the body written to the offline copy can never
 * be two different entries of the same answer.
 */
function pickEntry(entries: StructuredLyrics[]): StructuredLyrics | null {
  const usable = entries.filter((entry) => (entry.line ?? []).some((line) => typeof line?.value === 'string' && line.value !== ''));
  if (usable.length === 0) return null;
  const timed = usable.filter((entry) => (entry.line ?? []).some((line) => typeof line?.start === 'number'));
  return timed[0] ?? usable[0] ?? null;
}

/** `[mm:ss.cc]` — the one tag shape `parseLrc` reads back, so a written body round-trips. */
function lrcTag(timeMs: number): string {
  const total = Math.max(0, Math.round(timeMs));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

/**
 * A structured answer written back as **the body of a file** (v1.9.14): an LRC when the chosen
 * entry carries `start` times — so the offline copy keeps the highlight — and plain text when it
 * does not. This is what the download lane stores when the route has no sidecar for a track whose
 * words live inside the file itself: one stored format, the one `fromSidecar` already parses.
 * `null` when there is nothing to write.
 */
export function structuredToBody(entries: StructuredLyrics[]): string | null {
  const chosen = pickEntry(entries);
  if (chosen === null) return null;
  const offset = typeof chosen.offset === 'number' && Number.isFinite(chosen.offset) ? chosen.offset : 0;
  const lines: string[] = [];
  for (const line of chosen.line ?? []) {
    const text = typeof line?.value === 'string' ? line.value : '';
    if (text === '') continue;
    const start = typeof line?.start === 'number' && Number.isFinite(line.start) ? line.start + offset : null;
    lines.push(start === null ? text : `${lrcTag(start)}${text}`);
  }
  return lines.length === 0 ? null : lines.join('\n');
}

/**
 * The route's own "there is nothing here" document —
 * `{"error": "no lyrics sidecar for this track", "path": …, "tried": […]}`. It is a **404 body**.
 *
 * The predicate lives beside the parsers because it is a fact about the route's answer. It exists
 * for one reason: before v1.9.14 the native completion handler never read the HTTP status, so this
 * document was promoted as the lyric file and recorded `present`. Rows like that are still on the
 * owner's phone, so the body has to be recognised and refused everywhere it is read or written.
 * The native side carries the same two tests (`looksLikeRouteError` in `NaviliteDownloads.swift`),
 * because Swift cannot import this file.
 */
export function isRouteErrorBody(body: string): boolean {
  const head = body.trim().slice(0, 512);
  return head.startsWith('{"error"') || head.includes('no lyrics sidecar for this track');
}

/** A plain blob from the legacy endpoint, which may still be an LRC file's contents. */
export function fromBlob(body: string): LyricsDoc | null {
  return fromText(body, 'blob');
}

/**
 * The library's own route answers with the sidecar file's bytes: an `.lrc` with timings, or —
 * the normal case for this library — a plain `.txt`. Which one it is, is decided by whether
 * any line actually carries a tag; nothing is gated on timing.
 */
export function fromSidecar(body: string): LyricsDoc | null {
  return fromText(body, 'route');
}

/** A body of text with no wrapper to tell us what it is: LRC if any line is timed, else plain. */
function fromText(body: string, source: LyricsDoc['source']): LyricsDoc | null {
  const asLrc = parseLrc(body);
  if (asLrc.some((line) => line.timeMs !== null)) return finalize(asLrc, source);
  return finalize(parsePlain(body), source);
}

/**
 * One shape for every source: romanise the kana that is there, keep any kanji as it is, and
 * report whether the result is fully romaji. Sidecars that are already romaji/English pass
 * through untouched — that is the expected case, so this is a safety net, not a translation.
 */
function finalize(lines: LyricsLine[], source: LyricsDoc['source']): LyricsDoc | null {
  const out: LyricsLine[] = lines.map((line) => ({ timeMs: line.timeMs, text: romanizeLine(line.text).text }));
  if (out.length === 0) return null;
  const fullRomaji = out.every((line) => !hasKanji(line.text));
  return {
    lines: out,
    synced: out.some((line) => line.timeMs !== null),
    source,
    fullRomaji,
  };
}

/**
 * Ask the library for one track's lyrics, in the order the sources are trusted (v1.3):
 * the library's own lyric route first, then Navidrome's structured lyrics, then the legacy
 * call. Never throws: "the server has nothing for this track", a route that is not there,
 * a server that does not implement a call, and a network failure all mean the same thing to
 * the caller — no lyrics to show right now.
 */
export async function fetchLyrics(
  song: Song,
  library: LyricsSource | null,
  sidecar: SidecarSource | null = null,
): Promise<LyricsDoc | null> {
  // 1. Our own delivery route: the sidecar file itself, served straight from the library.
  if (sidecar) {
    try {
      const body = await sidecar.lyricsFor(song);
      if (body !== null) {
        const doc = fromSidecar(body);
        if (doc) return doc;
      }
    } catch {
      // `LyricsRoute` never throws; a stand-in that does is treated as "no answer from the
      // route" and the Navidrome path below still runs.
    }
  }
  if (!library) return null;
  // 2. Navidrome's structured answer (id-keyed, so it cannot pick the wrong song).
  try {
    const structured = await library.getLyricsBySongId(song.id);
    const doc = fromStructured(structured);
    if (doc) return doc;
  } catch {
    // Not implemented, not found, offline — try the older call below.
  }
  // 3. The old call, with the artist/title guard below it.
  try {
    const blob = await library.getLyrics({ artist: song.artist, title: song.title });
    if (blob === null) return null;
    // The old call matches on artist *and title*, and two songs can share both (a live cut,
    // the same track on a compilation). Another song's words are worse than none, so only
    // take the blob when the server's own match is the track we are playing.
    if (!sameSong(blob, song)) return null;
    return fromBlob(blob.value);
  } catch {
    return null;
  }
}

export function sameSong(lyrics: LegacyLyrics, song: Song): boolean {
  const norm = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
  const title = norm(lyrics.title);
  const artist = norm(lyrics.artist);
  if (title !== '' && title !== norm(song.title)) return false;
  if (artist !== '' && artist !== norm(song.artist)) return false;
  return true;
}
