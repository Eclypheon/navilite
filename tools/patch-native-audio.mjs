#!/usr/bin/env node
/**
 * Patch the audio vendor's own sources, because two of the things v1.9.2 needs are not reachable
 * from JavaScript at all. Both patches are surgical, anchored on exact strings, and **fail loudly**
 * when an anchor is missing: a dependency upgrade that moves these lines must break the build
 * rather than quietly ship a player with the old behaviour, which is the failure mode this whole
 * release is about.
 *
 *   npm run patch:native     # or: npm install (postinstall), or either build script
 *
 * What it does:
 *
 *   1. **Android — how much the player fills before it will start.** The progressive path builds a
 *      stock `ExoPlayer` (`RemoteAudioAsset.java`), i.e. media3's `DefaultLoadControl` defaults:
 *      50 s minimum and 50 s maximum buffer, with `prioritizeTimeOverSizeThresholds = false`. The
 *      player therefore fills half a minute of audio ahead before a note is heard, which on a
 *      relayed mobile link is ten seconds of silence at least. The sibling `StreamAudioAsset.java`
 *      already overrides exactly this for its own path, so it is the plugin's own intent. The
 *      replacement asks for the owner's number: start once 5 s of media are buffered, keep filling
 *      up to 30 s behind it, and require 1.5 s / 3 s of decoded data to begin.
 *
 *   2. **iOS — stop making AVFoundation scan the file for a duration nobody uses.**
 *      `RemoteAudioAsset.swift` builds its asset with
 *      `AVURLAssetPreferPreciseDurationAndTimingKey: true`, which makes AVFoundation read and index
 *      the media to compute an exact duration. This app never asks for one: the duration it shows
 *      comes from the track's own metadata (and the player's, once it reports it). On a remote
 *      transcoded stream that flag is a scan of the whole file before playback can begin.
 *
 * The iOS forward-buffer target is *not* here: that one is reachable from our own plugin
 * (`ios/App/App/NaviliteSpectrum.swift`, `configureBuffer`) and is set from the app.
 *
 *   3. **iOS — start on the first seconds that arrive** (`ios-start-eagerly`), and
 *   4. **iOS — seek to somewhere the item can reach** (`ios-tolerant-seek`, v1.9.13): the plugin
 *      asked for an *exact* seek, which a progressively downloaded item refuses by flushing every
 *      byte it holds and starting again from the beginning — the owner's *"seeking anywhere on the
 *      seek line seems to make the song play from the beginning"*.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'NAVILITE_BUFFER_PATCH';
const failures = [];
const applied = [];

/** One anchored replacement: the exact text, and what it becomes. Idempotent per patch, by its own marker. */
function patch({ file, id, anchor, replacement, marker = `${MARKER}:${id}` }) {
  const path = join(root, file);
  if (!existsSync(path)) {
    failures.push(`${file}: missing (is @capgo/capacitor-native-audio installed?)`);
    return;
  }
  const before = readFileSync(path, 'utf8');
  if (before.includes(marker)) {
    applied.push(`${id}: already applied`);
    return;
  }
  if (!before.includes(anchor)) {
    failures.push(`${id}: the anchor is gone from ${file} — the vendor's source moved, so this patch would silently do nothing`);
    return;
  }
  const after = before.replace(anchor, replacement.replaceAll('<marker>', marker));
  if (after === before) {
    failures.push(`${id}: the replacement changed nothing in ${file}`);
    return;
  }
  writeFileSync(path, after);
  applied.push(`${id}: applied to ${file}`);
}

/* ---------------------------------------------------------------- Android: the load control */

const JAVA = 'node_modules/@capgo/capacitor-native-audio/android/src/main/java/ee/forgr/audio/RemoteAudioAsset.java';

patch({
  file: JAVA,
  id: 'android-load-control',
  anchor: '\nimport androidx.media3.exoplayer.ExoPlayer;',
  replacement: `\nimport androidx.media3.exoplayer.DefaultLoadControl;\nimport androidx.media3.exoplayer.ExoPlayer; // <marker>`,
});

patch({
  file: JAVA,
  id: 'android-buffer-durations',
  anchor: '                                ExoPlayer player = new ExoPlayer.Builder(owner.getContext()).build();',
  replacement: `                                // <marker>: start on ~5 s of media, not on the stock 50 s.
                                DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                                    .setBufferDurationsMs(5000, 30000, 1500, 3000)
                                    .setPrioritizeTimeOverSizeThresholds(true)
                                    .build();
                                ExoPlayer player = new ExoPlayer.Builder(owner.getContext()).setLoadControl(loadControl).build();`,
});

