import { Text, View } from 'react-native';
import type { GateStatusResponse } from '@gate/shared';
import { colors, space, type as typography } from '../theme';

interface Props {
  status: GateStatusResponse | null;
  /** True while the first status read is still outstanding. */
  loading: boolean;
}

/**
 * Honest state, and nothing more.
 *
 * Position is always "unknown" today, and it is stated plainly rather than
 * guessed from command history. A gate app that confidently displays "Closed"
 * when it does not know is worse than one that admits ignorance -- someone
 * would drive off trusting it.
 *
 * Reachability is shown separately because it means something different: the
 * controller answering the cloud is not the gate being in any particular
 * place. It is also a LAGGING indicator -- Shelly Cloud only marks a device
 * offline once its keepalive expires, which takes up to about a minute -- so
 * the time of the reading is shown next to it rather than implied.
 */
export function StatusPanel({ status, loading }: Props) {
  const reachable = status?.reachable ?? false;

  const dot = loading ? colors.textDim : reachable ? colors.ok : colors.danger;
  const word = loading ? 'Checking...' : reachable ? 'Controller online' : 'Controller offline';

  return (
    <View style={{ gap: space.sm }}>
      <Text style={{ ...typography.hero, color: colors.text }}>Position unknown</Text>
      <Text style={{ ...typography.small, color: colors.textDim }}>
        There is no position sensor on this gate. It is never guessed.
      </Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.sm }}>
        {/* Colour is never the only carrier: the words say it too, for
            colour-blind readers and for a screen glanced at in sunlight. */}
        <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: dot }} />
        <Text style={{ ...typography.body, color: colors.text }}>{word}</Text>
      </View>

      {status ? (
        <Text style={{ ...typography.small, color: colors.textDim }}>
          Checked {new Date(status.checkedAt).toLocaleTimeString()}
        </Text>
      ) : null}
    </View>
  );
}
