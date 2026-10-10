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

/**
 * What the *Server URL* field falls back to when it is left blank (v1.1). A blank field
 * used to mean "same origin as this app"; the owner asked for it to mean his library
 * instead, so that a fresh install connects without typing anything.
 */
export const DEFAULT_SERVER_URL = CANONICAL_ORIGIN;

/** Placeholder for the connect form's *Server URL* field. */
export const SERVER_URL_PLACEHOLDER = `${CANONICAL_ORIGIN} (leave blank to use this)`;
