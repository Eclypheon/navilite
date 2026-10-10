/** Platform facts the rest of the app branches on. */
import { Capacitor } from '@capacitor/core';

export type OsName = 'ios' | 'android' | 'web';

export interface PlatformInfo {
  /** True inside the Capacitor shell (APK/IPA), false in a browser/PWA. */
  native: boolean;
  os: OsName;
  /** OS-provided secure storage is available (Keychain / Android Keystore). */
  secureStorage: boolean;
}

export function platformInfo(): PlatformInfo {
  const native = Capacitor.isNativePlatform();
  const os = Capacitor.getPlatform();
  return {
    native,
    os: os === 'ios' || os === 'android' ? os : 'web',
    secureStorage: native,
  };
}
