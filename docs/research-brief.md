# Research: the right modality for "Navilite" — a lightweight mobile client for a self-hosted music library

The user wants a **new app called Navilite**: a *very lightweight* music player for his **own**
music library that **visualises like kew** (his macOS TUI player). He wants an **APK, an IPA and a
PWA**, and he has explicitly asked *"let me know if a PWA or native mobile app is better for this
purpose"*. **He wants the research and his clarifying answers BEFORE any code is written** — so the
deliverable is a recommendation with evidence, not a plan to start building.

## His environment (facts, verified)
- **Navidrome 0.64.2** on a home server (`alienlab`), LAN URL `navidrome.alienlab.home.arpa`,
  library ~400 tracks, container `navidrome`, data in sqlite.
- Remote reachability today: a **Tailscale tailnet** (`alienlab.tailbed832.ts.net`) with a
  **Tailscale Funnel on port 10000** already used for another service. Navidrome itself is
  **LAN-only** right now.
- **kew** = his macOS terminal player (Homebrew, `kew 4.3.8`); it renders spectrum/visualiser
  output while playing. "Visualises like kew" is the product hook.
- Fleet has a **Gitea-less** setup: GitHub via `gh`, private + public repos both in use.
- His phone platform: **iPhone and/or Android — treat both as required**, which is why he asked
  for both an IPA and an APK.

## Questions to answer, with sources
1. **PWA vs native vs hybrid — what actually fits "very lightweight" here?** Compare honestly:
   PWA + a wrapper (Capacitor / TWA / PWABuilder) vs React Native / Expo vs Flutter vs Kotlin
   Multiplatform vs fully separate native. Weight it for: install footprint, background audio,
   lock-screen/now-playing controls, offline caching, and how much of the *same* code can yield
   all three of APK + IPA + PWA.
2. **The visualiser is the hard part.** Can a web app drive a real audio spectrum from a
   **streamed, cross-origin** source? Establish precisely:
   - what Web Audio's `AnalyserNode` requires when the audio is an `<audio>` element pointed at a
     **remote** URL (CORS: `crossOrigin="anonymous"`, `Access-Control-Allow-Origin` on the stream);
   - what **Navidrome actually sends by default**, and whether its CORS behaviour is configurable
     (`ND_CORSALLOWEDORIGINS`, `ND_REVERSEPROXYWHITELIST`, or Subsonic-specific settings) — cite
     Navidrome docs/config reference, not a blog;
   - whether a same-origin proxy is therefore required for a PWA visualiser, and what the native
     equivalent costs (ExoPlayer/AVAudioEngine + FFT).
   If a real-audio visualiser is impractical in a PWA, say so plainly and describe the fallback
   (procedural/album-art-driven animation) and its cost in fidelity.
3. **IPA reality check.** What is genuinely required to install an iOS build in 2026 without
   hand-waving: paid Apple Developer Programme vs free provisioning (7-day expiry), AltStore /
   SideStore / Sideloadly, TestFlight, enterprise certs, and what a PWA can do on iOS instead
   (Add to Home Screen, Web Push availability, background audio behaviour on iOS Safari).
   Be blunt about what is *not* possible.
4. **Talking to the library.** Which Navidrome APIs a client should use: the **Subsonic API**
   (which version/endpoints: `stream`, `getCoverArt`, `getPlaylists`, `scrobble`, `star`,
   `search3`), Navidrome's own native API, auth methods (Subsonic token+salt vs plain password),
   and whether the Subsonic API is on by default in 0.64.2. Also: how a client should authenticate
   for a **single user** (his own account) and how to avoid shipping credentials in the binary.
5. **Prior art worth naming** (with links): existing lightweight Navidrome/Subsonic clients
   (e.g. substreamer, Feishin, Symfonium, Tempo, Sonixd, Airsonic clients), what they weigh, what
   they do well, and what a "kew-like visualiser" app would add that they don't.
6. **Recommendation.** One clear answer to *"PWA or native, for this purpose?"* — including the
   trade-off table, the two or three risks most likely to bite, and the smallest architecture that
   still delivers APK + IPA + PWA from one codebase.

## Rules
- **Chronology matters**: say what is true now (2026), not what was true in 2022 — check dates on
  everything you cite, especially Apple's sideloading and iOS PWA behaviour, which both changed.
- Cite a real source per claim (official docs first: Navidrome docs, Apple/MDN, Capacitor/PWABuilder).
  If sources conflict, say so.
- **No code, no repo, no downloads, no changes on any machine.** Research and report only.
- Write it as a decision document — concise bullets, not an essay; the user wants to make a call.
