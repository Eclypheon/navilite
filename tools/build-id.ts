/**
 * A build id for cache busting: the git commit when available, else a timestamp.
 * Used by the service worker stamp in vite.config.ts and by the app's About line.
 */
import { execFileSync } from 'node:child_process';

export function buildId(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return String(Date.now());
  }
}
