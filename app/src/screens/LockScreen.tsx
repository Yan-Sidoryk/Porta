import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { authenticate } from '../biometrics';
import { colors, space, type as typography } from '../theme';

interface Props {
  onUnlocked: () => void;
  onSignOut: () => void;
}

/**
 * Shown when the biometric lock is on and the app has just opened or come back
 * from the background. Prompts immediately, so the common case is a glance and
 * nothing to tap.
 *
 * There is always a way past that does not depend on the sensor: signing out
 * clears the tokens and returns to the password screen. A wet finger or a
 * broken reader must never leave someone stuck outside their own gate -- the
 * lock exists to slow down a stranger holding an unlocked phone, not to be an
 * unopenable door for the owner.
 */
export function LockScreen({ onUnlocked, onSignOut }: Props) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const prompt = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const result = await authenticate('Unlock to operate the gate');
    setBusy(false);

    if (result.ok) {
      onUnlocked();
      return;
    }
    setMessage(result.reason);
  };

  // Prompt once on mount. The ref guards against React re-running the effect
  // and stacking two native prompts on top of each other.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void prompt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, gap: space.md }}>
      <Ionicons name="lock-closed-outline" size={56} color={colors.textDim} />
      <Text style={{ ...typography.title, color: colors.text }}>Locked</Text>

      {message ? (
        <Text style={{ ...typography.body, color: colors.textDim, textAlign: 'center' }}>
          {message}
        </Text>
      ) : null}

      <Pressable
        onPress={() => { void prompt(); }}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => ({
          backgroundColor: pressed ? colors.actionPressed : colors.action,
          borderRadius: 10,
          paddingVertical: space.md,
          paddingHorizontal: space.xl,
          marginTop: space.sm,
        })}
      >
        <Text style={{ ...typography.title, color: '#1A1206' }}>Unlock</Text>
      </Pressable>

      <Pressable onPress={onSignOut} style={{ padding: space.md }}>
        <Text style={{ ...typography.small, color: colors.textDim }}>
          Sign out and use password instead
        </Text>
      </Pressable>
    </View>
  );
}
