import { Text, View } from 'react-native';
import type { GateStatusResponse } from '@gate/shared';
import { colors, space, type as typography } from '../theme';

interface Props {
  status: GateStatusResponse | null;
  /** True while the first status read is still outstanding. */
  loading: boolean;
}

/**
 * Controller reachability, and nothing else.
 *
 * Position is deliberately NOT shown. There is no sensor, so the only honest
 * thing to display would be "unknown" on every single render -- permanent
 * noise that tells you nothing. Saying nothing about position is still honest:
 * what the design forbids is CLAIMING a position, and no claim is made
 * anywhere in this app.
 *
 * Reachability is a LAGGING indicator -- Shelly Cloud only marks a device
 * offline once its keepalive expires, up to about a minute -- so the time of
 * the reading is shown beside it rather than implied.
 */
export function StatusPanel({ status, loading }: Props) {
  const reachable = status?.reachable ?? false;

  const dot = loading ? colors.textDim : reachable ? colors.ok : colors.danger;
  const word = loading ? 'Checking...' : reachable ? 'Controller online' : 'Controller offline';

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {/* Colour is never the only carrier: the words say it too, for
            colour-blind readers and for a screen glanced at in sunlight. */}
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: dot }} />
        <Text style={{ ...typography.hero, color: colors.text }}>{word}</Text>
      </View>

      {status ? (
        <Text style={{ ...typography.small, color: colors.textDim }}>
          Checked {new Date(status.checkedAt).toLocaleTimeString()}
        </Text>
      ) : null}
    </View>
  );
}
