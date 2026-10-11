/** Non-secret settings (server URL, username). */
import { normalizeServerUrl } from '../api/subsonic.ts';

export interface Settings {
  serverUrl: string;
  username: string;
}

const STORAGE_KEY = 'navilite.settings';

const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  username: '',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      serverUrl: normalizeServerUrl(parsed.serverUrl ?? ''),
      username: parsed.username ?? '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
