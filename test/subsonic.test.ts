/**
 * The Subsonic client: URL construction, token auth, response parsing and error mapping.
 * fetch is stubbed, so nothing here touches a network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SubsonicClient, SubsonicError, normalizeServerUrl } from '../src/api/subsonic.ts';

// The client reads `location` to decide whether a deployment is cross-origin.
(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://navilite.example' };

interface Recorded {
  url: string;
}

function stubFetch(response: unknown, status = 200): { calls: Recorded[] } {
  const calls: Recorded[] = [];
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL) => {
    calls.push({ url: String(input) });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      json: async () => response,
    } as Response;
  }) as typeof fetch;
  return { calls };
}

const envelope = (payload: Record<string, unknown> = {}) => ({
  'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.64.2', ...payload },
});

test('normalizeServerUrl handles the shapes a person actually types', () => {
  assert.equal(normalizeServerUrl(''), '');
  assert.equal(normalizeServerUrl('   '), '');
  assert.equal(normalizeServerUrl('/'), '');
  assert.equal(normalizeServerUrl('alienlab.tailbed832.ts.net'), 'https://alienlab.tailbed832.ts.net');
  assert.equal(normalizeServerUrl('https://alienlab.tailbed832.ts.net/'), 'https://alienlab.tailbed832.ts.net');
  assert.equal(normalizeServerUrl('https://alienlab.tailbed832.ts.net/rest'), 'https://alienlab.tailbed832.ts.net');
  assert.equal(normalizeServerUrl('http://192.168.1.119:4533/rest/'), 'http://192.168.1.119:4533');
});

test('builds token auth with a fresh salt, and t really is md5(password + salt)', () => {
  const client = new SubsonicClient({ serverUrl: '', username: 'kester', password: 'hunter2' });
  const first = client.url('getArtists');
  const second = client.url('getArtists');

  const parse = (url: string): URL => new URL(url, 'https://navilite.example');
  const a = parse(first);
  const b = parse(second);

  assert.equal(a.pathname, '/rest/getArtists.view');
  assert.equal(a.searchParams.get('u'), 'kester');
  assert.equal(a.searchParams.get('v'), '1.16.1');
  assert.equal(a.searchParams.get('c'), 'Navilite');
  assert.equal(a.searchParams.get('f'), 'json');

  const salt = a.searchParams.get('s');
  assert.ok(salt && salt.length >= 6, 'salt is present and long enough');
  assert.equal(a.searchParams.get('t'), createHash('md5').update(`hunter2${salt}`).digest('hex'));
  // A new salt per request, exactly as the API asks.
  assert.notEqual(a.searchParams.get('s'), b.searchParams.get('s'));
  assert.notEqual(a.searchParams.get('t'), b.searchParams.get('t'));
});

test('same-origin is the default and is not treated as cross-origin', () => {
  const sameOrigin = new SubsonicClient({ serverUrl: '', username: 'a', password: 'b' });
  assert.equal(sameOrigin.isCrossOrigin, false);
  assert.match(sameOrigin.streamUrl('song-1'), /^\/rest\/stream\.view\?/);

  const remote = new SubsonicClient({ serverUrl: 'https://alienlab.tailbed832.ts.net', username: 'a', password: 'b' });
  assert.equal(remote.isCrossOrigin, true);
  assert.match(remote.streamUrl('song-1'), /^https:\/\/alienlab\.tailbed832\.ts\.net\/rest\/stream\.view\?/);
});

test('parses an ok envelope', async () => {
  const { calls } = stubFetch(
    envelope({ artists: { index: [{ name: 'A', artist: [{ id: 'artist-1', name: 'Alien Lab', albumCount: 2 }] }] } }),
  );
  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'p' });
  const artists = await client.getArtists();
  assert.deepEqual(artists, [{ id: 'artist-1', name: 'Alien Lab', albumCount: 2 }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /getArtists\.view/);
});

test('surfaces Subsonic failures with their code and a readable message', async () => {
  stubFetch(envelope(), 200);
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
    ({ ok: true, status: 200, json: async () => ({ 'subsonic-response': { status: 'failed', error: { code: 40, message: 'Wrong username or password' } } }) }) as Response) as typeof fetch;

  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'wrong' });
  await assert.rejects(
    () => client.ping(),
    (error: unknown) => {
      assert.ok(error instanceof SubsonicError);
      assert.equal(error.code, 40);
      assert.match(error.message, /wrong username or password/i);
      return true;
    },
  );
});

test('star/unstar use id for songs and albumId/artistId for the rest', async () => {
  const { calls } = stubFetch(envelope());
  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'p' });

  await client.star('song-9', 'song');
  const songCall = new URL(calls[0].url, 'https://navilite.example');
  assert.equal(songCall.pathname, '/rest/star.view');
  assert.equal(songCall.searchParams.get('id'), 'song-9');
  assert.equal(songCall.searchParams.get('albumId'), null);

  await client.unstar('album-3', 'album');
  const albumCall = new URL(calls[1].url, 'https://navilite.example');
  assert.equal(albumCall.pathname, '/rest/unstar.view');
  assert.equal(albumCall.searchParams.get('albumId'), 'album-3');
  assert.equal(albumCall.searchParams.get('id'), null);

  await client.star('artist-4', 'artist');
  const artistCall = new URL(calls[2].url, 'https://navilite.example');
  assert.equal(artistCall.searchParams.get('artistId'), 'artist-4');
});

test('scrobble distinguishes now-playing from a real play', async () => {
  const { calls } = stubFetch(envelope());
  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'p' });
  await client.scrobble('song-1', false, 111);
  await client.scrobble('song-1', true, 222);
  const nowPlaying = new URL(calls[0].url, 'https://navilite.example');
  const played = new URL(calls[1].url, 'https://navilite.example');
  assert.equal(nowPlaying.searchParams.get('submission'), 'false');
  assert.equal(played.searchParams.get('submission'), 'true');
  assert.equal(played.searchParams.get('time'), '222');
});

test('play queue round-trips ids, current and position', async () => {
  const { calls } = stubFetch(envelope());
  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'p' });
  await client.savePlayQueue(['s1', 's2', 's3'], 's2', 1234.7);
  const saved = new URL(calls[0].url, 'https://navilite.example');
  assert.equal(saved.searchParams.get('id'), 's1,s2,s3');
  assert.equal(saved.searchParams.get('current'), 's2');
  assert.equal(saved.searchParams.get('position'), '1235');
});

test('a non-JSON body is reported as "this is not a Navidrome"', async () => {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () =>
    ({ ok: true, status: 200, json: async () => { throw new Error('not json'); } }) as unknown as Response) as typeof fetch;
  const client = new SubsonicClient({ serverUrl: '', username: 'u', password: 'p' });
  await assert.rejects(() => client.ping(), /did not return JSON/);
});
