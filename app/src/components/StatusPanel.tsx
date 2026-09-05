import { Text, View } from 'react-native';
import { formatClock, type GateStatusView } from '../gate-machine';
import { colors, space, type as typography } from '../theme';

interface Props {
  view: GateStatusView;
  use24h: boolean;
}

/**
 * Gate position, qualified by when it was read.
 *
 * Position used to be deliberately absent here: there was no sensor, so the
 * only honest line was "unknown" on every render, which is noise. A reed
 * contact on the pillar changed that, and the rule it replaces is narrower
 * than it looks -- the design forbids CLAIMING a position, not reporting one
 * that was measured.
 *
 * "Not closed" is never rendered "Open". The contact reports a magnet or no
 * magnet; a gate stopped mid-travel, standing open, and jammed on one leaf
 * are the same reading, so "Open" would be wrong about two of the three.
 *
 * The reading LAGS by construction -- the physical remote works whether this
 * app is running or not, and a missed webhook is corrected only on the next
 * poll -- so the time of the reading sits on the same line rather than being
 * implied.
 */
export function StatusPanel({ view, use24h }: Props) {
  const dot = DOT[view.kind];

  return (
    <View style={{ gap: space.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        {/* Colour is never the only carrier: the words say it too, for
            colour-blind readers and for a screen glanced at in sunlight.
            There is no glyph either -- a gate icon would imply a position. */}
        <View style={{ width: 9, height: 9, borderRadius: 4.5, backgroundColor: dot }} />
        <Text numberOfLines={1} style={{ ...typography.body, color: colors.text }}>
          {view.headline}
        </Text>

        {view.checkedAt === undefined ? null : (
          // Pushed to the far end of the same line: it qualifies the reading,
          // so it belongs beside it rather than on a row of its own. "Checked"
          // earns its word -- a bare time next to a status line reads as a
          // clock rather than as the age of the reading.
          <Text style={{ ...typography.small, color: colors.textDim, marginLeft: 'auto' }}>
            Checked {formatClock(view.checkedAt, use24h)}
          </Text>
        )}
      </View>

      {view.note === undefined ? null : (
        <Text style={{ ...typography.small, color: colors.textDim }}>
          {view.note}
        </Text>
      )}
    </View>
  );
}

/**
 * Amber for unknown rather than red: nothing is known to be wrong. Green is
 * kept for the one confident positive state, and there is deliberately no red
 * anywhere here -- a red/green vocabulary would imply "shut/open", which is
 * the distinction this sensor cannot make.
 */
const DOT: Record<GateStatusView['kind'], string> = {
  checking: colors.textDim,
  closed: colors.ok,
  'not-closed': colors.warn,
  unknown: colors.warn,
};
