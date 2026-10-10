# Navilite — PWA vs native vs hybrid: a decision document

*Prepared by Mugger (researcher) · 2026-10-10 · navidrome 0.64.2 · research only, nothing built.*

---

## 0. The call (answer first)

**Build one web codebase (TypeScript/PWA), ship it three ways: host it as a PWA, wrap it with
Capacitor for the Android APK and the iOS IPA.** That is the only architecture that yields all
three artifacts from *one* body of code without a second team-sized effort, and it is the lightest
to maintain for a ~400-track personal library.

**The honest caveat that shapes the whole design:** a *true, audio-driven* spectrum (kew-style) is a
**web problem with a server-side dependency** (CORS / same-origin), and it **collides with reliable
iOS background playback**. So the visualiser must be **progressive enhancement**: real AnalyserNode
spectrum where the platform allows it, graceful procedural/album-art fallback where it doesn't.

**Do not** build separate Swift + Kotlin apps. **Flutter is the credible runner-up** if you decide the
visualiser must be rock-solid on iOS and background playback must be first-class — at the cost of Dart
and a bundled runtime (heavier than the web path).

Two things to decide up front (both cheap, both decisive):
1. Put Navidrome + Navilite behind **one origin** (reverse proxy), so every CORS problem in §2 vanishes.
2. Accept that **iOS "real spectrum" is foreground-only**; on iOS lock screen you get kew *themes*
   (album-art colours), not kew *spectrum*.

---

## 1. PWA vs native vs hybrid — what actually fits "very lightweight"

Weighting axes from the brief: install footprint · background audio · lock-screen controls · offline
caching · how much *one* codebase yields APK+IPA+PWA.

| Approach | Same code → APK+IPA+PWA? | Footprint | Background audio | Lock-screen / now-playing | Offline cache | Verdict for Navilite |
|---|---|---|---|---|---|---|
| **PWA only** (install to home screen) | PWA yes; APK/IPA no | ~0 (no install) | Android: OK (media element). iOS: OK since iOS 15.4 *for a media element* — see §2 caveat | Android: Media Session. iOS: Media Session (Safari iOS 15+) | Service worker (shell + explicit downloads) | Best "no store, no build" tier — but you asked for APK+IPA too |
| **PWA + Capacitor** (web in a native shell) | **Yes — all three** | Small shell + system WebView (no bundled browser engine) | Yes (native audio plugin: ExoPlayer / AVFoundation) | Yes (native Now Playing / media notification) | Service worker + native filesystem | **Recommended** |
| **PWA + TWA** (Android only) | Android yes; iOS no | Tiny, but **requires Chrome** installed on the phone | Via Chrome | Via Chrome | Via Chrome/SW | Good *only* as a store-listing shim for Android; not the primary path |
| **React Native / Expo** | iOS+Android only (web is poor) | Larger (JS runtime + native modules) | Yes (native) | Yes (native) | Yes | No PWA; you'd still build a separate web app → two codebases |
| **Flutter** | iOS+Android+web, but web is a canvas stack | Largest (bundles Skia/Dart) | Yes (native) | Yes (native, via audio_service/just_audio) | Yes | Runner-up if visualiser fidelity on iOS is non-negotiable; Dart + heavier |
| **Fully separate native** (Swift/UIKit + Kotlin/Compose) | No — two codebases | Smallest per platform | Best | Best | Best | Overkill for one dev + 400 tracks; two skillsets to maintain |

Notes and sources:
- **Capacitor is a thin native runtime over your web build** — "one web app → cross-platform iOS,
  Android, …" and it "ships with first-class PWA support" (capacitorjs.com). That single sentence is
  the whole reason it wins here: the *same* `dist/` is the PWA, the APK's payload, and the IPA's payload.
- **Ionic's commercial products were discontinued in 2025** (Appflow, Identity Vault, Portals), but the
  announcement explicitly reaffirms that "Ionic Framework and Capacitor … will remain free and open
  source" and "continue to be maintained and improved" as part of OutSystems' mobile stack
  (ionic.io blog, 2025). So Capacitor is safe to build on, but expect the *commercial* tooling
  ecosystem around it to be smaller; community plugins (Capgo/Capawesome) fill gaps.
- **TWA** is Chrome-specific: it needs Chrome on Android (Chrome 72+), and the app↔site trust is proven
  with a Digital Asset Links file at `/.well-known/assetlinks.json` (developer.android.com /
  developer.chrome.com). Capacitor avoids that by using the device's Android **System WebView**
  (present on effectively all Android devices) instead of requiring the Chrome app.
