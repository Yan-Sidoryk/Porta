import { useRef, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView,
  Pressable, ScrollView, Text, TextInput, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { login } from '../api';
import { colors, space, type as typography } from '../theme';

interface Props {
  onSignedIn: () => void;
}

/** Breathing room between the focused field and the top of the keyboard. */
const KEYBOARD_GAP = 48;

/** Matches the gate screen, so the mark does not resize between the two. */
const LOGO_SIZE = 34;

export function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  const submit = async (): Promise<void> => {
    if (busy || !email.trim() || !password) return;
    setBusy(true);
    setError('');

    const result = await login(email.trim(), password);
    setBusy(false);

    if (result.ok) {
      setPassword('');
      setReveal(false);
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
    // Lifts the form clear of the keyboard rather than letting it cover the
    // field being typed into. The ScrollView inside is what gives the extra
    // gap: without it the focused input sits flush against the keyboard.
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // 'padding' on both platforms, not 'height' on Android. Height resizes
      // the container in a single step, which is what made the fields appear
      // to teleport; padding is animated with the keyboard's own duration.
      behavior="padding"
      keyboardVerticalOffset={0}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'center',
          padding: space.lg,
          paddingBottom: space.lg + KEYBOARD_GAP,
          gap: space.md,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* Same size and arrangement as the gate screen, so the mark does not
            jump when signing in. */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Image
            source={require('../../assets/logo.png')}
            accessibilityIgnoresInvertColors
            style={{ width: LOGO_SIZE, height: LOGO_SIZE, borderRadius: 8 }}
          />
          <Text style={{ ...typography.hero, color: colors.text }}>Porta</Text>
        </View>

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
          // Enter moves to the password rather than dismissing the keyboard.
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => passwordRef.current?.focus()}
          style={field}
        />

        <View style={{ justifyContent: 'center' }}>
          <TextInput
            ref={passwordRef}
            placeholder="password"
            placeholderTextColor={colors.textDim}
            value={password}
            onChangeText={setPassword}
            secureTextEntry={!reveal}
            autoCapitalize="none"
            autoCorrect={false}
            textContentType="password"
            // Enter here is the same as pressing Sign in.
            returnKeyType="go"
            onSubmitEditing={() => { void submit(); }}
            style={{ ...field, paddingRight: 52 }}
          />
          <Pressable
            onPress={() => setReveal((shown) => !shown)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
            style={{ position: 'absolute', right: space.md, padding: space.xs }}
          >
            <Ionicons
              name={reveal ? 'eye-off-outline' : 'eye-outline'}
              size={22}
              color={colors.textDim}
            />
          </Pressable>
        </View>

        {error ? (
          <Text style={{ ...typography.body, color: colors.danger }}>{error}</Text>
        ) : null}

        <Pressable
          onPress={() => { void submit(); }}
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
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
