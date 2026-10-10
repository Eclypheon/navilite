# Decisions

Locked by the owner on 2026-10-10. Downstream work must respect these unless he changes them
(and if one turns out to be impossible, raise it — do not quietly substitute something else).

## Product

- **v1 scope**: browse the library, play, visualise — **plus playlists and favourites**.
  Offline caching is explicitly *not* in v1 (he chose "also playlists and favourites" over
  "all of the above").
- **"Visualises like kew" means a real spectrum from the actual audio stream**, not a decorative
  animation. Consequence: the player needs access to the audio samples, which for a web or
  wrapped build means either CORS-enabled streaming from Navidrome or a same-origin proxy in
  front of it. If that proves impossible on a target platform, raise it — do **not** silently
  swap in a fake visualiser.
- **Targets**: PWA + Android APK + iOS IPA, from as much shared code as possible.

## Platform / distribution

- **iOS**: no paid Apple Developer account, and he does not want to buy one now. The iPhone build
  is a **sideloaded dev build, re-signed every 7 days** (AltStore / SideStore style). Nothing may
  assume TestFlight, the App Store, or a paid certificate — including any entitlement that needs
  the paid programme.
- **Android**: sideloaded APK; no Play Store requirement stated.
- **Repository**: **public** — `Eclypheon/navilite`.

## Networking

- **The phone reaches the library over Tailscale.** Do not expose Navidrome to the public
  internet for this app. Tailnet name: `alienlab.tailbed832.ts.net`.
- Navidrome (0.64.2) is LAN-only today; making it reachable over the tailnet — and over **HTTPS**,
  which a PWA needs for a secure context (and which matters for the visualiser) — is part of the
  work. Anything host-level (Caddy, quadlets, ufw, Uptime Kuma) is **Nova's** territory: route it
  through him rather than changing the box directly.

## Ownership

- Research: **Mugger** (`researcher`) — modality verdict in flight (`t_4c24f452`).
- Implementation: **Nerd** (`nerd`).
- Host / networking changes: **Nova** (`alienlab`).

## Deferred by the owner

- Moving the iOS build onto a paid account / TestFlight.
- Offline caching of albums (past v1).
