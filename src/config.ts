/**
 * Deployment facts that must be right in one place.
 *
 * The one thing worth a module of its own is the canonical origin, because getting it
 * *nearly* right is the trap: `https://alienlab.tailbed832.ts.net` with no port is port
 * 443, a public Tailscale Funnel to a different service — not the library. The library's
 * door is on `:9443`. Any copy, default or doc line that names the server has to keep the
 * port; `test/connect-copy.test.ts` fails the build if the placeholder loses it again.
 */

/** The one origin: tailnet-only HTTPS door, app shell at `/`, Subsonic proxied to Navidrome. */
export const CANONICAL_ORIGIN = 'https://alienlab.tailbed832.ts.net:9443';

/** Placeholder for the connect form's *Server URL* field. */
export const SERVER_URL_PLACEHOLDER = `${CANONICAL_ORIGIN} (or leave blank for same origin)`;
