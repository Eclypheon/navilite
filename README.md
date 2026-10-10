# Navilite

A deliberately **lightweight** music player for a self-hosted **Navidrome** library, with
**kew-style audio visualisation** — built for his own library, not for streaming services.

Targets, in one codebase where possible: **PWA**, **Android APK**, **iOS IPA**.

## Status

Discovery. No application code yet — by design:

- Modality research (PWA vs native vs hybrid, real-audio visualisation feasibility, iOS IPA
  constraints, Navidrome API surface) is with **Mugger** (research).
- Owner's decisions are **locked** in [DECISIONS.md](DECISIONS.md): public repo, sideloaded iOS
  (no paid Apple account), Tailscale-only networking, a **real audio spectrum** for the visualiser,
  and playlists + favourites in v1.
- Implementation owner once decided: **Nerd** (`nerd`).

## Environment it must talk to

- **Navidrome 0.64.2** on a home server; LAN `navidrome.alienlab.home.arpa`, library ~400 tracks.
- Remote access today: **Tailscale tailnet** (`alienlab.tailbed832.ts.net`), with a Funnel already
  publishing another service on port 10000. Navidrome itself is LAN-only as of the day this was
  written.
- The reference player is **kew** (macOS TUI, `kew 4.3.8`); its visualiser is the product hook.

## Non-goals

- No streaming-service integration, no social features, no library management/editing.
- Not a fork of an existing client; if an existing app already does this, say so and stop.