- **Footprint, stated honestly:** the verified anchor is that a *native* Flutter Subsonic client
  (SubStreamer) is **56.3 MB on the App Store** (apps.apple.com). A Capacitor app is roughly
  "your web assets + the system WebView" — no bundled JS engine or Skia like RN/Flutter, so it is the
  smallest of the cross-platform options. Exact MB depends on your assets and which native plugins you
  add; **treat footprint numbers for RN/Flutter/Capacitor as approximate and confirm with a spike**,
  not from a blog.

---

## 2. The visualiser is the hard part — and here is exactly why

### 2.1 What Web Audio requires for a *remote* stream

- To paint a spectrum you route the playing audio into an `AnalyserNode`
  (`createMediaElementSource(<audio>) → AnalyserNode → destination`) and read
  `getByteFrequencyData()` every frame (MDN `AnalyserNode`).
- When the `<audio>` `src` is **cross-origin**, the browser refuses to hand you the samples unless the
  element opts in *and the server agrees*:
  - the element must set **`crossorigin="anonymous"`** ("Sends a cross-origin request without a
    credential … If the server does not … set `Access-Control-Allow-Origin`, the resource will be
    *tainted*, and its usage restricted") — MDN `<audio>` `crossorigin`;
  - the server must return **`Access-Control-Allow-Origin`** for your app's origin.
- If it doesn't: no error is thrown — the analyser just returns **silence/zeroes**, so your "visualiser"
  flatlines. This is the classic *"MediaElementAudioSource outputs zeroes due to CORS"* failure
  (StackOverflow).

### 2.2 What Navidrome actually sends

- **Navidrome does not send `Access-Control-Allow-Origin` on `/rest/*` (including `/rest/stream`) by
  default.** Evidence, three ways:
  1. The Navidrome **configuration reference has no CORS option at all** — no `ND_CORSALLOWEDORIGINS`,
     none. (navidrome.org docs/usage/configuration/options, page last modified 2026-09-27.) The
     historical `ND_REVERSEPROXYWHITELIST` has been **replaced** by `ExtAuth.TrustedSources`, and both
     concern *reverse-proxy auth trust*, not CORS.
  2. The only place Navidrome ever emitted ACAO was its SSE endpoint
     (`server/events/sse.go`), and the maintainer **removed it in Jan 2025**
     (issue #3660, commit 657fe11: "I actually don't think we need this header at all … I'll remove it").
  3. The shipping browser client **Tonearm** states it plainly in code comments: *"no Web Audio API by
     default. This avoids the CORS requirement that `createMediaElementSource` imposes (**Navidrome's
     stream endpoint often doesn't send `Access-Control-Allow-Origin`**)"* — and it only enables Web
     Audio (EQ/visualiser) after setting `crossOrigin` and reloading, which "works transparently when
     the app is served in **proxy mode** (streams are same-origin); in direct mode it needs the
     Navidrome server to send CORS headers." (j4ckxyz/navidrome-client-web, `src/player/engine.ts`.)

### 2.3 Therefore: a same-origin proxy is required for a real PWA spectrum

- **Cleanest fix:** serve Navilite and Navidrome under **one origin** (reverse proxy the `/rest`,
  `/api`, `/auth`, `/share` paths to Navidrome). Tonearm's own deployment guide gives the two options
  verbatim: (1) same hostname, "no CORS at all"; (2) have the server emit `Access-Control-Allow-Origin`,
  `Access-Control-Allow-Headers` and answer `OPTIONS` with 204. Since you already need a reverse proxy /
  Tailscale Funnel for remote access, option (1) is nearly free.
- This is also why the *simplest possible* Navilite is "Add to Home Screen on Navidrome's own web UI":
  Navidrome's UI **is already an installable PWA** (`vite-plugin-pwa`, `display: standalone`, a Workbox
  service worker — `ui/vite.config.js`, `ui/src/sw.js` in the repo). It just doesn't have a kew-style
  visualiser. Navilite's whole reason to exist is that gap.

### 2.4 iOS makes the real spectrum even harder (background)

- iOS **does** play audio from a Home-Screen web app in the background/lock screen — but only since
  **iOS 15.4** (WebKit bug 198277, reopened and confirmed fixed Feb 2022).
- **Web Audio specifically does not survive backgrounding on iOS.** The maintainer of `flutter_soloud`
  (answered Jun 2026): *"iOS Safari/WebKit does not allow WebAudio to bypass the silent switch or
  continue in the background/lock screen … For background audio on iOS, a native app with
  `AVAudioSessionCategory.playback` is the supported route; **for iOS PWA, this is a platform
  limitation**."* Corroborated by an iOS-15 report of Web Audio dying after screen-lock and a 2025
  report of Safari silently suspending the AudioContext in background.
- **Consequence for Navilite:** if you tap the audio through an `AudioContext` to feed the analyser,
  you risk iOS pausing on lock. Android Chrome does not have this problem (Web Audio continues while
  audio plays in background).

### 2.5 The native equivalent, and its cost

- **Android:** two routes. (a) the platform `Visualizer` API returns waveform + 8-bit FFT, **but
  requires `android.permission.RECORD_AUDIO`** (and `MODIFY_AUDIO_SETTINGS` for the output mix) —
  a scary permission for a music player (Android docs, Visualizer). (b) Better: attach a custom
  ExoPlayer/Media3 `AudioProcessor` and FFT the PCM yourself — **no permission needed**, but you write
  the FFT/banding (documented pattern: `buildAudioProcessors()` + an FFT lib).
- **iOS:** `AVAudioEngine` install a tap / use `Accelerate`/vDSP FFT on the player's tap — native, no
  permission, and it works in the background because it's your own audio session.
- **Cost:** this is real DSP + native code on both platforms, and it is *per-platform* work the web path
  avoids. It is the main thing you buy if you go Flutter/native.

### 2.6 Fallback that keeps the product honest

kew's hook is partly the *spectrum* and partly the *look* (themes auto-generated from album-art
colours — ravachol/kew README). The colour/look half is **fully reproducible in a PWA** without any
Web Audio: sample the album art with a `<canvas>` and drive a procedural, beat-estimated animation.
Tonearm ships exactly this dual path: its analyser reader falls back to *"a gentle synthesized signal
so the scene never looks frozen"* when the source is *"silent/tainted (a cross-origin stream blanks the
data with no error)"* (`src/features/visualizer/analysis.ts`).
**Fidelity cost:** the fallback is decorative, not truthful — bars move to an estimate, not the music.
On iOS-in-background that is the only option; in foreground / on Android you get the real spectrum.

---

## 3. IPA reality check (2026)

What's true right now, source-first:

| Route | Cost | Validity / limits | Practical verdict |
|---|---|---|---|
| **Free Apple ID ("Personal Team"), sideload via Xcode** | 0 | **10 App IDs (7 days), 3 devices (7 days), 3 apps per device; provisioning profile expires 7 days after issuance; rebuild + reinstall after expiry** (developer.apple.com "Developer account overview") | Works for a personal device; expect to **re-provision weekly** |
| **AltStore / SideStore / Sideloadly** | 0 | Same 7-day free-account rules; **AltStore needs AltServer on a computer; SideStore refreshes on-device via a local VPN** and, on a free account, "can only install 3 apps (including itself) at a time" (docs.sidestore.io) | The realistic way to live with the 7-day churn |
| **Apple Developer Program** (paid) | **$99/year** | 1-year certs, App Store + TestFlight + Ad Hoc | The sane path once you're past prototyping |
| **TestFlight** (needs the paid Program) | incl. | **up to 100 internal testers, 10,000 external testers, up to 100 builds**; external builds need App Review; **builds expire after 90 days** (developer.apple.com/testflight) | Best "give it to a few phones" distribution |
| **Apple Developer Enterprise Program** | **$299/year** | **Requires 100+ employees**, organisation verification, and is licensed **only for internal distribution to your own employees** (developer.apple.com/programs/enterprise) | **Not applicable** to a personal app — do not go here |

**What a PWA can do on iOS instead (and what it can't):**
- ✅ **Add to Home Screen**, standalone/full-screen, own app-switcher entry (WebKit blog, iOS 16.4 —
  Feb 2023). **No automatic install prompt** — the user must use Safari's Share sheet (mobiloud, 2026).
- ✅ **Web Push** — real APNs-backed push for Home-Screen web apps since **iOS 16.4 (Mar 2023)**; no
  Apple Developer membership needed. **Safari 18.4 (2025)** added *Declarative Web Push*. Push only
  works when installed to the Home Screen (WebKit blog; mobiloud).
- ✅ **Media Session / lock-screen controls** — supported on **Safari iOS 15+** (MDN MediaSession compat:
  Safari iOS 15 full support for e.g. `setPositionState`).
- ✅ Background **media-element** audio since iOS 15.4 (§2.4).
- ❌ **Background playback of Web-Audio-driven output** (§2.4). ❌ No background sync, aggressive storage
  eviction, no sideload-free "install" of arbitrary apps. ❌ You can't ship an `.ipa` without a Mac
  (you have one) and without either paying $99/yr or re-signing every 7 days.
- ℹ️ iOS now opens Home-Screen sites as web apps by default (iOS 26, 2026, reported — secondary source;
  the API-level facts above are the ones to rely on).

---

## 4. Talking to the library — APIs

- **Use the Subsonic API. It is on by default** in 0.64.2 — Navidrome "implements the Subsonic API",
  served under `/rest`, and the docs list the supported endpoints with no enable flag. (Contrast: the
  *new* Jellyfin API in 0.64.0 is behind `Jellyfin.Enabled` defaulting to **false** — release notes.)
  Version: **Subsonic API 1.16.1**, plus OpenSubsonic extensions (navidrome.org/docs/developers/subsonic-api).
- **Endpoints you actually need** (all confirmed present in Navidrome's compat list):
  - playback: **`stream`** (and `download` for offline), `getCoverArt`
  - browse: `getArtists`, `getArtist`, `getAlbum`, `getAlbumList2`, `getGenres`, `getSong`
  - search: **`search3`** (simple autocomplete only — no Lucene)
  - playlists: **`getPlaylists`**, `getPlaylist`, `createPlaylist`, `updatePlaylist`
  - annotation: **`scrobble`** (with `submission=true` to mark played), **`star`**/`unstar`, `setRating`
  - now-playing / resume: `getNowPlaying`, `getPlayQueue`/`savePlayQueue`
  - Caveat: Navidrome does **not** mark a song played on `stream`; only on `scrobble`.
  - IDs are **strings** (MD5/UUID), and in 0.64.0 they moved to a new canonical 128-bit format — **cache
    keys must not assume the old shape** (post-upgrade re-sync).
- **Auth** (subsonic.org/pages/api.jsp):
  - Recommended since API 1.13.0: per-call **`s`** = random salt (≥6 chars), **`t` = md5(password + salt)**.
  - Legacy/plaintext: **`p=`** clear text, or `p=enc:<hex>` (docs say "for testing only").
  - Also add `u=`, `v=1.16.1`, `c=<client name>`; Basic auth also works for many clients.
- **Navidrome's own native API** (`/api/*` + `/auth/*`) exists and is what the web UI uses
  (`x-nd-authorization` token flow), but it is **not a documented public contract** — don't build
  a third-party client on it. Stick to Subsonic.
- **Single-user / no-creds-in-the-binary:**
  - Never embed the password or a token in the IPA/APK — these are extractable. Instead: **on first run,
    ask for server URL + username + password**, then persist **in OS secure storage** —
    **iOS Keychain / Android EncryptedSharedPreferences or Keystore** — and compute the `t`/`s` token per
    request from the stored password (matches the Subsonic recommendation). A native shell (Capacitor)
    gets you Keychain/Keystore; a **pure PWA does not** — it has only web storage
    (localStorage/IndexedDB, exfiltrable), which is a real assurance downgrade. (Tonearm is explicit that
    it stores only a derived token in the browser for this reason.)
  - Store the server URL + username as plain config (not secret). Optionally short-lived session tokens.

---

## 5. Prior art worth naming

| Project | Platform / stack | Notes relevant to Navilite |
|---|---|---|
| **Tonearm** (`j4ckxyz/navidrome-client-web`) | Browser + desktop webview | **Closest reference.** Browser Navidrome/Jellyfin client with a **"music-reactive full-screen visualiser"** and 10-band EQ, implemented with Web Audio over Navidrome streams; **explicitly desktop-only** ("phones and tablets aren't supported"). Proves the visualiser *and* documents the CORS/same-origin requirement you'll hit. |
| **kew** (`ravachol/kew`) | C terminal TUI (macOS via Homebrew) | The reference look: **spectrum visualiser + themes auto-generated from album colours**, GPLv2+. Your product spec is "this, on a phone." |
| **Substreamer** (`ghenry22/substreamer`) | Flutter, iOS+Android, GPLv3 | Free/OSS, verified with Navidrome; **56.3 MB on iOS App Store** — a good size anchor for a native Flutter client. No kew-style visualiser. |
| **Amperfy** (`BLEeEZ/amperfy`) | Swift, iOS/iPadOS/macOS, GPLv3 | Native Swift, offline, CarPlay, EQ + ReplayGain. Strong iOS baseline; no spectrum visualiser. |
| **play:Sub** | Native iOS, ~$5 one-time | Veteran Subsonic client, strong caching/CarPlay. Closed source. |
| **Symfonium** (symfonium.app) | Native Android, paid | Polished Android client (Plex/Jellyfin/Navidrome, EQ/DSP). Closed source, no web/PWA. |
| **Feishin** (`jeffvli/feishin`) | Electron desktop + web, rewrite of Sonixd | MPV or web player backend; desktop-first, not a phone app. |
| **Tempo / Tempus / NaviPlayer / Submariner / Ferrosonic / Firmium** | Android (Kotlin/Flutter) | The active Android field (navidrome.org/docs apps list). None advertise a kew-style live spectrum. |
| **Navidrome's own web UI** | React PWA | Already installable (standalone manifest + Workbox SW). No visualiser. |

**What a "kew-like visualiser" app adds that these don't:** a *foreground, immersive, spectrum-driven*
now-playing screen with album-art-derived themes — the exact aesthetic that exists on the terminal (kew)
and, on desktop, in Tonearm — but **nobody has shipped it as a phone app**. That is the niche.

---

## 6. Recommendation, risks, smallest architecture

### The call
**PWA-first, Capacitor-wrapped.** One TypeScript web codebase; deploy it as a PWA; `npx cap` it into an
Android APK (system WebView) and an iOS IPA. This is the smallest architecture that emits all three
artifacts, and it keeps you out of Swift/Kotlin entirely until/unless a native audio plugin is needed.

### Smallest architecture that still delivers APK + IPA + PWA
- **Frontend:** one web app (React/Svelte/vanilla — your choice), installable PWA (manifest +
  service worker), Media Session wired for lock-screen controls.
- **Server side:** reverse-proxy **Navilite and Navidrome behind one origin** (Caddy/nginx/Tailscale
  Funnel). This single decision makes the AnalyserNode spectrum work (same-origin) and removes all CORS
  handling. No extra app server required beyond a static host + the proxy.
- **Audio:** `<audio>` element + `MediaElementAudioSource → AnalyserNode` for the foreground spectrum;
  procedural/album-art fallback otherwise.
- **Capacitor plugins (only two you truly need):** a **native audio** plugin for reliable background +
  lock-screen playback on the APK/IPA (`@capgo/capacitor-native-audio`: background playback, iOS
  `showNotification` Now-Playing, Android foreground-service media notification, ExoPlayer/AVFoundation
  under the hood), and secure-storage for the credential.
- **Distribution:** PWA = home-screen install (free, instant); APK = sideload or Play TWA if you want a
  listing; IPA = **AltStore/SideStore while prototyping, then $99/yr + TestFlight** for a clean install.

### The two or three risks most likely to bite
1. **iOS + real spectrum + background are mutually exclusive.** Web Audio doesn't survive iOS
   backgrounding (flutter_soloud #489, Jun 2026). Mitigation: foreground = real spectrum, background =
   procedural/album-art; or ship a native-tap visualiser in the Capacitor iOS plugin (real cost).
2. **CORS/same-origin, if you skip the proxy.** Without one origin, `/rest/stream` returns no ACAO and
   the analyser silently flatlines (issue #3660; Tonearm engine.ts; MDN). Mitigation: **one origin.**
3. **iOS distribution friction.** Free = 7-day re-signing (Apple); the pleasant path is $99/yr
   (TestFlight). Do not count on the Enterprise program ($299/yr, 100+ employees — not eligible).
   Secondary: the Ionic commercial-tooling wind-down means leaning on community Capacitor plugins.

### What would change the call
- If the visualiser must be **pixel-truthful on iPhone in the background** and you accept Dart →
  **switch to Flutter** (`just_audio` + `audio_service` + a native FFT tap). Still one codebase for
  APK+IPA, plus a (weaker) web build for the PWA.
- If you drop the "APK + IPA" requirement and accept **install-from-browser only** → plain PWA, zero app
  stores, zero signing; but iOS gets no reliable background spectrum (§2.4).

---

## 7. Sources (URLs + what I verified)

Web Audio / CORS / visualiser
- MDN, `<audio>` `crossorigin` — https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/audio (page last modified 2026-07-16)
- MDN, `AnalyserNode` — https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode (modified 2026-08-22)
- StackOverflow, "MediaElementAudioSource outputs zeroes due to CORS" — https://stackoverflow.com/questions/31895610/
- Tonearm source (shipping browser client): README + DEPLOYMENT.md + `src/player/engine.ts` +
  `src/features/visualizer/analysis.ts` — https://github.com/j4ckxyz/navidrome-client-web (fetched 2026-10-10)

Navidrome
- Subsonic API compatibility (v1.16.1, endpoint list, `stream`≠played) — https://www.navidrome.org/docs/developers/subsonic-api/ (modified 2026-01-04)
- Configuration options (no CORS option; precedence; `ExtAuth.*`) — https://www.navidrome.org/docs/usage/configuration/options/ (modified 2026-09-27)
- Externalized authentication / `ExtAuth.TrustedSources` — https://www.navidrome.org/docs/usage/integration/authentication/
- Security considerations (reverse proxy, extauth) — https://www.navidrome.org/docs/usage/admin/security/
- Issue #3660 — `Access-Control-Allow-Origin` on SSE removed (commit 657fe11, 2025-01-22) — https://github.com/navidrome/navidrome/issues/3660
- Release v0.64.0 (2026-09-12; Jellyfin API behind flag; ID re-encode) — https://github.com/navidrome/navidrome/releases/tag/v0.64.0
- Web UI is a PWA (vite-plugin-pwa, standalone manifest, Workbox SW) — repo `ui/vite.config.js`, `ui/src/sw.js`, `ui/index.html`
- Client apps list (prior art) — https://www.navidrome.org/apps/

Subsonic API auth
- Subsonic API (`p=`, `t=md5(password+salt)`, `s=`) — https://www.subsonic.org/pages/api.jsp

Apple / iOS
- Developer account overview (free team: 10 App IDs/7d, 3 devices/7d, 3 apps/device, profiles 7d) — https://developer.apple.com/support/compare-memberships/
- Apple Developer Program **$99/yr**; Enterprise **$299/yr**, 100+ employees — https://developer.apple.com/programs/ and https://developer.apple.com/programs/enterprise/
- TestFlight (100 internal / 10,000 external / 100 builds; 90-day build expiry) — https://developer.apple.com/testflight/
- Web Push for Home-Screen web apps, iOS 16.4 (2023-02-16) — https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- WebKit bug 198277 — PWA background audio fixed in **iOS 15.4** — https://bugs.webkit.org/show_bug.cgi?id=198277
- `flutter_soloud` #489 (Jun–Aug 2026) — WebAudio can't do iOS background/lock-screen; native `AVAudioSessionCategory.playback` is the supported route — https://github.com/alnitak/flutter_soloud/issues/489
- MDN Media Session API (Safari iOS 15+ lock-screen support) — https://developer.mozilla.org/en-US/docs/Web/API/Media_Session_API
- iOS 26 Home-Screen web-app default (secondary) — https://www.monterail.com/blog/pwa-for-apple-ios and https://www.mobiloud.com/blog/progressive-web-apps-ios/

Android / cross-platform
- Android `Visualizer` API requires `RECORD_AUDIO` (+ `MODIFY_AUDIO_SETTINGS` for output mix) — https://developer.android.com/reference/android/media/audiofx/Visualizer
- ExoPlayer/Media3 custom `AudioProcessor` + FFT (permission-free) — https://dawn.tech/en/publication/an-alternative-android-visualizer
- Trusted Web Activity overview (Chrome 72+, Digital Asset Links) — https://developer.android.com/develop/ui/views/layout/webapps/trusted-web-activities ; https://developer.chrome.com/docs/android/trusted-web-activity
- Capacitor ("one web app → cross-platform", first-class PWA support) — https://capacitorjs.com/
- Ionic commercial products discontinued 2025; Capacitor stays OSS — https://ionic.io/blog/important-announcement-the-future-of-ionics-commercial-products
- Capacitor native background audio + Now-Playing (`@capgo/capacitor-native-audio`) — https://github.com/Cap-go/capacitor-native-audio
- kew (spectrum visualiser, album-colour themes) — https://github.com/ravachol/kew
- SubStreamer iOS size 56.3 MB — https://apps.apple.com/us/app/substreamer/id1012991665

*Unverified / secondary (flagged inline): iOS 26 Home-Screen default; cross-platform footprint MB figures
other than the 56.3 MB anchor; "many clients" claims from storefronts. Nothing here was built, installed
or changed on any machine.*
