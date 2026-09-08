import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { registerPushToken, unregisterPushToken } from './api';

/**
 * Being told when the gate has been left open.
 *
 * The BACKEND sends these, not this app. Nothing here runs while the app is
 * closed -- there is no background task and Android would not run one
 * reliably -- so the phone is only ever the destination. All this module does
 * is get a delivery address and hand it over.
 */
const ENABLED_KEY = 'gate.notifications';
const TOKEN_KEY = 'gate.pushToken';

export type Availability =
  | { available: true }
  | { available: false; reason: string };

/**
 * Banner and sound even while the app is open. The gate being left open is
 * worth interrupting for; it is the only thing this app ever sends.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Defaults to OFF, and anything other than an explicit "true" -- unset, an
 * unreadable keystore, a value from some future version -- reads as off.
 * Silence is the safe failure for a setting the user has to opt into.
 */
export async function isEnabled(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(ENABLED_KEY)) === 'true';
  } catch {
    return false;
  }
}

/**
 * Remote push needs a real build. Expo Go dropped it on Android, so in Expo Go
 * this is off with an explanation rather than a permission prompt that leads
 * nowhere.
 */
export async function checkAvailability(): Promise<Availability> {
  if (Constants.appOwnership === 'expo') {
    return {
      available: false,
      reason: 'Notifications need the installed app. Expo Go cannot receive them.',
    };
  }
  return { available: true };
}

/**
 * Asks the OS, then registers the address with the backend.
 *
 * Android 13 and later require a runtime permission, and a user who said no
 * once is never re-prompted by the system -- `requestPermissionsAsync` simply
 * returns denied. So a refusal is reported back for the settings row to
 * explain, rather than silently leaving a switch on that does nothing.
 */
export async function enable(): Promise<Availability> {
  const availability = await checkAvailability();
  if (!availability.available) return availability;

  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted
    || (await Notifications.requestPermissionsAsync()).granted;

  if (!granted) {
    return {
      available: false,
      reason: 'Notifications are turned off for Porta in system settings.',
    };
  }

  if (Platform.OS === 'android') {
    // Without a channel Android silences everything on 8.0+, and the default
    // channel it invents cannot be given a sound or an importance later.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Gate alerts',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  if (projectId === undefined) {
    return { available: false, reason: 'This build is missing its Expo project id.' };
  }

  const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
  if (!(await registerPushToken(token))) {
    return { available: false, reason: 'Could not reach the gate service. Try again.' };
  }

  // Remembered so sign-out and disabling can unregister the exact token,
  // rather than having to ask the OS for it again at a moment when the
  // permission may already be gone.
  await SecureStore.setItemAsync(TOKEN_KEY, token);
  await SecureStore.setItemAsync(ENABLED_KEY, 'true');
  return { available: true };
}

/**
 * Turning it off, and also what sign-out calls.
 *
 * The local flag is cleared FIRST and unconditionally: if the network call
 * fails, the switch must still end up off. A phone that keeps its own setting
 * on while the server has stopped sending is the confusing half of the two
 * failure modes -- the other way round is merely a stale row, which the
 * backend drops the moment the app is uninstalled.
 */
export async function disable(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  await SecureStore.deleteItemAsync(ENABLED_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => {});
  if (token !== null) await unregisterPushToken(token);
}
