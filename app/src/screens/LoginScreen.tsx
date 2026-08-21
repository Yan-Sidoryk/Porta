import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Keyboard, KeyboardAvoidingView, Platform,
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

/** The mark at rest, and once the keyboard has taken the screen. */
const LOGO_LARGE = 96;
const LOGO_SMALL = 34;
const TITLE_LARGE = 44;
const TITLE_SMALL = 34;

/** Long enough to read as movement, short enough not to lag the keyboard. */
const COLLAPSE_MS = 220;

export function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  /**
   * 0 at rest, 1 once the keyboard is up. The mark starts large above the
   * fields and shrinks into the title as the keyboard takes the screen, so
   * the branding gives way to the thing being typed into rather than
   * competing with it.
   */
  const collapse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const to = (value: number) => (): void => {
      Animated.timing(collapse, {
        toValue: value,
        duration: COLLAPSE_MS,
        // Width, height and fontSize are layout properties, so this cannot run
        // on the UI thread. It is a handful of views and stays smooth.
        useNativeDriver: false,
      }).start();
    };

    // iOS reports the keyboard before it moves, so the header travels with it;
    // Android only reports it afterwards, hence the different events.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const shown = Keyboard.addListener(showEvent, to(1));
    const hidden = Keyboard.addListener(hideEvent, to(0));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [collapse]);

  const logoSize = collapse.interpolate({
    inputRange: [0, 1],
    outputRange: [LOGO_LARGE, LOGO_SMALL],
  });
  const logoRadius = collapse.interpolate({ inputRange: [0, 1], outputRange: [22, 8] });
  const titleSize = collapse.interpolate({
    inputRange: [0, 1],
    outputRange: [TITLE_LARGE, TITLE_SMALL],
  });
  const headerGap = collapse.interpolate({ inputRange: [0, 1], outputRange: [space.md, space.sm] });
  const headerSpace = collapse.interpolate({ inputRange: [0, 1], outputRange: [space.xl, 0] });

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
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
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
        <Animated.View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: headerGap,
            marginBottom: headerSpace,
          }}
        >
          <Animated.Image
            source={require('../../assets/logo.png')}
            accessibilityIgnoresInvertColors
            style={{ width: logoSize, height: logoSize, borderRadius: logoRadius }}
          />
          <Animated.Text
            style={{ fontWeight: typography.hero.fontWeight, color: colors.text, fontSize: titleSize }}
          >
            Porta
          </Animated.Text>
        </Animated.View>

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
