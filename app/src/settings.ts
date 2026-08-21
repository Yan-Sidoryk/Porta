import * as SecureStore from 'expo-secure-store';

const CLOCK_KEY = 'porta.use24h';

/**
 * Display preferences. SecureStore rather than a second storage library --
 * these are not secrets, but the keystore is already here and one dependency
 * is better than two.
 */

/**
 * 24-hour is the default and anything other than an explicit "false" reads as
 * 24-hour, so an unreadable store falls back to it rather than to nothing.
 * It is unambiguous in an audit log, where "7:15" appearing twice a day is a
 * genuine problem when you are working out who opened the gate.
 */
export async function getUse24h(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(CLOCK_KEY)) !== 'false';
  } catch {
    return true;
  }
}

export async function setUse24h(use24h: boolean): Promise<void> {
  await SecureStore.setItemAsync(CLOCK_KEY, use24h ? 'true' : 'false');
}
