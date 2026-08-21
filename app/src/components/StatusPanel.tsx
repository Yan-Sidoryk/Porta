import { Text, View } from 'react-native';
import type { ControllerView } from '../gate-machine';
import { colors, space, type as typography } from '../theme';

interface Props {
  view: ControllerView;
}

/**
 * Controller reachability, and nothing else.
 *
 * Position is deliberately not shown. There is no sensor, so the only honest
 * line would be "unknown" on every render -- noise that never changes. Saying
 * nothing about position is still honest; what the design forbids is CLAIMING
 * one, and no claim is made anywhere in this app.
 *
 * The four states are kept apart on purpose. "Offline" is a statement about
 * hardware and is only ever shown when the gate service actually told us so.
 * A check that failed renders as its own thing, because "we could not ask" and
 * "the controller is down" are different facts and only one of them is ours to
 * assert.
 *
 * Reachability also LAGS -- Shelly Cloud only marks a device offline once its
 * keepalive expires, up to about a minute -- so the time of the reading sits
 * next to it rather than being implied.
 */
export function StatusPanel({ view }: Props) {
  const { dot, headline } = present(view);

  return (
    <View style={{ gap: space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {/* Colour is never the only carrier: the words say it too, for
            colour-blind readers and for a screen glanced at in sunlight. */}
        <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: dot }} />
        <Text style={{ ...typography.hero, color: colors.text }}>{headline}</Text>
      </View>

      {view.kind === 'online' || view.kind === 'offline' ? (
        <Text style={{ ...typography.small, color: colors.textDim }}>
          Checked {new Date(view.checkedAt).toLocaleTimeString()}
        </Text>
      ) : null}

      {view.kind === 'unreadable' ? (
        <Text style={{ ...typography.small, color: colors.textDim }}>
          {view.reason} Pull down to try again.
        </Text>
      ) : null}
    </View>
  );
}

function present(view: ControllerView): { dot: string; headline: string } {
  switch (view.kind) {
    case 'checking':
      return { dot: colors.textDim, headline: 'Checking...' };
    case 'online':
      return { dot: colors.ok, headline: 'Controller online' };
    case 'offline':
      return { dot: colors.danger, headline: 'Controller offline' };
    case 'unreadable':
      // Amber, not red: nothing is known to be wrong with the gate.
      return { dot: colors.warn, headline: 'Status unavailable' };
  }
}
