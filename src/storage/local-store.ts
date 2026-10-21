/**
 * Is web storage usable in this build?
 *
 * Three modules persist there — the resume snapshot, the offline mirror and the lyrics cache — and
 * each used to write a probe key and delete it again. One probe, one answer: `null` means private
 * mode, a disabled store, or a runtime with no `localStorage`, and the caller keeps its own no-op
 * fallback (a cache that keeps nothing is not a playback failure).
 */
export function availableLocalStorage(probe: string): Storage | null {
  try {
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
}
