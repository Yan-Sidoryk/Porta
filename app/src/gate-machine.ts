import type { ErrorCode, GateStatusResponse, TriggerResponse } from '@gate/shared';

/**
 * Everything the gate screen decides, with no React and no fetch in it, so it
 * can be tested like the rest of the project. The components below it only
 * render what this returns.
 *
 * Nothing here may import `./api`: that reaches expo-constants and then
 * react-native, whose Flow syntax no test runner here can parse. The failure
 * shape lives in this file and `api.ts` imports it, not the other way round.
 */

/** A failure the backend never sent: DNS, refused connection, airplane mode. */
export const NETWORK_UNREACHABLE = 'NETWORK_UNREACHABLE';

export interface ApiFailure {
  ok: false;
  code: ErrorCode | typeof NETWORK_UNREACHABLE;
  message: string;
  retryAfterMs?: number;
}

export type GateUiState =
  /** Ready to tap. */
  | { kind: 'idle' }
  /** A pulse is in flight. Also covers ATTEMPT_IN_PROGRESS -- see below. */
  | { kind: 'sending' }
  /**
   * The pulse landed. `until` is when the button becomes tappable again and
   * `totalMs` is how long the whole wait was, which the ring needs to know how
   * far through it is -- a doubled post-timeout window fills at half the rate.
   */
  | { kind: 'success'; until: number; totalMs: number; replayed: boolean }
  /** Rejected or failed. The window is set only when the gate is cooling down. */
  | {
      kind: 'error';
      code: ErrorCode | typeof NETWORK_UNREACHABLE;
      message: string;
      until?: number;
      totalMs?: number;
    };

/**
 * ATTEMPT_IN_PROGRESS is deliberately NOT an error.
 *
 * It means the tap this app already sent is still running. The honest thing to
 * show is that the app is still working, not that something went wrong -- and
 * showing an error would invite a retry, which is the one thing that must not
 * happen while a pulse is outstanding.
 */
const STILL_WORKING: ErrorCode = 'ATTEMPT_IN_PROGRESS';

/**
 * Plain language, no codes and no jargon. The backend sends its own `message`,
 * but these are written for someone standing at a gate in the rain, and the
 * distinctions SPEC.md asks for are made here rather than inherited.
 */
const MESSAGES: Record<ErrorCode | typeof NETWORK_UNREACHABLE, string> = {
  NETWORK_UNREACHABLE: 'No connection. Check your phone signal or Wi-Fi.',
  INTERNAL: 'Something went wrong at the gate service.',
  GATE_COOLING_DOWN: 'Just triggered. Wait for the gate to finish moving.',
  ATTEMPT_IN_PROGRESS: 'Still sending...',
  DEVICE_OFFLINE: 'The gate controller is offline. Check power and Wi-Fi at the gate.',
  TIMEOUT_AMBIGUOUS: 'No answer from the gate. It may have moved -- look before trying again.',
  DEVICE_FAILED_COMMAND: 'The gate controller refused the command.',
  DEVICE_NOT_FOUND: 'The gate controller is not registered with the account.',
  BAD_REQUEST: 'The app sent something the gate service rejected.',
  ACCESS_DENIED: 'You are not allowed to open this gate.',
  SESSION_EXPIRED: 'Your session ended. Sign in again.',
  RATE_LIMITED: 'Too many attempts. Wait a moment.',
  USER_UNKNOWN: 'You are not allowed to open this gate.',
  USER_DISABLED: 'You are not allowed to open this gate.',
};

export const messageFor = (code: ErrorCode | typeof NETWORK_UNREACHABLE): string => MESSAGES[code];

/**
 * Turns one trigger reply into the next screen state.
 *
 * `now` is passed in rather than read, so the cooldown maths is testable
 * without waiting -- the same reason ClockPort exists on the backend.
 */
