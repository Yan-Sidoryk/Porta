import { Text, View } from 'react-native';
import type { AuditEvent } from '@gate/shared';
import { formatStamp } from '../gate-machine';
import { colors, space, type as typography } from '../theme';

interface Props {
  events: AuditEvent[];
  use24h: boolean;
}

/**
 * Green worked, amber is the gate protecting itself, red is everything that
 * did not happen. Only the cooldown is amber: it is the system working as
 * designed, not a fault, and colouring it like one would train the eye to
 * ignore the rows that matter.
 */
const toneFor = (event: AuditEvent): string => {
  if (event.errorCode === null) return colors.ok;
  return event.errorCode === 'GATE_COOLING_DOWN' ? colors.warn : colors.danger;
};

/**
 * Short enough to sit on one line beside a timestamp, and none of them claim
 * a physical outcome. The hardware takes ONE command, a pulse, and the R70
 * cycles open -> stop -> close -> stop: a row that said "Opened" would be
 * wrong roughly half the time, and might describe a gate that closed.
 */
const describe = (event: AuditEvent): string => {
  if (event.errorCode === null) {
    // 'replayed' means the same tap arrived twice and NO second pulse went
    // out -- the row records a tap that was deliberately not repeated.
    return event.outcome === 'replayed' ? 'Repeat tap' : 'Pulse sent';
  }

  switch (event.errorCode) {
    case 'ACCESS_DENIED':
    case 'USER_UNKNOWN':
    // A disabled account is a refusal, not a malfunction. It used to fall
    // through to the catch-all and read as an amber hardware fault.
    case 'USER_DISABLED':
      return 'Access denied';
    case 'GATE_COOLING_DOWN':
      return 'Cooling down';
    case 'RATE_LIMITED':
      return 'Rate limited';
    case 'DEVICE_OFFLINE':
      return 'Controller offline';
    case 'DEVICE_FAILED_COMMAND':
      return 'Controller refused';
    case 'TIMEOUT_AMBIGUOUS':
      // Deliberately not "not responding": this is the one outcome where the
      // pulse MAY have fired. The label has to leave that open.
      return 'Unconfirmed';
    default:
      return 'Unknown failure';
  }
};

/**
 * Who operated the gate and when. Lives on the one screen rather than behind
 * navigation -- it is glanced at, not browsed, and a router for a second view
 * is a dependency that never leaves.
 */
export function ActivityList({ events, use24h }: Props) {
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
            {formatStamp(event.createdAt, use24h)}
          </Text>
        </View>
      ))}
    </View>
  );
}
