/**
 * Lyrics: they come from the owner's own library, and nowhere else.
 *
 * The design decision (his, 2026-10-11): a lyrics file sits **next to the audio** in his
 * music folder, and Navidrome reads it and serves it to clients. So the app asks its own
 * server for the playing track's lyrics and shows what comes back:
 *
 *   1. `getLyricsBySongId` (OpenSubsonic) — what Navidrome 0.64.2 answers from a sidecar.
 *      `.lrc` arrives with per-line timings (`synced: true`), `.txt` arrives as the same
 *      shape without them. Navidrome's own `LyricsPriority` decides which sidecar wins.
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
  /** `sidecar` = structured lyrics from the library; `blob` = a plain value it returned. */
  source: 'sidecar' | 'blob';
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
  const usable = entries.filter((entry) => (entry.line ?? []).some((line) => typeof line?.value === 'string' && line.value !== ''));
  if (usable.length === 0) return null;
  const timed = usable.filter((entry) => (entry.line ?? []).some((line) => typeof line?.start === 'number'));
  const chosen = timed[0] ?? usable[0];
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

/** A plain blob from the legacy endpoint, which may still be an LRC file's contents. */
export function fromBlob(body: string): LyricsDoc | null {
  const asLrc = parseLrc(body);
  if (asLrc.some((line) => line.timeMs !== null)) return finalize(asLrc, 'blob');
  return finalize(parsePlain(body), 'blob');
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
 * Ask the library for one track's lyrics. Never throws: "the server has nothing for this
 * track", a server that does not implement the call, and a network failure all mean the
 * same thing to the caller — no lyrics to show right now.
 */
export async function fetchLyrics(song: Song, library: LyricsSource | null): Promise<LyricsDoc | null> {
  if (!library) return null;
  try {
    const structured = await library.getLyricsBySongId(song.id);
    const doc = fromStructured(structured);
    if (doc) return doc;
  } catch {
    // Not implemented, not found, offline — try the older call below.
  }
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

function sameSong(lyrics: LegacyLyrics, song: Song): boolean {
  const norm = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
  const title = norm(lyrics.title);
  const artist = norm(lyrics.artist);
  if (title !== '' && title !== norm(song.title)) return false;
  if (artist !== '' && artist !== norm(song.artist)) return false;
  return true;
}
