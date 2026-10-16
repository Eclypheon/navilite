#!/usr/bin/env node
/**
 * A mock Navidrome: the Subsonic API subset Navilite uses, plus real audio and real
 * cover art, served from *one origin* together with the built app.
 *
 * It exists for two reasons:
 *   1. `npm run dev` needs something to talk to without exposing a personal library.
 *   2. It is the test harness for the two risky parts of Navilite — the Subsonic client
 *      and the analyser. The stream endpoint returns generated PCM whose spectrum is
 *      exactly known, and the token check is real (md5(password + salt)), so a broken
 *      client or a fake visualiser cannot pass.
 *
 * It is a development tool. Nothing here ships in the app, and no credential is stored.
 *
 *   node tools/mock-subsonic.mjs [--port 4533] [--dist dist] [--user U] [--password P]
 *                              [--stress] [--lyrics-plain] [--no-lyrics] [--no-cors]
 *
 * `--port 0` asks the OS for a free port and prints `navilite-mock-port <n>` when it is listening;
 * that is how `test/support/mock-fixture.ts` starts it, so no two test files can be handed the same
 * port (docs/verification.md §21).
 *
 * `--stress` adds one artist, album, three tracks and two playlists whose names are long,
 * Japanese and unbroken — the shape the owner's own library is full of, and the worst case
 * for a 393 px layout. `tools/layout-audit.mjs` runs against it.
 *
 * Debug endpoints (not part of Subsonic, used by the end-to-end check):
 *   GET  /lyrics?path=<rel>  → the library's own lyric route, as it exists on the box (v1.3):
 *                              the sidecar file itself, timed or untimed. Also /lyrics/health and
 *                              /lyrics/index.json. Every request is recorded in `state.lyrics`
 *                              with the endpoint that served it.
 *   GET  /__state   → requests seen, scrobbles, starred ids, saved play queue, the current API delay
 *   POST /__reset   → clear that state (and the delay)
 *   GET  /__slow?ms=N → make every **API answer** late by N ms (0 clears it — v1.9.21)
 *   POST /__report  → a layout-probe report posted from inside the page (see
 *                     tools/device-probe.mjs — the iOS Simulator run has no CDP to attach to)
 *   GET  /__reports → those reports, for the harness on the host
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from './png.mjs';
import { coverPixels, renderWav, TRACK_PARTIALS, trackDurationSeconds } from './audio.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token || !token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    args.set(token.replace(/^--/, ''), next);
    i += 1;
  } else {
    args.set(token.replace(/^--/, ''), 'true');
  }
}
const PORT = Number(args.get('port') ?? 4533);
const DIST = resolve(args.get('dist') ?? join(here, '..', 'dist'));
const USER = args.get('user') ?? 'navidrome';
const PASSWORD = args.get('password') ?? 'navidrome';
const NO_CORS = args.has('no-cors');
const NO_CORS_STREAM = args.has('no-cors-stream');
/**
 * `--no-lyrics`: the library has no lyrics files at all — every lyrics call answers 70
 * ("data not found"), which is what a track with no sidecar gets from Navidrome.
 */
const NO_LYRICS = args.has('no-lyrics');
/**
 * `--lyrics-plain`: sidecars without timings, i.e. `.txt`. This is the *normal* case for the
 * owner's library, so the mock can produce it; the timed `.lrc` path is the default.
 */
const LYRICS_PLAIN = args.has('lyrics-plain');
/**
 * `--stress`: one more artist whose every name is the shape the owner's library is actually
 * full of — long, Japanese, and with no spaces to break at — plus a long playlist name and a
 * long lyric line. v1.1's layout harness ran against "Track 1 · 110/330/1320 Hz" and a
 * playlist called "Late night", so nothing in it could ever push a layout wide, and the
 * owner's iPhone disagreed with the harness. This fixture is what makes the 393 px audit
 * reproduce his conditions. Opt-in: the default fixture stays exactly as documented.
 */
const STRESS = args.has('stress');
const STRESS_ARTIST_ID = 'artist-ja';
const STRESS_ALBUM_ID = 'album-ja-1';

/**
 * How late every **API** answer is (v1.9.21), set by `GET /__slow?ms=N`.
 *
 * The app's own request timeout is 20 s, so against this mock every view's answer has always landed
 * in a millisecond — and a view that paints *after* its await can only be caught painting over the
 * wrong screen if the answer is late enough for the owner to have navigated away in the meantime.
 * That is the one thing this knob exists for: `tools/offline-check.mjs` navigates away from a view
 * whose request this holds open, then reads the screen it navigated to.
 *
 * Only `/rest/*` is delayed. Static files, `/offline-art/`, the lyrics sidecars and these debug
 * endpoints are *not*: the harness has to be able to read `/__state` and boot the app while an
 * answer is held, which is exactly the difference between "the library is slow" and "the page is
 * slow". Zero is the default, so nothing else in this repository's harnesses is affected by it, and
 * `/__reset` puts it back to zero.
 */
let apiDelayMs = 0;

/* ------------------------------------------------------------------ library */

const ARTIST_NAMES = ['Alien Lab', 'Boot Sector', 'Comet Tail', 'Deep Field'];
const ALBUM_SUFFIXES = ['Transmission', 'Quiet Hours', 'Telemetry'];