export function nextState(
  reply: TriggerResponse | ApiFailure,
  now: number,
): GateUiState {
  if (reply.ok) {
    // Always the server's number. A client that assumed 5s would re-enable
    // the button while a DOUBLED post-timeout window was still rejecting.
    const wait = reply.retryAfterMs ?? 0;
    return { kind: 'success', until: now + wait, totalMs: wait, replayed: reply.replayed };
  }

  if (reply.code === STILL_WORKING) return { kind: 'sending' };

  return {
    kind: 'error',
    code: reply.code,
    message: messageFor(reply.code),
    ...(reply.retryAfterMs === undefined
      ? {}
      : { until: now + reply.retryAfterMs, totalMs: reply.retryAfterMs }),
  };
}

/**
 * What the top of the screen is allowed to say about the controller.
 *
 * `unreadable` exists because a failed CHECK is not an offline CONTROLLER.
 * Collapsing the two would have the app assert something about hardware it
 * merely failed to ask about -- the same class of lie as displaying "Closed"
 * for a gate whose position is unknown.
 */
export type ControllerView =
  | { kind: 'checking' }
  | { kind: 'online'; checkedAt: string }
  | { kind: 'offline'; checkedAt: string }
  /** The check did not complete. Says nothing about the controller. */
  | { kind: 'unreadable'; reason: string };

export function controllerView(
  reading: GateStatusResponse | ApiFailure | null,
): ControllerView {
  if (reading === null) return { kind: 'checking' };

  if ('ok' in reading && reading.ok === false) {
    return {
      kind: 'unreadable',
      reason: reading.code === NETWORK_UNREACHABLE
        ? 'No connection to the gate service.'
        : 'Could not check the controller just now.',
    };
  }

  const status = reading as GateStatusResponse;
  return status.reachable
    ? { kind: 'online', checkedAt: status.checkedAt }
    : { kind: 'offline', checkedAt: status.checkedAt };
}

/**
 * How long the app may sit in the background before the biometric lock
 * re-engages. Short enough that a phone left on a table re-locks, long enough
 * that glancing at a message and coming straight back does not re-prompt.
 */
export const RELOCK_GRACE_MS = 15_000;

/**
 * Whether returning to the foreground should ask for biometrics again.
 *
 * Locking only on a cold start would make the feature theatre: phone apps are
 * almost never killed, so the app would sit unlocked in the switcher forever.
 */
export const shouldRelock = (
  backgroundedAt: number | null,
  now: number,
  graceMs: number = RELOCK_GRACE_MS,
): boolean => backgroundedAt !== null && now - backgroundedAt >= graceMs;

/** Whole seconds still to wait, floor 0. What the ring counts down. */
export const secondsLeft = (until: number, now: number): number =>
  Math.max(0, Math.ceil((until - now) / 1000));

/** 0 at the start of the wait, 1 when it is over. Drives the ring's sweep. */
export function cooldownProgress(until: number, now: number, totalMs: number): number {
  if (totalMs <= 0) return 1;
  const remaining = Math.max(0, until - now);
  return Math.min(1, Math.max(0, 1 - remaining / totalMs));
}

/**
 * The button is live only when nothing is outstanding and the guard has
 * stopped rejecting. Anything else -- in flight, cooling, or a rejection that
 * carried a window -- keeps it disabled.
 */
export function canTap(state: GateUiState, now: number): boolean {
  switch (state.kind) {
    case 'idle':
      return true;
    case 'sending':
      return false;
    case 'success':
      return now >= state.until;
    case 'error':
      return state.until === undefined || now >= state.until;
  }
}

/**
 * A tap is one command with one id, kept until the gate service gives a
 * definite answer. Only an unreachable backend leaves it alive: the pulse may
 * have fired, so the next press has to be a RETRY of the same command rather
 * than a second one.
 */
export const tapIsFinished = (reply: TriggerResponse | ApiFailure): boolean =>
  reply.ok || reply.code !== NETWORK_UNREACHABLE;
