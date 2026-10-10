/**
 * The connect form's *Server URL* copy is a deployment fact with a landmine in it: the tailnet
 * name **without a port** is port 443 — a public Tailscale Funnel to a different service — while
 * the library is on `:9443`. These assertions exist so a future edit cannot bring back the
 * portless placeholder that sends the owner to the wrong page.
 *
 * No DOM and no fetch: this is the copy and the normaliser the field actually uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CANONICAL_ORIGIN, DEFAULT_SERVER_URL, SERVER_URL_PLACEHOLDER } from '../src/config.ts';
import { normalizeServerUrl } from '../src/api/subsonic.ts';

const HOST = 'alienlab.tailbed832.ts.net';

test('the canonical origin is HTTPS on the :9443 door, not port 443', () => {
  const url = new URL(CANONICAL_ORIGIN);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, HOST);
  assert.equal(url.port, '9443');
});

test('v1.1: a blank Server URL means the library, not a dead end', () => {
  // The owner asked for the field to default when left empty. Both the pre-filled value and
  // the empty-submit fallback are this one constant, so they cannot disagree.
  assert.equal(DEFAULT_SERVER_URL, CANONICAL_ORIGIN);
  const url = new URL(DEFAULT_SERVER_URL);
  assert.equal(url.port, '9443');
  assert.equal(normalizeServerUrl(DEFAULT_SERVER_URL), CANONICAL_ORIGIN);
  // And it is a real origin, not a placeholder that would fail a fetch.
  assert.ok(DEFAULT_SERVER_URL.startsWith('https://'));
});

test('the Server URL placeholder keeps the port — never the bare host', () => {
  assert.match(SERVER_URL_PLACEHOLDER, /:9443/, 'the port is the part that matters');
  // Every mention of the host must be followed straight away by ':9443'; a portless mention is
  // exactly the trap this test guards.
  const tails = SERVER_URL_PLACEHOLDER.split(HOST).slice(1);
  assert.ok(tails.length > 0, 'the placeholder still shows a server example');
  for (const tail of tails) {
    assert.ok(tail.startsWith(':9443'), `portless server URL in the placeholder: ...${HOST}${tail.slice(0, 12)}`);
  }
});

test('the door origin round-trips through the client normaliser', () => {
  assert.equal(normalizeServerUrl(CANONICAL_ORIGIN), CANONICAL_ORIGIN);
  // A bare `host:port` gets https:// and stays on :9443.
  assert.equal(normalizeServerUrl(`${HOST}:9443`), CANONICAL_ORIGIN);
  // And a pasted /rest suffix still collapses onto the same origin.
  assert.equal(normalizeServerUrl(`${CANONICAL_ORIGIN}/rest`), CANONICAL_ORIGIN);
});
