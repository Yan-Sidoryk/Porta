export const ROLES = ['owner', 'user'] as const;
export type Role = (typeof ROLES)[number];

/**
 * A reed contact on the leaf that closes last. It reports closed, or it
 * reports not closed -- there is no 'open'. A gate stopped mid-travel, a gate
 * standing fully open, and a gate with one leaf jammed all read identically,
 * so naming any of them 'open' would be a claim the hardware cannot support.
 *
 * 'unknown' means we genuinely have no reading: nothing seen yet, the gate is
 * moving after a pulse, or the last reading is too stale to trust.
 */
export const GATE_POSITIONS = ['closed', 'not_closed', 'unknown'] as const;
export type GatePosition = (typeof GATE_POSITIONS)[number];

export const PULSE_OUTCOMES = [
  'success', 'timeout', 'device-offline', 'device-failed',
  'bad-request', 'device-not-found', 'error',
] as const;
export type PulseOutcome = (typeof PULSE_OUTCOMES)[number];

export const ERROR_CODES = [
  'GATE_COOLING_DOWN', 'ATTEMPT_IN_PROGRESS', 'DEVICE_OFFLINE',
  'TIMEOUT_AMBIGUOUS', 'ACCESS_DENIED', 'SESSION_EXPIRED',
  'RATE_LIMITED', 'DEVICE_FAILED_COMMAND', 'BAD_REQUEST',
  'DEVICE_NOT_FOUND', 'USER_UNKNOWN', 'USER_DISABLED', 'INTERNAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** A confirmed outcome narrows the cooldown; 'timeout' does not. */
export const isConfirmedOutcome = (o: PulseOutcome): boolean => o !== 'timeout';
