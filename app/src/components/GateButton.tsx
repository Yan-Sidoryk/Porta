import { Pressable, Text, View } from 'react-native';
import { colors, type as typography } from '../theme';

const SIZE = 220;
const RING = 8;

interface Props {
  label: string;
  sublabel: string;
  disabled: boolean;
  /** 0 at the start of the cooldown, 1 when it is over. */
  progress: number;
  onPress: () => void;
}

/**
 * The one control. Round, large, and low on the screen so it falls under a
 * thumb one-handed.
 *
 * The cooldown is drawn ON the button rather than as a toast: the countdown
 * belongs where the tap happens, and a message elsewhere on screen is easy to
 * miss while jabbing at a button that is not responding.
 *
 * No gate glyph. An open-gate or closed-gate icon would be wrong about half
 * the time, because the system has no position sensor.
 */
export function GateButton({ label, sublabel, disabled, progress, onPress }: Props) {
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      {/* The ring: a track, with the remaining wait drawn over it. Rendered
          with plain Views rather than SVG -- one dependency avoided, and a
          sweep is not needed to read "nearly done" at arm's length. */}
      <View
        style={{
          width: SIZE + RING * 4,
          height: SIZE + RING * 4,
          borderRadius: (SIZE + RING * 4) / 2,
          borderWidth: RING,
          borderColor: disabled ? colors.border : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {disabled && progress > 0 ? (
          <View
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              right: 0,
              height: `${Math.round(progress * 100)}%`,
              backgroundColor: colors.surface,
            }}
          />
        ) : null}

        <Pressable
          onPress={onPress}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint={sublabel}
          accessibilityState={{ disabled }}
          style={({ pressed }) => ({
            width: SIZE,
            height: SIZE,
            borderRadius: SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 24,
            backgroundColor: disabled
              ? colors.actionDisabled
              : pressed
                ? colors.actionPressed
                : colors.action,
          })}
        >
          <Text
            style={{
              ...typography.title,
              color: disabled ? colors.textDim : '#1A1206',
              textAlign: 'center',
            }}
          >
            {label}
          </Text>
          {sublabel ? (
            <Text
              style={{
                ...typography.small,
                color: disabled ? colors.textDim : '#3A2A0C',
                textAlign: 'center',
                marginTop: 6,
              }}
            >
              {sublabel}
            </Text>
          ) : null}
        </Pressable>
      </View>
    </View>
  );
}
