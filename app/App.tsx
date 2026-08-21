import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, SafeAreaView, StatusBar, View } from 'react-native';
import { getAccessToken } from './src/session';
import { LoginScreen } from './src/screens/LoginScreen';
import { GateScreen } from './src/screens/GateScreen';
import { colors } from './src/theme';

type Shell = 'restoring' | 'signed-out' | 'signed-in';

export default function App() {
  const [shell, setShell] = useState<Shell>('restoring');

  /**
   * Session restore. Tokens already live in the keystore, so a returning user
   * goes straight to the gate -- re-typing a password while standing at a gate
   * in the rain is not a security feature.
   *
   * Only the presence of a token is checked here, not its validity. An expired
   * access token is handled where it surfaces: api.ts refreshes once on a 401,
   * and the screens sign out if that fails. Validating up front would mean a
   * network round trip before the first frame.
   */
  useEffect(() => {
    void getAccessToken()
      .then((token) => setShell(token ? 'signed-in' : 'signed-out'))
      .catch(() => setShell('signed-out'));
  }, []);

  const onSignedOut = useCallback(() => setShell('signed-out'), []);
  const onSignedIn = useCallback(() => setShell('signed-in'), []);

  return (
    // Forced dark, deliberately not following the system theme: one
    // appearance, always, so the screen is never a surprise at night.
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      {shell === 'restoring' ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.textDim} />
        </View>
      ) : shell === 'signed-in' ? (
        <GateScreen onSignedOut={onSignedOut} />
      ) : (
        <LoginScreen onSignedIn={onSignedIn} />
      )}
    </SafeAreaView>
  );
}
