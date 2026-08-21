import { Modal, Pressable, Switch, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, space, type as typography } from '../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  biometricOn: boolean;
  /** Null while availability is still being read, or if the device cannot. */
  biometricLabel: string | null;
  /** Why the toggle is unavailable, shown under it. */
  biometricBlockedReason: string | null;
  busy: boolean;
  onToggleBiometric: (next: boolean) => void;
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
  visible, onClose, biometricOn, biometricLabel, biometricBlockedReason,
  busy, onToggleBiometric, onSignOut,
}: Props) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      {/* The scrim: anywhere outside the card dismisses. */}
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close settings"
        style={{ flex: 1, backgroundColor: '#000000AA' }}
      >
        {/* Swallows taps so pressing inside the card does not close it. */}
        <Pressable
          onPress={() => {}}
          style={{
            position: 'absolute',
            top: 56,
            right: space.md,
            width: 280,
            backgroundColor: colors.surface,
            borderColor: colors.border,
            borderWidth: 1,
            borderRadius: 12,
            padding: space.md,
            gap: space.md,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
            <View style={{ flex: 1 }}>
              <Text style={{ ...typography.body, color: colors.text }}>
                {biometricLabel ?? 'Biometric lock'}
              </Text>
              <Text style={{ ...typography.small, color: colors.textDim }}>
                Ask to unlock when the app opens
              </Text>
            </View>
            <Switch
              value={biometricOn}
              disabled={busy || biometricBlockedReason !== null}
              onValueChange={onToggleBiometric}
              trackColor={{ false: colors.border, true: colors.action }}
              thumbColor={colors.text}
            />
          </View>

          {biometricBlockedReason ? (
            <Text style={{ ...typography.small, color: colors.warn }}>
              {biometricBlockedReason}
            </Text>
          ) : null}

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
    </Modal>
  );
}