const state = {
  requests: [],
  scrobbles: [],
  starred: new Set(),
  playQueue: null,
  ratings: new Map(),
  lyrics: [],
  /** Layout-probe reports from a real device/simulator run (see tools/device-probe.mjs). */
  reports: [],
  playlists: [
    { id: 'pl-1', name: 'Late night', songIds: [], created: '2026-01-01T00:00:00Z', changed: '2026-01-01T00:00:00Z' },
  ],
  nextPlaylistId: 2,
};

const artists = [];
const albums = [];
const songs = [];
let trackCounter = 0;

for (const [artistIndex, artistName] of ARTIST_NAMES.entries()) {
  const artist = { id: `artist-${artistIndex + 1}`, name: artistName, albumCount: 2 };
  artists.push(artist);
  for (let albumIndex = 0; albumIndex < 2; albumIndex += 1) {
    const albumId = `album-${artistIndex + 1}-${albumIndex + 1}`;
    const album = {
      id: albumId,
      name: `${artistName} — ${ALBUM_SUFFIXES[(artistIndex + albumIndex) % ALBUM_SUFFIXES.length]}`,
      artist: artistName,
      artistId: artist.id,
      coverArt: `cover-${albumId}`,
      year: 2019 + albumIndex,
      songCount: 4,
      duration: 0,
      songs: [],
    };
    for (let songIndex = 0; songIndex < 4; songIndex += 1) {
      const audioIndex = trackCounter % 4;
      trackCounter += 1;
      const duration = trackDurationSeconds(audioIndex);
      const song = {
        id: `${albumId}-track-${songIndex + 1}`,
        title: `Track ${songIndex + 1} · ${TRACK_PARTIALS[audioIndex].join('/')} Hz`,
        artist: artistName,
        artistId: artist.id,
        album: album.name,
        albumId,
        coverArt: album.coverArt,
        duration,
        track: songIndex + 1,
        suffix: 'wav',
        contentType: 'audio/wav',
        bitRate: 1411,
        audioIndex,
      };
      album.songs.push(song);
      songs.push(song);
      album.duration += duration;
    }
    albums.push(album);
  }
}

/*
 * The stress artist. Names are deliberately the worst case a layout can meet: CJK has no
 * spaces, so a line can only be made to fit by wrapping *between* characters (CSS
 * `overflow-wrap: anywhere` or `word-break: break-word`) or by clipping (ellipsis); a Latin
 * name with no spaces at all tests the same thing without the font fallback.
 */
if (STRESS) {
  const artist = {
    id: STRESS_ARTIST_ID,
    name: '星野源と仲間たちと深夜のドライブ音楽団',
    albumCount: 1,
  };
  artists.push(artist);
  const stressAlbum = {
    id: STRESS_ALBUM_ID,
    name: '夜のあいだにきみと話したかったことのすべて',
    artist: artist.name,
    artistId: artist.id,
    coverArt: `cover-${STRESS_ALBUM_ID}`,
    year: 2026,
    songCount: 3,
    duration: 0,
    songs: [],
  };
  const stressTitles = [
    '第一章　夜のなかをあるいていくきみのこえがきこえる',
    '第二章　ほしがまたたくそらのしたでとおいくもをこえて',
    'InterludeWithoutAnySpacesAtAllInTheTitleWhatsoeverForTheLayoutToBreak',
  ];
  for (const [index, title] of stressTitles.entries()) {
    const audioIndex = trackCounter % 4;
    trackCounter += 1;
    const duration = trackDurationSeconds(audioIndex);
    const song = {
      id: `${STRESS_ALBUM_ID}-track-${index + 1}`,
      title,
      artist: artist.name,
      artistId: artist.id,
      album: stressAlbum.name,
      albumId: STRESS_ALBUM_ID,
      coverArt: stressAlbum.coverArt,
      duration,
      track: index + 1,
      suffix: 'wav',
      contentType: 'audio/wav',
      bitRate: 1411,
      audioIndex,
    };
    stressAlbum.songs.push(song);
    songs.push(song);
    stressAlbum.duration += duration;
  }
  albums.push(stressAlbum);
  state.playlists.push({
    id: 'pl-stress-ja',
    name: '深夜のドライブ用プレイリスト（2026年秋・改訂第3版・これでもかというほど長い名前）',
    songIds: stressAlbum.songs.map((song) => song.id),
    created: '2026-01-01T00:00:00Z',
    changed: '2026-01-01T00:00:00Z',
  });
  state.playlists.push({
    id: 'pl-stress-latin',
    name: 'LateNightDrivingPlaylistWithNoSpacesAtAllBecauseSomeoneNamedItLikeThis-2026-revision-3-final-final',
    songIds: stressAlbum.songs.map((song) => song.id),
    created: '2026-01-01T00:00:00Z',
    changed: '2026-01-01T00:00:00Z',
  });
  /*
   * v1.4: a playlist long enough to *scroll*. The scroll-containment check has to open a list,
   * scroll it, and then prove the gesture could not reach it from the now-playing screen — and
   * the other stress playlists hold three tracks, i.e. less than one screen, so a scroll against
   * them would prove nothing. This is every track in the library (35), which is roughly 2,000 px
   * of rows at 393 px wide: two and a half screens. Opt-in with `--stress`, like its neighbours,
   * so the default fixture stays exactly as documented.
   */
  state.playlists.push({
    id: 'pl-stress-long',
    name: '夜のドライブのためにえらんだ長いプレイリスト（第一集・全三十五曲・これでもかというほど長い名前）',
    songIds: songs.map((song) => song.id),
    created: '2026-01-01T00:00:00Z',
    changed: '2026-01-01T00:00:00Z',
  });
}

