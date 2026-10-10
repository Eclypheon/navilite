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
- **The canonical origin is `https://alienlab.tailbed832.ts.net:9443`** — tailnet-only, HTTPS on
  the node's publicly trusted Let's Encrypt certificate, one origin serving this app's `dist/` with
  `/rest`, `/api`, `/auth`, `/share` proxied to Navidrome. A PWA installs from it with nothing to
  install on the phone (publicly trusted cert, so Android's user-CA restriction does not apply).
- **Port 443 is not it.** `https://alienlab.tailbed832.ts.net` with no port is a **public
  Tailscale Funnel to a different service (wizarr)**. The port is part of the address; a server URL
  without it is wrong.
- Navidrome (0.64.2) was LAN-only; the tailnet HTTPS door above is now deployed
  (`tailscale serve --bg --https=9443 http://127.0.0.1:5702` → Caddy → navidrome:4533). Anything
  host-level (Caddy, quadlets, ufw, Uptime Kuma) is **Nova's** territory: route it through him
  rather than changing the box directly.

## Verified on his instance — contradicts the research brief on one point

Measured 2026-10-10 on Navidrome **0.64.2 as configured here**, with an `Origin` header set (i.e. the
exact situation a browser or a Capacitor webview is in):

```
$ curl -D - -H "Origin: https://navilite.example" \
    http://127.0.0.1:4533/rest/stream.view?id=1&u=x&t=x&s=x&v=1.16.1&c=navilite
HTTP/1.1 200 OK
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: X-Content-Duration, X-Total-Count, X-Nd-Authorization
Vary: Origin
```

`Access-Control-Allow-Origin: *` is present on **`/rest/stream`**, on `/rest/ping.view`, and on `/`.
The research document's claim that Navidrome "does not send ACAO on `/rest/*` by default" is **wrong
for this instance** (it matches the hedging in the client it cites — the stream endpoint *often*
doesn't, not *never*).

**Consequences for the build:**

- The same-origin proxy is still the right design (one URL, no CORS class of bugs, cleaner TLS), but
  it is **not** the hard blocker the research implied. A real-spectrum `AnalyserNode` is not
  precluded here on CORS grounds.
- The header set is **version- and config-dependent**: re-measure after any Navidrome upgrade before
  relying on it, and keep the same-origin deployment as the thing that makes the question moot.
- Note `Vary: Origin` — whatever emits this is a real CORS middleware, not an accident.

## Ownership

- Research: **Mugger** (`researcher`) — modality verdict in flight (`t_4c24f452`).
- Implementation: **Nerd** (`nerd`).
- Host / networking changes: **Nova** (`alienlab`).

## Deferred by the owner

- Moving the iOS build onto a paid account / TestFlight.
- Offline caching of albums (past v1).
