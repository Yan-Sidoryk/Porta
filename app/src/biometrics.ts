import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

/**
 * The device unlock, reused as an app lock.
 *
 * This is NOT a second factor against the backend -- the server only ever
 * sees an access token, and this check happens entirely on the phone. What it
 * buys is narrow and worth stating plainly: it stops someone holding your
 * ALREADY-UNLOCKED phone from opening your gate. That is the whole threat
 * model, which is why it defaults to off.
 */
const ENABLED_KEY = 'gate.biometricLock';

export type Availability =
  | { available: true; label: string }
  | { available: false; reason: string };

export async function checkAvailability(): Promise<Availability> {
  if (!(await LocalAuthentication.hasHardwareAsync())) {
    return { available: false, reason: 'This device has no fingerprint or face sensor.' };
  }
  if (!(await LocalAuthentication.isEnrolledAsync())) {
    return {
      available: false,
      reason: 'No fingerprint or face is set up on this device yet. Add one in system settings first.',
    };
  }

  const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
  const label = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
    ? 'Face unlock'
    : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
      ? 'Fingerprint unlock'
      : 'Biometric unlock';

  return { available: true, label };
}

/**
 * Defaults to OFF. Anything other than an explicit "true" -- unset, unreadable
 * keystore, a value from some future version -- leaves the lock disabled,
 * so a storage failure can never strand someone outside their own gate.
 */
export async function isLockEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ENABLED_KEY)) === 'true';
  } catch {
    return false;
  }
}

export async function setLockEnabled(enabled: boolean): Promise<void> {
  await SecureStore.setItemAsync(ENABLED_KEY, enabled ? 'true' : 'false');
}

export type AuthOutcome =
  | { ok: true }
  | { ok: false; reason: string; canRetry: boolean };

const REASONS: Record<string, { reason: string; canRetry: boolean }> = {
  user_cancel: { reason: 'Unlock cancelled.', canRetry: true },
  system_cancel: { reason: 'Unlock was interrupted.', canRetry: true },
  app_cancel: { reason: 'Unlock was interrupted.', canRetry: true },
  authentication_failed: { reason: 'Not recognised.', canRetry: true },
  lockout: { reason: 'Too many attempts. Wait a moment, or sign out and use your password.', canRetry: false },
  not_enrolled: { reason: 'No fingerprint or face is set up on this device.', canRetry: false },
  not_available: { reason: 'This device cannot do biometric unlock.', canRetry: false },
  passcode_not_set: { reason: 'Set a device passcode first.', canRetry: false },
};

export async function authenticate(promptMessage: string): Promise<AuthOutcome> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    cancelLabel: 'Cancel',
    // Device passcode stays available as a fallback. A failed sensor -- wet
    // fingers, a mask, a cracked screen -- must not lock someone out of their
    // own gate, and the passcode still proves it is the phone's owner.
    disableDeviceFallback: false,
  });

  if (result.success) return { ok: true };

  const known = REASONS[result.error];
  return known
    ? { ok: false, ...known }
    : { ok: false, reason: 'Could not unlock.', canRetry: true };
}
