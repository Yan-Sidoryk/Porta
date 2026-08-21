import { Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons } from '@expo/vector-icons';
import { colors, space, type as typography } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  biometricOn: boolean;
  /** Why the toggle is unavailable, shown under it. */
  biometricBlockedReason: string | null;
  busy: boolean;
  onToggleBiometric: (next: boolean) => void;
  use24h: boolean;
  onToggle24h: (next: boolean) => void;
  onSignOut: () => void;
}

/**
 * The overflow menu behind the three dots.
 *
 * A Modal rather than an absolutely positioned view: it takes the Android
 * back button and traps touches for free, so tapping anywhere outside closes
 * it. No navigation library involved.
 */
export function SettingsMenu({
  visible, onClose, biometricOn, biometricBlockedReason,
  busy, onToggleBiometric, use24h, onToggle24h, onSignOut,
}: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // Without these the modal stops at the system bars, so the blur ends in
      // a hard line above the Android gesture pill and under the status bar.
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* The scrim: anywhere outside the card dismisses. Blurred rather than
          merely dimmed, so the screen behind reads as suspended rather than
          just darkened. Android needs the experimental method explicitly --
          without it the prop silently degrades to a plain translucent view. */}
      <BlurView
        intensity={18}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      >
        <Pressable
          onPress={onClose}
          accessibilityLabel="Close settings"
          style={{ flex: 1, backgroundColor: '#00000055' }}
        >
          {/* Swallows taps so pressing inside the card does not close it. */}
          <Pressable
            onPress={() => {}}
            style={{
              position: 'absolute',
              top: 56,
              right: space.md,
              width: 290,
              backgroundColor: colors.surface,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: 12,
              padding: space.md,
              gap: space.md,
            }}
          >
            <Row
              title="Biometric unlock"
              subtitle="Extra protection each time the app opens"
              value={biometricOn}
              disabled={busy || biometricBlockedReason !== null}
              onValueChange={onToggleBiometric}
            />

            {biometricBlockedReason ? (
              <Text style={{ ...typography.small, color: colors.warn }}>
                {biometricBlockedReason}
              </Text>
            ) : null}

            <View style={{ height: 1, backgroundColor: colors.border }} />

            <Row
              title="24-hour time"
              subtitle="Times in the activity log and status"
              value={use24h}
              disabled={false}
              onValueChange={onToggle24h}
            />

            <View style={{ height: 1, backgroundColor: colors.border }} />

            <Pressable
              onPress={onSignOut}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: space.xs }}
            >
              <Ionicons name="log-out-outline" size={20} color={colors.danger} />
              <Text style={{ ...typography.body, color: colors.danger }}>Sign out</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </BlurView>
    </Modal>
  );
}

function Row({
  title, subtitle, value, disabled, onValueChange,
}: {
  title: string;
  subtitle: string;
  value: boolean;
  disabled: boolean;
  onValueChange: (next: boolean) => void;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
      <View style={{ flex: 1 }}>
        <Text style={{ ...typography.body, color: colors.text }}>{title}</Text>
        <Text style={{ ...typography.small, color: colors.textDim }}>{subtitle}</Text>
      </View>
      <Switch
        value={value}
        disabled={disabled}
        onValueChange={onValueChange}
        trackColor={{ false: colors.border, true: colors.action }}
        thumbColor={colors.text}
      />
    </View>
  );
}
