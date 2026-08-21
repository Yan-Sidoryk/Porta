import { Text, View } from 'react-native';
import type { AuditEvent } from '@gate/shared';
import { colors, space, type as typography } from '../theme';

interface Props {
  events: AuditEvent[];
}

/** Denials and failures are the rows worth noticing, so they are marked. */
const toneFor = (event: AuditEvent): string => {
  if (event.errorCode === null) return colors.ok;
  return event.outcome === 'denied' ? colors.danger : colors.warn;
};

const describe = (event: AuditEvent): string => {
  if (event.errorCode === null) {
    return event.outcome === 'replayed' ? 'Opened (repeat tap)' : 'Opened';
  }
  if (event.outcome === 'denied') return 'Refused';
  if (event.errorCode === 'GATE_COOLING_DOWN') return 'Too soon after the last tap';
  if (event.errorCode === 'DEVICE_OFFLINE') return 'Controller offline';
  if (event.errorCode === 'TIMEOUT_AMBIGUOUS') return 'No answer from the gate';
  return 'Failed';
};

/**
 * Who operated the gate and when. Lives on the one screen rather than behind
 * navigation -- it is glanced at, not browsed, and a router for a second view
 * is a dependency that never leaves.
 */
export function ActivityList({ events }: Props) {
  if (events.length === 0) {
    return (
      <Text style={{ ...typography.small, color: colors.textDim }}>
        No activity yet.
      </Text>
    );
  }

  // The API returns oldest-first; newest belongs at the top of a list people
  // read from the top.
  const newestFirst = [...events].reverse();

  return (
    <View style={{ gap: space.sm }}>
      {newestFirst.map((event) => (
        <View
          key={event.id}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingVertical: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
          }}
        >
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: toneFor(event) }} />
          <View style={{ flex: 1 }}>
            <Text style={{ ...typography.body, color: colors.text }}>{describe(event)}</Text>
            <Text style={{ ...typography.small, color: colors.textDim }}>
              {event.userEmail ?? 'unknown user'}
            </Text>
          </View>
          <Text style={{ ...typography.small, color: colors.textDim }}>
            {new Date(event.createdAt).toLocaleString()}
          </Text>
        </View>
      ))}
    </View>
  );
}
