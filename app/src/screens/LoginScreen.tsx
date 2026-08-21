import { useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { login } from '../api';
import { colors, space, type as typography } from '../theme';

interface Props {
  onSignedIn: () => void;
}

export function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError('');

    const result = await login(email.trim(), password);
    setBusy(false);

    if (result.ok) {
      setPassword('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSignedIn();
      return;
    }
    // The backend answers an unknown email exactly as it answers a wrong
    // password, so there is nothing more specific that could honestly be said.
    setError(result.message);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  };

  const field = {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    padding: space.md,
    color: colors.text,
    ...typography.body,
  } as const;

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: space.lg, gap: space.md }}>
      <Text style={{ ...typography.hero, color: colors.text }}>Gate</Text>
      <Text style={{ ...typography.small, color: colors.textDim, marginBottom: space.md }}>
        Sign in to operate the gate.
      </Text>

      <TextInput
        placeholder="email"
        placeholderTextColor={colors.textDim}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="username"
        style={field}
      />
      <TextInput
        placeholder="password"
        placeholderTextColor={colors.textDim}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        textContentType="password"
        onSubmitEditing={submit}
        style={field}
      />

      {error ? (
        <Text style={{ ...typography.body, color: colors.danger }}>{error}</Text>
      ) : null}

      <Pressable
        onPress={submit}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => ({
          backgroundColor: busy ? colors.actionDisabled : pressed ? colors.actionPressed : colors.action,
          borderRadius: 10,
          padding: space.md,
          alignItems: 'center',
          marginTop: space.sm,
        })}
      >
        {busy
          ? <ActivityIndicator color={colors.textDim} />
          : <Text style={{ ...typography.title, color: '#1A1206' }}>Sign in</Text>}
      </Pressable>
    </View>
  );
}
