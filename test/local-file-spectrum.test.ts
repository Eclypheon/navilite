/**
 * v1.9.16 — a downloaded track is played by the transport every native feature is keyed on.
 *
 * The defect is invisible from JavaScript: the JS layer already hands the tap the `file://` URL a
 * downloaded track resolves to (`src/state/library.ts:79`, `src/player/engine.ts:2792`), and the
 * refusal happens inside the vendor plugin — which has exactly two transports and picks between them
 * by URL scheme. `RemoteAudioAsset` holds `players: [AVPlayer]`; `AudioAsset` holds
 * `channels: [AVAudioPlayer]` and no `players` at all. Every capability this app has finds the player
 * it may not guess at by reflecting that property (`ios/App/App/NaviliteSpectrum.swift:1286`,
 * `NaviliteRemote.swift`), so on a `file://` asset the reflection found nothing and the tap refused
 * (`NaviliteSpectrum.swift:1286-1291`): flat bars and the chip *native audio* for the whole downloaded
 * track, while the streamed version of the same track was fine.
 *
 * Only the native source can fail this test, so the native source is what it reads — and it reads the
 * vendor tree the build actually compiles (`ios/App/CapApp-SPM/Package.swift:16` is a path into
 * `node_modules`), so `npm run patch:native` has to have run; `postinstall` and every build script
 * run it. The class each scheme gets is **resolved out of the branch**, and the property the tap looks
 * for is **read out of the reflection**, so neither can drift from the sources they came from: at HEAD
 * before the patch, direction (1) and (3) below fail on the branch building a class that does not
 * declare the property the tap reflects.
 *
 * The three directions, as a set:
 *
 *   1. **the new behaviour** — `file://` now reaches the class that declares the reflected property,
 *      and the same file is not decoded into an `AVAudioPlayer` at the same time;
 *   2. **what must not break** — `http(s)` still gets that same class, with the path and the headers
 *      it always passed (the streamed spectrum the owner has today);
 *   3. **recovery** — a local track and the streamed one after it resolve to the **same** class, so a
 *      boundary is not a transport change and the tap that follows the item keeps existing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = join(root, 'node_modules', '@capgo', 'capacitor-native-audio', 'ios', 'Sources', 'NativeAudioPlugin');
const plugin = readFileSync(join(vendor, 'Plugin.swift'), 'utf8');
const spectrum = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteSpectrum.swift'), 'utf8');

/** Where each transport is declared: the class name the plugin instantiates, resolved to its source. */
const TRANSPORT_SOURCE: Record<string, string> = {
  RemoteAudioAsset: readFileSync(join(vendor, 'RemoteAudioAsset.swift'), 'utf8'),
  AudioAsset: readFileSync(join(vendor, 'AudioAsset.swift'), 'utf8'),
};

/** The one place the plugin decides a scheme's transport, inside the method the app's call lands on. */
const preloadEntry = plugin.slice(plugin.indexOf('@objc func preload(_ call: CAPPluginCall)'));
const preload = plugin.slice(plugin.indexOf('private func preloadAsset(_ call: CAPPluginCall'));
const seam = preload.slice(preload.indexOf('if url.isFileURL {'));
const remoteAt = seam.indexOf('// Handle remote URL');
const FILE_BRANCH = seam.slice(0, remoteAt);
const HTTP_BRANCH = seam.slice(remoteAt, seam.indexOf('} else if isLocalUrl == false {'));

/** The property the app's own plugin reflects, read out of that reflection rather than written here. */
function reflectedProperty(): string {
  const match = spectrum.match(/for child in Mirror\(reflecting: (?:asset|value)\)\.children where child\.label == "(\w+)"/);
  assert.ok(match, 'the spectrum plugin reflects a named property on the asset it may not guess at');
  return match[1];
}

/** The class a branch builds, read out of the branch. */
function transportOf(branch: string): string {
  const match = /let \w+ = (\w+)\(/.exec(branch);
  assert.ok(match, 'the branch builds an asset class');
  return match[1];
}

test('a downloaded track reaches the class that declares the property the tap reflects', () => {
  const property = reflectedProperty();
  // The app's own call: `NativeAudio.preload` with the resolved URL (`src/player/native.ts:802`).
  assert.match(
    preloadEntry,
    /preloadAsset\(call, isComplex: true\)/,
    'the branches below belong to the method `preload` — the one the app calls — sends every load to',
  );
  const className = transportOf(FILE_BRANCH);
  const source = TRANSPORT_SOURCE[className];

  assert.ok(source, `the class a file:// URL gets is one of the vendor's own (${className})`);
  assert.match(
    source,
    new RegExp(`var ${property}: \\[AVPlayer\\]`),
    `the class the file:// branch builds declares \`${property}: [AVPlayer]\` — the property the tap reads, and a class without it is the refusal the owner heard as flat bars (${className})`,
  );
  // The file URL itself goes to it, not a rewritten path: the vendor's `URL(string:)` needs the scheme.
  assert.match(FILE_BRANCH, /withPath: assetPath/, 'and it is handed the file URL the app resolved');
  assert.doesNotMatch(
    FILE_BRANCH,
    /let \w+ = AudioAsset\(/,
    'the file:// branch no longer builds the transport that has no player the tap can find',
  );
});

test('the same file is decoded once, not twice', () => {
  const asset = TRANSPORT_SOURCE.AudioAsset;
  assert.match(
    asset,
    /path\.lowercased\(\)\.hasPrefix\("file:\/\/"\)/,
    'the base class refuses to build AVAudioPlayers for a file:// path, so the remote asset it initializes through does not decode the downloaded file a second time',
  );
});

test('what must not break: a streamed track still gets that same class, with its path and headers', () => {
  const className = transportOf(HTTP_BRANCH);
  const source = TRANSPORT_SOURCE[className];
  assert.match(source, new RegExp(`var ${reflectedProperty()}: \\[AVPlayer\\]`), 'a stream is on a transport the tap can find');
  assert.match(HTTP_BRANCH, /withPath: assetPath/, 'with the URL it was given');
  assert.match(HTTP_BRANCH, /withHeaders: headers/, 'and the headers the app passed (unchanged)');
});

test('recovery: a local track and the streamed one after it are the same transport, so the tap follows the item', () => {
  const property = reflectedProperty();
  const byScheme: Record<string, string> = { file: transportOf(FILE_BRANCH), http: transportOf(HTTP_BRANCH) };
  assert.equal(
    byScheme.file,
    byScheme.http,
    `one transport, not two chosen by scheme — a boundary is not a transport change (file: ${byScheme.file}, http: ${byScheme.http})`,
  );
  // Both halves of the sequence the app actually plays, and the array the tap looks up exists on
  // every item of it rather than only on the streamed ones.
  for (const scheme of ['file', 'http', 'file'] as const) {
    const source = TRANSPORT_SOURCE[byScheme[scheme]];
    assert.match(
      source,
      new RegExp(`var ${property}: \\[AVPlayer\\]`),
      `the ${scheme} item of the sequence holds the array the tap reads (${byScheme[scheme]})`,
    );
  }
});
