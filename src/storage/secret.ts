/**
 * Where the Subsonic password lives.
 *
 * In the wrapped builds this is the OS keystore (iOS Keychain / Android
 * EncryptedSharedPreferences via @aparajita/capacitor-secure-storage). In a plain
 * PWA there is no such thing and we fall back to localStorage — which is honest but
 * weaker, so `secure` is reported to the UI and shown to the user rather than
 * quietly pretended away.
 */
import type { OsName } from '../platform.ts';

export type SecretBackend = 'keychain' | 'android-keystore' | 'web-storage';

export interface SecretStore {
  backend: SecretBackend;
  /** False means the OS is not protecting this value. The UI says so. */
  secure: boolean;
  description: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const PREFIX = 'navilite.';

export function webSecretStore(): SecretStore {
  return {
    backend: 'web-storage',
    secure: false,
    description: 'Web storage — this build has no OS keystore to use',
    async get(key) {
      return localStorage.getItem(PREFIX + key);
    },
    async set(key, value) {
      localStorage.setItem(PREFIX + key, value);
    },
    async remove(key) {
      localStorage.removeItem(PREFIX + key);
    },
  };
}

export async function createSecretStore(os: OsName): Promise<SecretStore> {
  if (os === 'web') return webSecretStore();
  try {
    // Imported lazily: in a browser this plugin is dead weight, and it is only
    // meaningful inside the native shell.
    const { SecureStorage } = await import('@aparajita/capacitor-secure-storage');
    await SecureStorage.setKeyPrefix(PREFIX);
    return {
      backend: os === 'ios' ? 'keychain' : 'android-keystore',
      secure: true,
      description: os === 'ios' ? 'iOS Keychain' : 'Android EncryptedSharedPreferences (AES-GCM, Android Keystore key)',
      get: (key) => SecureStorage.get(key).then((value) => (typeof value === 'string' ? value : null)),
      set: (key, value) => SecureStorage.set(key, value),
      remove: (key) => SecureStorage.remove(key).then(() => undefined),
    };
  } catch (error) {
    console.warn('[navilite] secure storage unavailable, falling back to web storage', error);
    const fallback = webSecretStore();
    return { ...fallback, description: `${fallback.description} (keystore plugin unavailable)` };
  }
}