const wavCache = new Map();
function wavFor(song) {
  if (!wavCache.has(song.audioIndex)) wavCache.set(song.audioIndex, renderWav(song.audioIndex));
  return wavCache.get(song.audioIndex);
}

/**
 * What Navidrome reports as a song's `path`: the audio file's location **relative to the music
 * root**. v1.3's lyrics route is asked with exactly this string (`/lyrics?path=…`), so the mock
 * has to have one — and it has to be the real, awkward shape: a Japanese artist and album, and a
 * track title with a `·` and a `/` in it (the `/` is not a directory here, which is why the
 * client percent-encodes the whole path).
 */
function libraryPath(song) {
  const title = String(song.title).replace(/[/\\]/g, '-');
  return `${song.artist}/${song.album}/${String(song.track ?? 1).padStart(2, '0')} - ${title}.wav`;
}

for (const song of songs) song.path = libraryPath(song);

const coverCache = new Map();
function coverFor(seed, size) {
  const key = `${seed}:${size}`;
  if (!coverCache.has(key)) coverCache.set(key, encodePng(coverPixels(seed, size), size));
  return coverCache.get(key);
}

const albumOfSong = (song) => albums.find((album) => album.id === song.albumId);

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

function send(response, status, body, headers = {}, options = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const withCors = options.cors ?? !NO_CORS;
  response.writeHead(status, {
    'content-type': typeof payload === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    // `--no-cors` reproduces the hostile case the research warned about: no
    // Access-Control-Allow-Origin anywhere, where fetch fails outright.
    // `--no-cors-stream` narrows it to /rest/stream, which is the realistic one: the
    // other endpoints answer CORS but the stream endpoint is version/config-dependent,
    // so playback has to survive a tainted stream and the analyser has to say so.
    ...(withCors
      ? {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'X-Content-Duration, X-Total-Count, X-Nd-Authorization',
          vary: 'Origin',
        }
      : {}),
    ...headers,
  });
  response.end(payload);
}

function ok(response, payload, headers = {}) {
  send(
    response,
    200,
    {
      'subsonic-response': {
        status: 'ok',
        version: '1.16.1',
        type: 'navidrome-mock',
        serverVersion: '0.64.2-mock',
        openSubsonic: true,
        ...payload,
      },
    },
    { 'content-type': 'application/json; charset=utf-8', ...headers },
  );
}

function fail(response, code, message, status = 200) {
  send(
    response,
    status,
    { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } },
    { 'content-type': 'application/json; charset=utf-8' },
  );
}

function songPayload(song) {
  const { audioIndex, ...rest } = song;
  void audioIndex;
  // The exact byte length of the original file, so the offline size estimate (§4) is exact.
  return { ...rest, size: wavFor(song).length, starred: state.starred.has(song.id) ? '2026-01-01T00:00:00Z' : undefined };
}

function albumPayload(album) {
  const { songs: _songs, ...rest } = album;
  void _songs;
  return { ...rest, starred: state.starred.has(album.id) ? '2026-01-01T00:00:00Z' : undefined };
}

/** The real Subsonic token check: t = md5(password + s). */
function authorized(params) {
  const { u, t, s, p } = params;
  if (u !== USER) return false;
  if (p) return p === PASSWORD; // legacy plaintext, accepted for completeness
  if (!t || !s) return false;
  return createHash('md5').update(PASSWORD + s).digest('hex') === t;
}

/* -------------------------------------------------------------------- API */

