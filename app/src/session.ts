import * as SecureStore from 'expo-secure-store';

/**
 * expo-secure-store, never AsyncStorage.
 *
 * AsyncStorage is an unencrypted file on disk that any process with the app's
 * sandbox can read, and on a rooted or jailbroken device that is anyone.
 * These two strings open a gate. SecureStore is the iOS keychain and the
 * Android keystore, which is where they belong.
 */
const ACCESS_KEY = 'gate.accessToken';
const REFRESH_KEY = 'gate.refreshToken';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export async function saveTokens(tokens: Tokens): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken);
}

export const getAccessToken = (): Promise<string | null> => SecureStore.getItemAsync(ACCESS_KEY);

export const getRefreshToken = (): Promise<string | null> => SecureStore.getItemAsync(REFRESH_KEY);

export async function clearTokens(): Promise<void> {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}
