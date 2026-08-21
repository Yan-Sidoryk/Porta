import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, SafeAreaView, StatusBar, View } from 'react-native';
import { clearTokens, getAccessToken } from './src/session';
import { isLockEnabled } from './src/biometrics';
import { shouldRelock } from './src/gate-machine';
import { LoginScreen } from './src/screens/LoginScreen';
import { GateScreen } from './src/screens/GateScreen';
import { LockScreen } from './src/screens/LockScreen';
import { colors } from './src/theme';

type Shell = 'restoring' | 'signed-out' | 'locked' | 'signed-in';

export default function App() {
  const [shell, setShell] = useState<Shell>('restoring');

  /** When the app last went to the background, or null while in front. */
  const backgroundedAt = useRef<number | null>(null);

  /**
   * Session restore, then the lock.
   *
   * Tokens already live in the keystore, so a returning user goes straight
   * through -- re-typing a password while standing at a gate in the rain is
   * not a security feature.
   *
   * Only the PRESENCE of a token is checked, never its validity. An expired
   * one is handled where it surfaces: api.ts refreshes once on a 401 and the
   * screens sign out if that fails. Validating here would put a network round
   * trip in front of the first frame.
   */
  useEffect(() => {
    void (async () => {
      try {
        const token = await getAccessToken();
        if (!token) { setShell('signed-out'); return; }
        setShell((await isLockEnabled()) ? 'locked' : 'signed-in');
      } catch {
        setShell('signed-out');
      }
    })();
  }, []);

  /**
   * Re-lock on returning from the background.
   *
   * Locking only on a cold start would make the lock theatre: phone apps are
   * almost never killed, so it would sit unlocked in the app switcher
   * indefinitely. The grace period keeps a quick glance at another app from
   * demanding a fingerprint on the way back.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        backgroundedAt.current ??= Date.now();
        return;
      }

      if (next === 'active') {
        const wasAway = backgroundedAt.current;
        backgroundedAt.current = null;
        if (!shouldRelock(wasAway, Date.now())) return;

        setShell((current) => (current === 'signed-in' ? 'locked' : current));
        void isLockEnabled().then((on) => {
          // The lock may have been switched off while away; do not strand them.
          if (!on) setShell((current) => (current === 'locked' ? 'signed-in' : current));
        });
      }
    });
    return () => subscription.remove();
  }, []);

  const onSignedOut = useCallback(() => setShell('signed-out'), []);
  const onSignedIn = useCallback(() => setShell('signed-in'), []);
  const onUnlocked = useCallback(() => setShell('signed-in'), []);

  /**
   * The escape hatch from the lock screen, and it must actually clear the
   * tokens. Merely showing the login screen would leave them in the keystore,
   * so the next launch would find a token and lock again -- trapping someone
   * whose sensor has stopped working in a loop with no way out.
   */
  const onSignOutFromLock = useCallback(() => {
    void clearTokens().finally(() => setShell('signed-out'));
  }, []);

  return (
    // Forced dark, deliberately not following the system theme: one
    // appearance, always, so the screen is never a surprise at night.
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      {shell === 'restoring' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textDim} />
        </View>
      ) : shell === 'locked' ? (
        <LockScreen onUnlocked={onUnlocked} onSignOut={onSignOutFromLock} />
      ) : shell === 'signed-in' ? (
        <GateScreen onSignedOut={onSignedOut} />
      ) : (
        <LoginScreen onSignedIn={onSignedIn} />
      )}
    </SafeAreaView>
  );
}
