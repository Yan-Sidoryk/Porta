import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Animated, Image, Keyboard, Platform,
  Pressable, ScrollView, Text, TextInput, View,
  type LayoutChangeEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { login } from '../api';
import { colors, space, type as typography } from '../theme';

interface Props {
  onSignedIn: () => void;
}

/**
 * Clear air between the bottom of the form and the top of the keyboard. Big
 * enough that the sign-in button is not sitting on the keys -- a form pressed
 * right up against them reads as cramped even when nothing is covered.
 */
const KEYBOARD_GAP = 110;

/** The form never rises past this, so the logo cannot be pushed off-screen. */
const MIN_TOP_GAP = 24;

/** Matches the gate screen, so the mark does not resize between the two. */
const LOGO_SIZE = 34;

/** Android reports no keyboard duration, so it needs a sensible one. */
const LIFT_MS = 260;

export function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reveal, setReveal] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  /**
   * The form is lifted by an animation this screen owns, rather than by
   * KeyboardAvoidingView.
   *
   * That component works by resizing or padding its container, so the centred
   * content re-centres in one layout pass -- which is the jump. Here the
   * viewport height is frozen at its first measurement, so the container never
   * re-centres, and the only thing that moves is a transform. Transforms run
   * on the native driver, so the lift is genuinely smooth rather than a series
   * of layout passes.
   */
  const lift = useRef(new Animated.Value(0)).current;

  /** Frozen at rest: the keyboard resizes this view on Android. */
  const viewport = useRef(0);
  const formHeight = useRef(0);
  const [frozenViewport, setFrozenViewport] = useState(0);

  const measureViewport = (event: LayoutChangeEvent): void => {
    const { height } = event.nativeEvent.layout;
    if (viewport.current === 0 && height > 0) {
      viewport.current = height;
      setFrozenViewport(height);
    }
  };

  const measureForm = (event: LayoutChangeEvent): void => {
    formHeight.current = event.nativeEvent.layout.height;
  };

  useEffect(() => {
    const animate = (toValue: number, duration: number): void => {
      Animated.timing(lift, {
        toValue,
        duration: duration > 0 ? duration : LIFT_MS,
        useNativeDriver: true,
      }).start();
    };

    // iOS reports the keyboard before it moves, so the form travels with it.
    // Android only reports it afterwards, hence the different events.
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const shown = Keyboard.addListener(showEvent, (event) => {
      if (viewport.current === 0) return;

      // The form is centred, so it sits half its height either side of the
      // middle. Lift only by however much the keyboard actually covers.
      const formTop = (viewport.current - formHeight.current) / 2;
      const formBottom = formTop + formHeight.current;
      const keyboardTop = viewport.current - event.endCoordinates.height;
      const overlap = Math.max(0, formBottom + KEYBOARD_GAP - keyboardTop);

      // Capped so the top of the form stays on screen. On a short phone the
      // keyboard can cover more than there is room to rise, and without this
      // the logo would be dragged off the top edge.
      const headroom = Math.max(0, formTop - MIN_TOP_GAP);

      animate(-Math.min(overlap, headroom), event.duration ?? 0);
    });

    const hidden = Keyboard.addListener(hideEvent, (event) => {
      animate(0, event.duration ?? 0);
    });

    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [lift]);

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
    <ScrollView
      style={{ flex: 1 }}
      onLayout={measureViewport}
      contentContainerStyle={{
        // The FROZEN height, not flexGrow. If this tracked the live height,
        // the keyboard resizing the window would re-centre the form in a
        // single layout pass -- exactly the jump being removed.
        minHeight: frozenViewport || undefined,
        justifyContent: 'center',
        padding: space.lg,
        gap: space.md,
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      showsVerticalScrollIndicator={false}
    >
      <Animated.View
        onLayout={measureForm}
        style={{ gap: space.md, transform: [{ translateY: lift }] }}
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
      </Animated.View>
    </ScrollView>
  );
}
