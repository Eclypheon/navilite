/** Non-secret settings (server URL, username, playback preferences). */
import { normalizeServerUrl } from '../api/subsonic.ts';

/** `auto` = real spectrum while in the foreground, native engine in the background. */
export type PlaybackPreference = 'auto' | 'web' | 'native';

export interface Settings {
  serverUrl: string;
  username: string;
  playback: PlaybackPreference;
}

const STORAGE_KEY = 'navilite.settings';

const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  username: '',
  playback: 'auto',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      serverUrl: normalizeServerUrl(parsed.serverUrl ?? ''),
      username: parsed.username ?? '',
      playback: parsed.playback === 'web' || parsed.playback === 'native' ? parsed.playback : 'auto',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