/* ------------------------------------------------------------------- iOS: the precise duration */

const SWIFT = 'node_modules/@capgo/capacitor-native-audio/ios/Sources/NativeAudioPlugin/RemoteAudioAsset.swift';

patch({
  file: SWIFT,
  id: 'ios-precise-duration',
  anchor: 'var options: [String: Any] = [AVURLAssetPreferPreciseDurationAndTimingKey: true]',
  replacement: `// <marker>: the precise duration was never used, and computing it reads the whole file.
            var options: [String: Any] = [AVURLAssetPreferPreciseDurationAndTimingKey: false]`,
});

/*
 *   3. **iOS — start on the first seconds that arrive, not on a comfortable buffer.** Nothing
 *      anywhere in this app or in the plugin ever set `automaticallyWaitsToMinimizeStalling`, whose
 *      default `true` lets AVFoundation decide for itself that it has buffered "enough" before it
 *      makes a sound. That decision is the silence before a cold tap produces a note, and it is the
 *      one AVFoundation lever for the owner's own wording: *"play as soon as ~5 seconds of audio are
 *      buffered, then keep filling behind it"*. It belongs here rather than in our own plugin
 *      (`NaviliteSpectrum.configureBuffer` sets it too, for the audible item) because it has to be
 *      false on the item **before** the play call, and this is the line where every item this
 *      plugin creates is created.
 */
patch({
  file: SWIFT,
  id: 'ios-start-eagerly',
  anchor: `                let player = AVPlayer(playerItem: playerItem)
                player.volume = self.initialVolume`,
  replacement: `                let player = AVPlayer(playerItem: playerItem)
                // <marker>: make a sound on the first seconds that arrive, and keep filling behind.
                player.automaticallyWaitsToMinimizeStalling = false
                player.volume = self.initialVolume`,
});

/*
 *   4. **iOS — the seek the item can actually perform (v1.9.13).**
 *
 *      The owner: *"seeking anywhere on the seek line seems to make the song play from the beginning
 *      even though on the seek line it shows as if it's playing from where i released it."*
 *
 *      `RemoteAudioAsset.setCurrentTime` seeks with `toleranceBefore: .zero, toleranceAfter: .zero`
 *      — an *exact* seek — which is a demand AVFoundation cannot meet on a progressively downloaded
 *      (transcoded, streamed) item. It answers `finished == false`, and the completion below is the
 *      only place the plugin's own `call.resolve()` happens, so the promise the app holds never
 *      settles either. What the player does with the demand is flush what it had buffered and refill
 *      from the start of the item — the beginning — while `currentTime()` already reads the position
 *      that was asked for, which is why the seek bar showed the finger's position and the sound went
 *      back to the first bar.
 *
 *      Half a second of tolerance is a seek AVFoundation can satisfy from the bytes it holds, and it
 *      is inside the resolution of the thing that asked: the bar is a finger wide and the app asks
 *      in tenths of a second. The completion is called either way, so a seek that still cannot be
 *      performed is a *reported* seek rather than a promise that hangs for ever — which is the leak
 *      the app has been working around since v1.9.1 (`SEEK_TIMEOUT_MS`).
 */
patch({
  file: SWIFT,
  id: 'ios-tolerant-seek',
  anchor: `            let target = CMTime(seconds: validTime, preferredTimescale: Self.seekPreferredTimescale)
            player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { finished in
                guard finished else { return }
                completion?()
            }`,
  replacement: `            let target = CMTime(seconds: validTime, preferredTimescale: Self.seekPreferredTimescale)
            // <marker>: land on the nearest frame the item can render, not on an exact one.
            let tolerance = CMTime(seconds: 0.5, preferredTimescale: Self.seekPreferredTimescale)
            player.seek(to: target, toleranceBefore: tolerance, toleranceAfter: tolerance) { _ in
                // Settle the caller either way: a seek that is not reported as finished must still
                // be an answer, or it is a promise that never resolves.
                completion?()
            }`,
});

for (const line of applied) console.log(`[navilite] ${line}`);
if (failures.length > 0) {
  for (const line of failures) console.error(`[navilite] PATCH FAILED — ${line}`);
  process.exit(1);
}
console.log(`[navilite] native audio sources patched (${MARKER})`);