function handleRest(response, method, params, url) {
  if (method !== 'ping' && !authorized(params)) {
    fail(response, 40, 'Wrong username or password');
    return;
  }

  switch (method) {
    case 'ping':
      if (!authorized(params)) {
        fail(response, 40, 'Wrong username or password');
        return;
      }
      ok(response, {});
      return;

    case 'getArtists': {
      const index = artists.map((artist) => ({ name: artist.name[0], artist: [artist] }));
      ok(response, { artists: { ignoredArticles: 'The El La Los Las Le Les', index } });
      return;
    }

    case 'getArtist': {
      const artist = artists.find((item) => item.id === params.id);
      if (!artist) return fail(response, 70, 'Artist not found');
      ok(response, {
        artist: { ...artist, album: albums.filter((album) => album.artistId === artist.id).map(albumPayload) },
      });
      return;
    }

    case 'getAlbum': {
      const album = albums.find((item) => item.id === params.id);
      if (!album) return fail(response, 70, 'Album not found');
      ok(response, { album: { ...albumPayload(album), song: album.songs.map(songPayload) } });
      return;
    }

    case 'getAlbumList2': {
      const type = params.type ?? 'alphabeticalByName';
      const size = Number(params.size ?? 50);
      const offset = Number(params.offset ?? 0);
      let list = [...albums];
      if (type === 'starred') list = list.filter((album) => state.starred.has(album.id));
      if (type === 'random') list = list.sort(() => Math.random() - 0.5);
      if (type === 'newest' || type === 'alphabeticalByName') list.sort((a, b) => a.name.localeCompare(b.name));
      if (type === 'newest') list.sort((a, b) => b.year - a.year);
      ok(response, { albumList2: { album: list.slice(offset, offset + size).map(albumPayload) } });
      return;
    }

    case 'getSong': {
      const song = songs.find((item) => item.id === params.id);
      if (!song) return fail(response, 70, 'Song not found');
      ok(response, { song: songPayload(song) });
      return;
    }

    case 'search3': {
      const query = (params.query ?? '').toLowerCase();
      ok(response, {
        searchResult3: {
          artist: artists.filter((artist) => artist.name.toLowerCase().includes(query)),
          album: albums.filter((album) => album.name.toLowerCase().includes(query)).map(albumPayload),
          song: songs.filter((song) => song.title.toLowerCase().includes(query)).map(songPayload),
        },
      });
      return;
    }

    case 'getStarred2':
      ok(response, {
        starred2: {
          song: songs.filter((song) => state.starred.has(song.id)).map(songPayload),
          album: albums.filter((album) => state.starred.has(album.id)).map(albumPayload),
          artist: artists.filter((artist) => state.starred.has(artist.id)),
        },
      });
      return;

    case 'star':
    case 'unstar': {
      const raw = params.id ?? params.albumId ?? params.artistId;
      const ids = String(raw ?? '').split(',').filter(Boolean);
      for (const id of ids) {
        if (method === 'star') state.starred.add(id);
        else state.starred.delete(id);
      }
      ok(response, {});
      return;
    }

    case 'setRating':
      state.ratings.set(params.id, Number(params.rating ?? 0));
      ok(response, {});
      return;

    case 'scrobble': {
      const ids = String(params.id ?? '').split(',').filter(Boolean);
      for (const id of ids) {
        state.scrobbles.push({
          id,
          submission: params.submission !== 'false' && params.submission !== false,
          time: Number(params.time ?? Date.now()),
          at: new Date().toISOString(),
        });
      }
      ok(response, {});
      return;
    }

    case 'getNowPlaying':
      ok(response, {
        nowPlaying: {
          entry: state.scrobbles
            .filter((entry) => entry.submission === false)
            .slice(-3)
            .map((entry) => {
              const song = songs.find((item) => item.id === entry.id);
              return { ...(song ? songPayload(song) : { id: entry.id }), username: USER, minutesAgo: 0 };
            }),
        },
      });
      return;

    case 'savePlayQueue': {
      const ids = String(params.id ?? '').split(',').filter(Boolean);
      state.playQueue = { entry: ids, current: params.current ?? ids[0], position: Number(params.position ?? 0) };
      ok(response, {});
      return;
    }

    case 'getPlayQueue': {
      if (!state.playQueue) {
        ok(response, {});
        return;
      }
      ok(response, {
        playQueue: {
          entry: state.playQueue.entry.map((id) => songs.find((song) => song.id === id)).filter(Boolean).map(songPayload),
          current: state.playQueue.current,
          position: state.playQueue.position,
        },
      });
      return;
    }

    case 'getLyricsBySongId': {
      serveLyricsBySongId(response, params);
      return;
    }

    case 'getLyrics': {
      serveLegacyLyrics(response, params);
      return;
    }

    case 'getPlaylists':
      ok(response, {
        playlists: {
          playlist: state.playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            songCount: playlist.songIds.length,
            duration: playlist.songIds.reduce((total, id) => total + (songs.find((s) => s.id === id)?.duration ?? 0), 0),
            created: playlist.created,
            changed: playlist.changed,
            owner: USER,
            coverArt: playlist.songIds[0] ? songs.find((s) => s.id === playlist.songIds[0])?.coverArt : undefined,
          })),
        },
      });
      return;

    case 'getPlaylist': {
      const playlist = state.playlists.find((item) => item.id === params.id);
      if (!playlist) return fail(response, 70, 'Playlist not found');
      const entries = playlist.songIds.map((id) => songs.find((song) => song.id === id)).filter(Boolean);
      ok(response, {
        playlist: {
          id: playlist.id,
          name: playlist.name,
          songCount: entries.length,
          duration: entries.reduce((total, song) => total + song.duration, 0),
          owner: USER,
          created: playlist.created,
          changed: playlist.changed,
          entry: entries.map(songPayload),
        },
      });
      return;
    }

    case 'createPlaylist': {
      const id = `pl-${state.nextPlaylistId}`;
      state.nextPlaylistId += 1;
      const songIds = String(params.songId ?? '').split(',').filter(Boolean);
      state.playlists.push({ id, name: params.name ?? `Playlist ${id}`, songIds, created: new Date().toISOString(), changed: new Date().toISOString() });
      ok(response, {});
      return;
    }

    case 'updatePlaylist': {
      const playlist = state.playlists.find((item) => item.id === params.playlistId);
      if (!playlist) return fail(response, 70, 'Playlist not found');
      if (params.name) playlist.name = params.name;
      if (params.songIdToAdd) playlist.songIds.push(...String(params.songIdToAdd).split(',').filter(Boolean));
      if (params.songIndexToRemove !== undefined) {
        for (const index of String(params.songIndexToRemove)
          .split(',')
          .map(Number)
          .sort((a, b) => b - a)) {
          playlist.songIds.splice(index, 1);
        }
      }
      playlist.changed = new Date().toISOString();
      ok(response, {});
      return;
    }

    case 'deletePlaylist':
      state.playlists = state.playlists.filter((item) => item.id !== params.id);
      ok(response, {});
      return;

    case 'getCoverArt': {
      const size = Math.min(1024, Math.max(64, Number(params.size ?? 256)));
      const seed = String(params.id ?? 'x')
        .split('')
        .reduce((total, char) => (total * 31 + char.charCodeAt(0)) % 997, 7);
      const png = coverFor(seed, size);
      send(response, 200, png, { 'content-type': 'image/png', 'cache-control': 'public, max-age=60' });
      return;
    }

    case 'stream': {
      const song = songs.find((item) => item.id === params.id);
      if (!song) return fail(response, 70, 'Song not found');
      const wav = wavFor(song);
      const range = response.req.headers.range;
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : wav.length - 1;
        const slice = wav.subarray(start, end + 1);
        send(response, 206, slice, {
          'content-type': 'audio/wav',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${wav.length}`,
          'content-length': String(slice.length),
          'x-content-duration': String(song.duration),
        }, { cors: !NO_CORS_STREAM });
        return;
      }
      send(response, 200, wav, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(wav.length),
        'x-content-duration': String(song.duration),
      }, { cors: !NO_CORS_STREAM });
      return;
    }

    case 'download': {
      // v1.9.12: the original, untranscoded file with an exact Content-Length, so the offline
      // size estimate and the byte-count check are honest.
      const song = songs.find((item) => item.id === params.id);
      if (!song) return fail(response, 70, 'Song not found');
      const wav = wavFor(song);
      send(response, 200, wav, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(wav.length),
        'x-content-duration': String(song.duration),
      });
      return;
    }

    default:
      void url;
      fail(response, 70, `the mock does not implement ${method}`);
  }
}

/* ------------------------------------------------------------------ static */

function serveStatic(response, urlPath) {
  const safe = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  let candidate = join(DIST, safe);
  if (!candidate.startsWith(DIST)) candidate = join(DIST, 'index.html');
  const missing = !existsSync(candidate) || statSync(candidate).isDirectory();
  if (missing) {
    // SPA fallback for routes; a missing *asset* is a genuine 404 so the browser
    // does not silently parse HTML as JavaScript.
    if (extname(candidate) && extname(candidate) !== '.html') {
      send(response, 404, `mock server: no ${safe} in ${DIST}`);
      return;
    }
    candidate = join(DIST, 'index.html');
  }
  if (!existsSync(candidate)) {
    send(response, 404, `mock server: ${DIST}/index.html not found — run \`npm run build\` first`);
    return;
  }
  const body = readFileSync(candidate);
  send(response, 200, body, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
}

/* ------------------------------------------------- sidecar lyrics (mock) */

/**
 * Lyrics as the *library* serves them, which is the only source the app has.
 *
 * On the real box these come from a file next to the audio (`.lrc`, `.txt`, …) that Navidrome
 * reads and answers `getLyricsBySongId` from; Navi owns writing those files. Here the mock
 * stands in for the server so the app's whole path — request, parse, romaji, timed highlight —
 * can be exercised without anyone's copyrighted text: **these lines are invented, written in
 * this file, and they ship nowhere.**
 *
 * Only the first album has sidecars, mirroring "a pilot sidecar is being written on one
 * album": every other track answers 70, i.e. "no lyrics for this track yet", so a run of the
 * mock covers both the answered and the unanswered case.
 */
const PILOT_ALBUM_ID = 'album-1-1';

const LYRIC_LINES = [
  '夜のなかを あるいていく',
  'きみのこえが きこえる',
  'ほしが またたく そらのした',
  'とおいくもを こえて',
  'あしたへ むかう みち',
  'うたおう なんどでも',
];

/** What a romaji sidecar with timings looks like once the server has parsed it (`.lrc`). */
function timedSidecar(song) {
  const total = LYRIC_LINES.length;
  const durationMs = Math.max(1, song.duration) * 1000;
  return LYRIC_LINES.map((value, index) => ({
    start: Math.round((index * durationMs) / total),
    value,
  }));
}

/** What an untimed sidecar looks like (`.txt`): same shape, no `start` on any line. */
function plainSidecar() {
  return LYRIC_LINES.map((value) => ({ value }));
}

/** `--stress`: long, unbroken Japanese lines, the worst case for a 393 px lyric column. */
const STRESS_LYRIC_LINES = [
  '夜のあいだにきみと話したかったことのすべてをここに書いておくよ',
  'ほしがまたたくそらのしたでとおいくもをこえてであるいていくきみのこえがきこえる',
  'あしたへむかうみちのうえでなんどでもうたおうとおもっていたけれど',
  'でんしゃのまどからみえるけしきはいつもとおなじはずなのに',
  'きみのいないまちのひかりはどこかすこしだけいろがちがってみえた',
  'それでもぼくらはあるいていくのだろうなにもわからないまま',
  'よあけまえのそらいちばんくらいじかんにきみはなんといっただろう',
  'おぼえていないことだけがたしかにここにあったきろくになる',
  'かぜがふくたびにきこえるおとをしんじていたいとおもった',
  'またあしたここでとまたあしたここでとくりかえしていた',
  'うたがおわってもきみのこえだけがのこっているようなきがした',
  'だからぼくはもういちどさいしょのひかりのほうへあるいていく',
];

/**
 * How many times those lines repeat in the stress album's sidecar.
 *
 * Twelve lines fit a phone's lyric panel whole, which makes a lyric *scroll* untestable: with
 * nothing to scroll, "it followed the song" and "it left your scroll alone" are both vacuously true.
 * Real songs run to dozens of lines, so the stress sidecar does too — three verses, thirty-six lines,
 * which is a scroll on any phone.
 */
const STRESS_LYRIC_REPEATS = 3;

/** The stress album's sidecar: the lines above, repeated. */
const STRESS_SIDECAR_LINES = Array.from({ length: STRESS_LYRIC_REPEATS }, () => STRESS_LYRIC_LINES).flat();

/** The lyrics this mock's library holds for a track — or nothing at all. */
function lyricsFor(song) {
  if (!song || NO_LYRICS) return null;
  if (STRESS && song.albumId === STRESS_ALBUM_ID) {
    // A long, unbroken Japanese line: the shape a lyric panel has to lay out on a phone. Repeated,
    // because a sidecar that fits the panel whole cannot exercise the *scroll* the panel does.
    return STRESS_SIDECAR_LINES.map((value, index) =>
      LYRICS_PLAIN ? { value } : { start: Math.round((index * song.duration * 1000) / STRESS_SIDECAR_LINES.length), value },
    );
  }
  if (song.albumId !== PILOT_ALBUM_ID) return null;
  return LYRICS_PLAIN ? plainSidecar() : timedSidecar(song);
}

function serveLyricsBySongId(response, params) {
  const song = songs.find((item) => item.id === params.id);
  const line = lyricsFor(song);
  state.lyrics.push({ endpoint: 'getLyricsBySongId', id: params.id ?? null, at: new Date().toISOString(), served: line !== null });
  if (!line) {
    // What Navidrome answers for a track whose folder has no lyrics file.
    fail(response, 70, 'Lyrics not found');
    return;
  }
  ok(response, {
    lyricsList: {
      structuredLyrics: [
        {
          displayArtist: song.artist,
          displayTitle: song.title,
          lang: 'jpn',
          synced: !LYRICS_PLAIN,
          offset: 0,
          line,
        },
      ],
    },
  });
}

function serveLegacyLyrics(response, params) {
  const title = params.title ?? '';
  const artist = params.artist ?? '';
  // The old call has no song id: it matches on artist and title. In this fixture two tracks in
  // different albums share both, so the lookup is genuinely ambiguous — answer 70 rather than
  // guess which one was meant. (The app guards the same way: a blob whose own title/artist do
  // not match the playing track is discarded, because another song's words are worse than
  // none. The id-keyed call above has no such ambiguity, which is why it is tried first.)
  const matches = songs.filter((item) => item.title === title && (!artist || item.artist === artist));
  const song = matches.length === 1 ? matches[0] : undefined;
  const line = lyricsFor(song);
  state.lyrics.push({ endpoint: 'getLyrics', title, artist, at: new Date().toISOString(), served: line !== null });
  if (!line) {
    fail(response, 70, 'Lyrics not found');
    return;
  }
  // The old call has no timings: a flat blob, exactly like a `.txt` file's contents.
  const value = line.map((entry) => entry.value).join('\n');
  ok(response, { lyrics: { artist: song.artist, title: song.title, value } });
}

/* --------------------------------------------------- our lyric route (mock) */

/**
 * The library's own lyric route, as it exists on the box (kanban t_766e7aa5) and as
 * `src/api/sidecar.ts` asks for it: `GET /lyrics?path=<track path relative to the music root>`
 * (audio extension optional), answering with **the sidecar file itself** — a timed `.lrc` by
 * default, a `.txt` under `--lyrics-plain`, which is the normal case in the real corpus.
 *
 * Same refusal codes as the real service, because the app is expected to treat all of them the
 * same way: 404 no sidecar, 400 a path that tries to leave the music root, 405 not GET/HEAD.
 *
 * Every request is recorded in `state.lyrics` as `endpoint: 'sidecar'`, so a run of
 * `tools/lyrics-e2e.mjs` can show *which* source the app used for a track, not just what it
 * rendered.
 */
const AUDIO_EXT = '.wav';
const SIDECAR_EXTS = ['.lrc', '.txt'];

/** `[mm:ss.xx]` — what a timed sidecar on disk looks like. */
function lrcStamp(ms) {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const hundredths = Math.floor((total % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}]`;
}

/** The sidecar file's bytes for a track, or null when it has no lyrics file. */
function sidecarFile(song) {
  const line = lyricsFor(song);
  if (!line) return null;
  if (LYRICS_PLAIN) return { ext: '.txt', body: line.map((entry) => entry.value).join('\n') + '\n' };
  return { ext: '.lrc', body: line.map((entry) => `${lrcStamp(entry.start)}${entry.value}`).join('\n') + '\n' };
}

/** The key the route resolves: the track's path with the audio extension taken off. */
function sidecarKey(song) {
  return libraryPath(song).replace(/\.wav$/, '');
}

function serveLyricsRoute(response, url, headOnly = false) {
  const raw = url.pathname.replace(/^\/lyrics\/?/, '');
  const query = url.searchParams.get('path');
  const requested = (raw === '' ? query : decodeURIComponent(raw)) ?? '';
  const decoded = requested.trim();
  const json = (status, payload) =>
    send(response, status, payload, { 'content-type': 'application/json; charset=utf-8' });

  if (decoded === 'health') {
    const withSidecars = songs.filter((song) => lyricsFor(song) !== null);
    send(
      response,
      200,
      {
        status: 'ok',
        version: '1.1-mock',
        root: '/music',
        sidecars: withSidecars.length,
        timed: LYRICS_PLAIN ? 0 : withSidecars.length,
        plain: LYRICS_PLAIN ? withSidecars.length : 0,
        audio_files: songs.length,
        index_age_s: 0,
        now: Math.floor(Date.now() / 1000),
      },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    return;
  }
  if (decoded === 'index.json' || decoded === 'index') {
    const tracks = {};
    for (const song of songs) {
      const file = sidecarFile(song);
      if (!file) continue;
      const key = sidecarKey(song);
      tracks[key] = {
        key,
        sidecar: key + file.ext,
        ext: file.ext,
        format: file.ext === '.lrc' ? 'timed' : 'plain',
        timed: file.ext === '.lrc',
        bytes: Buffer.byteLength(file.body),
        url: `/lyrics?path=${encodeURIComponent(key)}`,
      };
    }
    send(response, 200, { generated: Math.floor(Date.now() / 1000), root: '/music', count: Object.keys(tracks).length, tracks }, {
      'content-type': 'application/json; charset=utf-8',
    });
    return;
  }

  const rejected =
    decoded === ''
      ? 'missing path'
      : /\x00/.test(decoded)
        ? 'nul byte in path'
        : decoded.startsWith('/')
          ? 'absolute paths are not served'
          : decoded.split('/').some((part) => part === '' || part === '.' || part === '..')
            ? 'path component is not allowed'
            : null;
  if (rejected) {
    json(400, { error: rejected === 'missing path' ? 'missing path' : 'rejected path', detail: rejected, path: decoded });
    return;
  }

  const bare = SIDECAR_EXTS.some((ext) => decoded.toLowerCase().endsWith(ext))
    ? decoded.slice(0, -4)
    : decoded.toLowerCase().endsWith(AUDIO_EXT)
      ? decoded.slice(0, -AUDIO_EXT.length)
      : decoded;
  const song = songs.find((item) => sidecarKey(item) === bare);
  const file = song ? sidecarFile(song) : null;
  state.lyrics.push({
    endpoint: 'sidecar',
    path: decoded,
    trackId: song?.id ?? null,
    served: file !== null,
    at: new Date().toISOString(),
  });
  if (!file) {
    json(404, { error: 'no lyrics sidecar for this track', path: decoded, tried: [`${bare}.lrc`, `${bare}.txt`] });
    return;
  }
  const body = Buffer.from(file.body, 'utf8');
  send(
    response,
    200,
    headOnly ? '' : body,
    {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'x-lyrics-format': file.ext.slice(1),
      'x-lyrics-track': encodeURIComponent(sidecarKey(song) + file.ext),
      'x-lyrics-bytes': String(body.length),
      'content-length': String(body.length),
    },
  );
}

/* ------------------------------------------------------------------- server */

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (path === '/__state') {
    send(
      response,
      200,
      {
        user: USER,
        requests: state.requests,
        scrobbles: state.scrobbles,
        starred: [...state.starred],
        playQueue: state.playQueue,
        lyrics: state.lyrics,
        playlists: state.playlists,
        // Read back rather than asserted from the harness's own variable: "the delay is on" is a
        // fact about the server, and a harness that set a knob nothing honours must see that.
        slowMs: apiDelayMs,
      },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    return;
  }
  if (path === '/__slow') {
    /*
     * v1.9.21 — hold every API answer for `ms` milliseconds. See `apiDelayMs` above for why this
     * exists; `/__reset` clears it, so a run that dies half-way still leaves the mock honest.
     */
    const requested = Number(url.searchParams.get('ms') ?? 0);
    apiDelayMs = Number.isFinite(requested) && requested > 0 ? Math.min(Math.round(requested), 30_000) : 0;
    send(response, 200, { slowMs: apiDelayMs }, { 'content-type': 'application/json; charset=utf-8' });
    return;
  }
  if (path === '/__reset') {
    state.requests = [];
    state.scrobbles = [];
    state.lyrics = [];
    /*
     * The header promises "clear that state", and `/__state` lists the saved play queue and the
     * starred ids among it. Both live for the life of this process, so without these two lines a
     * harness run inherits the *previous* run's queue: the app restores it on boot (v1.6's
     * exact-resume, see src/ui/app.ts `restorePlayQueue`) and comes up already playing a track.
     */
    state.starred.clear();
    state.playQueue = null;
    // …and the API delay (v1.9.21): "clear that state" is what a run starts with, and a delay left
    // on would make the next run's numbers mean something else.
    apiDelayMs = 0;
    send(response, 200, { reset: true }, { 'content-type': 'application/json; charset=utf-8' });
    return;
  }

  /*
   * The layout probe's way home. A phone (or the iOS Simulator) runs the audit inside the
   * page and cannot be attached to a debugger from here, so it posts its measurements back
   * to the origin it loaded the app from and this server holds them until the harness on the
   * host asks. Bodies are capped: this is a measurement channel, not an upload endpoint.
   */
  if (path === '/__reports') {
    send(response, 200, { count: state.reports.length, reports: state.reports }, { 'content-type': 'application/json; charset=utf-8' });
    return;
  }
  if (path === '/__report' && request.method === 'POST') {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        state.reports.push({ receivedAt: new Date().toISOString(), report: parsed });
        send(response, 200, { stored: state.reports.length }, { 'content-type': 'application/json; charset=utf-8' });
      } catch (error) {
        send(response, 400, { error: String(error) }, { 'content-type': 'application/json; charset=utf-8' });
      }
    });
    return;
  }

  if (path === '/lyrics' || path.startsWith('/lyrics/')) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, { error: 'method not allowed', allowed: ['GET', 'HEAD'] }, {
        'content-type': 'application/json; charset=utf-8',
        allow: 'GET, HEAD',
      });
      return;
    }
    serveLyricsRoute(response, url, request.method === 'HEAD');
    return;
  }

  if (path.startsWith('/rest/')) {
    const method = path.replace(/^\/rest\//, '').replace(/\.view$/, '');
    const params = Object.fromEntries(url.searchParams.entries());
    state.requests.push({
      method,
      params: { ...params, t: params.t ? `${params.t.slice(0, 8)}…` : undefined },
      at: new Date().toISOString(),
    });
    // The request is recorded as *seen* above, before the hold: what `/__slow` delays is the
    // answer, not the arrival, so a harness can see that a request went out while it is still
    // waiting for the reply.
    if (apiDelayMs > 0) {
      setTimeout(() => handleRest(response, method, params, url), apiDelayMs);
      return;
    }
    handleRest(response, method, params, url);
    return;
  }

  /*
   * The harness's stand-in for a file in the app's **own container** (v1.9.20).
   *
   * On the phone a downloaded cover lives in `Library/Application Support/navilite-offline/` and
   * reaches the page through `Capacitor.convertFileSrc`, which produces a URL on the *app's own*
   * origin rather than the API's. A browser has no such container, so this route is the closest
   * honest equivalent: `tools/offline-check.mjs` seeds the app's offline mirror with art rows whose
   * file URL is here — same-origin with the page, exactly as the converted device path is — and the
   * check then proves the app draws art from there **with the API refused**, which is the half of
   * §5.5's claim a browser can carry. It is a fixture, and it says so; the device path stays the
   * owner's to confirm.
   */
  if (path.startsWith('/offline-art/')) {
    const name = path.replace('/offline-art/', '');
    const seed = name.split('').reduce((total, char) => (total * 31 + char.charCodeAt(0)) % 997, 7);
    send(response, 200, coverFor(seed, 512), { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return;
  }

  serveStatic(response, path === '/' ? '/index.html' : path);
});

/*
 * The bind, and the port it *actually* got.
 *
 * `--port 0` means "ask the OS", which is what `test/support/mock-fixture.ts` uses: a test file that
 * hard-codes a port can be handed one that another test file already owns, and then this process dies
 * of `EADDRINUSE` while the other file's mock quietly answers for it (v1.9.21: 4615 was claimed by
 * both `test/pager.test.ts` and `test/palette-apply.test.ts`; see docs/verification.md §21). Asking
 * makes that impossible, and the machine-readable line below is how the fixture learns the port.
 *
 * A failure to bind is a named one-liner and a non-zero exit, not an unhandled 'error' event: this
 * process is spawned by tests whose stdio is captured, and "listen EADDRINUSE: address already in use
 * 127.0.0.1:4615" three stack frames deep is a worse failure message than one line that says which
 * port and why.
 */
server.on('error', (error) => {
  console.error(`mock-subsonic could not bind 127.0.0.1:${PORT} — ${error.code ?? ''} ${error.message}`.trim());
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  const bound = server.address().port;
  console.log(`mock Subsonic library at http://127.0.0.1:${bound}/rest (user ${USER}, password ${PASSWORD})`);
  console.log(`serving the built app from ${DIST}`);
  // Parsed by test/support/mock-fixture.ts. The one line above is for a human; this one is for the
  // suite, and it is printed from the listen callback so it means "listening", not "asked to listen".
  console.log(`navilite-mock-port ${bound}`);
});
