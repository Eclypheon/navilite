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
 *
 * Debug endpoints (not part of Subsonic, used by the end-to-end check):
 *   GET /__state   → requests seen, scrobbles, starred ids, saved play queue
 *   POST /__reset  → clear that state
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
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i]?.replace(/^--/, '');
  const value = process.argv[i + 1];
  if (key) args.set(key, value ?? 'true');
}
const PORT = Number(args.get('port') ?? 4533);
const DIST = resolve(args.get('dist') ?? join(here, '..', 'dist'));
const USER = args.get('user') ?? 'navidrome';
const PASSWORD = args.get('password') ?? 'navidrome';
const NO_CORS = args.has('no-cors');
const NO_CORS_STREAM = args.has('no-cors-stream');

/* ------------------------------------------------------------------ library */

const ARTIST_NAMES = ['Alien Lab', 'Boot Sector', 'Comet Tail', 'Deep Field'];
const ALBUM_SUFFIXES = ['Transmission', 'Quiet Hours', 'Telemetry'];

const state = {
  requests: [],
  scrobbles: [],
  starred: new Set(),
  playQueue: null,
  ratings: new Map(),
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

const wavCache = new Map();
function wavFor(song) {
  if (!wavCache.has(song.audioIndex)) wavCache.set(song.audioIndex, renderWav(song.audioIndex));
  return wavCache.get(song.audioIndex);
}

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
  return { ...rest, starred: state.starred.has(song.id) ? '2026-01-01T00:00:00Z' : undefined };
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
        playlists: state.playlists,
      },
      { 'content-type': 'application/json; charset=utf-8' },
    );
    return;
  }
  if (path === '/__reset') {
    state.requests = [];
    state.scrobbles = [];
    send(response, 200, { reset: true }, { 'content-type': 'application/json; charset=utf-8' });
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
    handleRest(response, method, params, url);
    return;
  }

  serveStatic(response, path === '/' ? '/index.html' : path);
});

console.log(`mock Subsonic library at http://127.0.0.1:${PORT}/rest (user ${USER}, password ${PASSWORD})`);
console.log(`serving the built app from ${DIST}`);
server.listen(PORT, '127.0.0.1');
