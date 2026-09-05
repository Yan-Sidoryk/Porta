import { Text, View } from 'react-native';
import { formatClock, type ControllerView } from '../gate-machine';
import { colors, space, type as typography } from '../theme';

interface Props {
  view: ControllerView;
  use24h: boolean;
}

/**
 * Controller reachability, and nothing else.
 *
 * Position is deliberately not here. It is not that the app has nothing to
 * say about it -- there is a reed contact now -- but that the position is the
 * one thing a driver needs to read at a glance, so it gets the banner's size
 * and colour instead of a small line in the header. Two places competing to
 * report the same fact would just make both of them slower to read.
 *
 * The four states are kept apart on purpose. "Offline" is a statement about
 * hardware and is only ever shown when the gate service actually told us so.
 * A check that failed renders as its own thing, because "we could not ask"
 * and "the controller is down" are different facts and only one of them is
 * ours to assert.
 *
 * Reachability also LAGS -- Shelly Cloud only marks a device offline once its
 * keepalive expires, up to about a minute -- so the time of the reading sits
 * on the same line rather than being implied.
 */
export function StatusPanel({ view, use24h }: Props) {
  const { dot, headline } = present(view);

  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {/* Colour is never the only carrier: the words say it too, for
            colour-blind readers and for a screen glanced at in sunlight. */}
        <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: dot }} />
        <Text numberOfLines={1} style={{ ...typography.body, color: colors.text }}>
          {headline}
        </Text>

        {(view.kind === 'online' || view.kind === 'offline') && view.seen !== null ? (
          // Pushed to the far end of the same line: it qualifies the reading,
          // so it belongs beside it rather than on a row of its own. The word
          // earns its place -- a bare time next to a status line reads as a
          // clock rather than as the age of the reading.
          //
          // "Checked" only when the reading is still being stood behind. The
          // stamp is when a reading was last CONFIRMED, not when we last
          // tried, so an unreachable controller showing "Checked 15:02" would
          // claim a check that had just failed.
          <Text style={{ ...typography.small, color: colors.textDim, marginLeft: 'auto' }}>
            {view.seen.current ? 'Checked' : 'Last seen'} {formatClock(view.seen.at, use24h)}
          </Text>
        ) : null}
      </View>

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
