/**
 * §S1 — the resolver: `Library.streamUrl` is the one place a track's URL is decided, and it now
 * consults the offline resolver first.
 *
 *   - a complete row → a `file://` path, and `maxBitRate` is ignored (a local file is already a
 *     file; asking for a transcode of it is meaningless);
 *   - no row → the Subsonic URL, byte-for-byte the same as before this change (string equality
 *     against `client.streamUrl`);
 *   - recovery (§6 E3): a row whose file has gone still resolves to its path — the resolver is
 *     synchronous and does not touch the filesystem, so a missing file cannot throw here; the
 *     existing failure branch in the engine is what falls back to the stream.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/state/library.ts';
import { SubsonicClient } from '../src/api/subsonic.ts';
import type { Song } from '../src/api/types.ts';

const song: Song = { id: 'abc123', title: 'A track', artist: 'Someone', duration: 231 };
const client = new SubsonicClient({ serverUrl: 'https://music.example.com', username: 'u', password: 'p' });

test('a complete row resolves to a file path and ignores maxBitRate', () => {
  const library = new Library(client, (id) => (id === song.id ? 'file:///path/to/abc123.flac' : null));
  assert.equal(library.streamUrl(song, 128), 'file:///path/to/abc123.flac');
  assert.equal(library.streamUrl(song, undefined), 'file:///path/to/abc123.flac');
});

test('no row returns the unchanged Subsonic URL, byte for byte', () => {
  const library = new Library(client, () => null);
  assert.equal(library.streamUrl(song), client.streamUrl(song.id));
  // And with a bitrate cap, the cap still reaches the stream URL.
  assert.equal(library.streamUrl(song, 128), client.streamUrl(song.id, { maxBitRate: 128 }));
});

test('the default resolver is null-safe: an unhydrated index returns the stream URL, never undefined', () => {
  const library = new Library(client);
  assert.equal(typeof library.streamUrl(song), 'string');
  assert.equal(library.streamUrl(song), client.streamUrl(song.id));
});

test('a row whose file is gone still resolves to its path, without throwing', () => {
  // The resolver reports the path the index holds; the engine's failure branch owns the fallback.
  const library = new Library(client, (id) => (id === song.id ? 'file:///gone/abc123.mp3' : null));
  assert.equal(library.streamUrl(song), 'file:///gone/abc123.mp3');
});
