/**
 * The Subsonic client: URL construction, token auth, response parsing and error mapping.
 * fetch is stubbed, so nothing here touches a network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SubsonicClient, SubsonicError, isTransportFailure, normalizeServerUrl } from '../src/api/subsonic.ts';

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
  // v1.9.2: ONE salt per session, not per request. Deliberate — a stable URL can be cached, and
  // over a relayed link the round trips are what cost seconds. The token is exactly as opaque as
  // it was (salted MD5, salt never leaves the device); what it gives up is per-request freshness.
  // Reviewed as a security-relevant decision rather than assumed correct.
  assert.equal(a.searchParams.get('s'), b.searchParams.get('s'), 'the session keeps one salt');
  assert.equal(a.searchParams.get('t'), b.searchParams.get('t'), 'so the token is stable too');
  assert.notEqual(new SubsonicClient({ serverUrl: '', username: 'kester', password: 'hunter2' }).authParams().s, salt, 'a different session still gets a different salt');
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

/*
 * v1.9.18 — which failures mean "there is no server".
 *
 * The distinction is the whole of the offline fix: a rejected `fetch` is the phone with no tailnet,
 * and the view has to degrade for it; an HTTP or Subsonic-level answer is a server that is *there*,
 * and its message is information the owner asked for. Before this flag existed the two were one
 * thing — a `SubsonicError` with code 0 — and the view could not tell them apart.
 */
test('a rejected fetch is flagged unreachable, and a server’s own answer is not', async () => {
  const failureOf = async (run: () => Promise<unknown>): Promise<SubsonicError> => {
    try {
      await run();
    } catch (error) {
      if (error instanceof SubsonicError) return error;
      throw error;
    }
    throw new Error('expected the call to fail, and it resolved');
  };

  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async () => {
    throw new TypeError('Load failed');
  }) as typeof fetch;
  const client = new SubsonicClient({ serverUrl: 'https://alienlab.tailbed832.ts.net:9443', username: 'u', password: 'p' });
  const offline = await failureOf(() => client.ping());
  assert.equal(offline.unreachable, true, 'a transport failure says the server was never reached');
  assert.match(offline.message, /could not reach https:\/\/alienlab\.tailbed832\.ts\.net:9443/);

  stubFetch(envelope({ status: 'failed', error: { code: 40, message: 'Wrong username or password' } }));
  const refused = await failureOf(() => client.ping());
  assert.equal(refused.unreachable, false, 'the server answered, so this is not an offline failure');
  assert.equal(refused.code, 40, 'and its own error code survives');

  stubFetch(envelope(), 503);
  const http = await failureOf(() => client.ping());
  assert.equal(http.unreachable, false, 'an HTTP status is an answer too');
  assert.equal(http.code, 503, 'and it keeps the status as its code');
});

/*
 * v1.9.19 — the classification a view asks is not "any TypeError".
 *
 * Until this, a screen that needs the server read *every* `TypeError` as "there is no server", so a
 * genuine bug inside the view was drawn as the `Offline` pill with its message going to the console
 * only: the app blamed the network for its own defect, which is the misdiagnosis the offline work
 * exists to stop. A real error now keeps the path to the screen it always had.
 */
test('only a transport failure is unreachable — a real TypeError is not', () => {
  assert.equal(isTransportFailure(new TypeError('Load failed')), true, 'WebKit’s rejected fetch');
  assert.equal(isTransportFailure(new TypeError('Failed to fetch')), true, 'Chromium’s rejected fetch');
  assert.equal(isTransportFailure(new TypeError('NetworkError when attempting to fetch resource.')), true, 'Firefox’s');
  assert.equal(
    isTransportFailure(new TypeError("Cannot read properties of undefined (reading 'entry')")),
    false,
    'a real bug inside a view is not an offline server',
  );
  assert.equal(isTransportFailure(new RangeError('Maximum call stack size exceeded')), false, 'nor is any other error type');
  assert.equal(isTransportFailure('could not reach https://example'), false, 'nor is a bare string');
  assert.equal(isTransportFailure(new SubsonicError(40, 'Wrong username or password')), false, 'the server answered');
  assert.equal(
    isTransportFailure(new SubsonicError(0, 'could not reach https://example', { unreachable: true })),
    true,
    'and the client’s own transport verdict is relayed',
  );
});
