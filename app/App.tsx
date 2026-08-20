import { useRef, useState } from 'react';
import { Button, ScrollView, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Crypto from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { baseUrl, getStatus, login, logout, trigger, NETWORK_UNREACHABLE } from './src/api';

/**
 * The throwaway slice from Task 12 of the build plan: enough screen to prove
 * login, trigger and cooldown work over the wire from a physical phone. The
 * real UI is milestone 6 -- deliberately no styling work here.
 */
export default function App() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState('');

  /**
   * One UUID per user-initiated tap, held until that tap gets a definite
   * answer. A network failure is not an answer -- the pulse may well have
   * fired -- so the next press reuses the key and the backend replays the
   * original result instead of sending a second pulse.
   */
  const tapKey = useRef<string | null>(null);

  const show = (value: unknown): void => setResult(JSON.stringify(value, null, 2));

  const onLogin = async (): Promise<void> => {
    setBusy(true);
    const outcome = await login(email.trim(), password);
    setBusy(false);
    show(outcome);
    if (outcome.ok) {
      setLoggedIn(true);
      setPassword('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const onTrigger = async (): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    tapKey.current ??= Crypto.randomUUID();

    setBusy(true);
    const outcome = await trigger(tapKey.current);
    setBusy(false);
    show(outcome);

    // Anything the backend actually answered ends this tap, including a
    // rejection. Only an unreachable backend keeps the key alive for a retry.
    if (outcome.ok || outcome.code !== NETWORK_UNREACHABLE) tapKey.current = null;

    await Haptics.notificationAsync(
      outcome.ok ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Error,
    );
  };

  const onStatus = async (): Promise<void> => {
    setBusy(true);
    show(await getStatus());
    setBusy(false);
  };

  const onLogout = async (): Promise<void> => {
    await logout();
    setLoggedIn(false);
    setResult('');
  };

  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 72, gap: 12 }}>
      <StatusBar style="auto" />
      <Text>backend: {baseUrl()}</Text>

      {loggedIn ? (
        <>
          <Button title="Open / close gate" onPress={onTrigger} disabled={busy} />
          <Button title="Check status" onPress={onStatus} disabled={busy} />
          <Button title="Log out" onPress={onLogout} disabled={busy} />
        </>
      ) : (
        <>
          <TextInput
            placeholder="email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            style={{ borderWidth: 1, padding: 8 }}
          />
          <TextInput
            placeholder="password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            style={{ borderWidth: 1, padding: 8 }}
          />
          <Button title="Log in" onPress={onLogin} disabled={busy} />
        </>
      )}

      <ScrollView>
        <Text selectable style={{ fontFamily: 'monospace' }}>
          {result}
        </Text>
      </ScrollView>
    </View>
  );
}
