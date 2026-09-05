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
 * What the top of the screen says about the controller.
 *
 * `unreadable` exists because a failed CHECK is not an offline CONTROLLER.
 * Collapsing the two would have the app assert something about hardware it
 * merely failed to ask about.
 *
 * Position is NOT here. It moved to the banner, where it gets the size and
 * colour that make it readable at a glance from a car -- which is the whole
 * point of having a sensor. This line stays small and secondary.
 */
export interface SeenAt {
  at: string;
  /**
   * Whether the reading is still being stood behind. Drives the word in front
   * of the time: "Checked" claims we know it now, "Last seen" admits we do
   * not. The stamp is the same either way -- the backend reports when a
   * reading was last CONFIRMED, not when we last tried -- so labelling it
   * "Checked" while the controller is unreachable is a small, constant lie.
   */
  current: boolean;
}

export type ControllerView =
  | { kind: 'checking' }
  | { kind: 'online'; seen: SeenAt | null }
  | { kind: 'offline'; seen: SeenAt | null }
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

  // No reading ever taken means no time to show. `checkedAt` falls back to
  // "now" in that case, and printing it would date a reading that never
  // happened.
  const seen: SeenAt | null = status.lastReading === null
    ? null
    // A confirmed position is the backend's own statement that the reading is
    // fresh AND the controller answered, so it is the whole test.
    : { at: status.checkedAt, current: status.position !== 'unknown' };

  return status.reachable ? { kind: 'online', seen } : { kind: 'offline', seen };
}

/**
 * The gate's position, sized and worded for a glance from a moving car.
 *
 * `not_closed` renders as **OPEN**, and that is a deliberate, informed
 * inaccuracy. The contact cannot tell a gate standing fully open from one
 * stopped mid-travel or jammed on a leaf, so "OPEN" overstates what is known
 * in two of those three cases. It is used anyway because the question being
 * answered here is "do I need to turn the car around", and for that question
 * OPEN and NOT CLOSED have the same answer -- while a driver reading two
 * words at arm's length does not reliably parse the negation. The precise
 * vocabulary survives everywhere it costs nothing: the wire format, the API,
 * the audit trail, and this file's own types all still say `not_closed`.
 *
 * When the position can no longer be confirmed, the last reading is shown
 * greyed under a **LAST SEEN** label rather than collapsing to a bare
 * UNKNOWN. It is more useful and no less honest: the word is what we last
 * saw, and the grey and the label both say we are no longer standing behind
 * it. Two carriers, so the doubt survives being read in sunlight or by
 * someone who cannot see the colour.
 *
 * WHY the position is unconfirmed is not repeated here, and neither is WHEN.
 * `StatusPanel` above already carries both -- "Controller offline" and
 * "Last seen 21:34" -- and saying either twice makes the screen slower to
 * read, which is the one thing this element cannot afford.
 */
export interface PositionBanner {
  text: string;
  tone: 'ok' | 'warn' | 'muted';
  /**
   * Small qualifier set above the word, used when the word is no longer
   * current. Kept as its own field rather than folded into `text` so the
   * break is deterministic: "LAST SEEN CLOSED" as one hero-sized string wraps
   * wherever the phone happens to be narrow, and could land as "LAST" /
   * "SEEN CLOSED". The position itself must never be the half that wraps.
   */
  label?: string;
}

/** OPEN, not NOT CLOSED. See the note above -- this is the only place it bends. */
const WORD: Record<'closed' | 'not_closed', string> = {
  closed: 'CLOSED',
  not_closed: 'OPEN',
};

export function positionBanner(
  reading: GateStatusResponse | ApiFailure | null,
): PositionBanner {
  if (reading === null) return { text: 'CHECKING...', tone: 'muted' };

  // A failed check carries no reading at all -- not even a stale one, since
  // the response never arrived. StatusPanel explains why.
  if ('ok' in reading && reading.ok === false) return { text: 'UNKNOWN', tone: 'muted' };

  const status = reading as GateStatusResponse;
  if (status.position === 'closed') return { text: 'CLOSED', tone: 'ok' };
  if (status.position === 'not_closed') return { text: 'OPEN', tone: 'warn' };

  // Unconfirmed. Show what we last saw, marked as no longer current.
  const last = status.lastReading;
  if (last === null || last.position === 'unknown') return { text: 'UNKNOWN', tone: 'muted' };

  // No age here: the header's "Last seen 21:34" already carries it, and the
  // word itself is the whole point of this element.
  return { label: 'LAST SEEN', text: WORD[last.position], tone: 'muted' };
}

/**
 * Whether the app should keep asking, because the gate is mid-answer.
 *
 * The webhook lands on the backend within a second of the gate finishing its
 * swing, but the screen only re-reads on mount, foreground, pull, and tap --
 * so a user who taps and then watches would sit on a frozen 'unknown' while
 * the answer was already sitting on the server. This is what closes that gap.
 *
 * Deliberately false for an ApiFailure. A backend we could not reach is a
 * different problem from a gate that is still moving, and retrying it on a
 * three-second timer would be a retry storm aimed at something already known
 * to be down. Foreground and pull-to-refresh still cover that case.
 */
export const isAwaitingReading = (
  reading: GateStatusResponse | ApiFailure | null,
): boolean => reading !== null && 'position' in reading && reading.position === 'unknown';

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

const pad = (value: number): string => String(value).padStart(2, '0');

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Clock time in the phone's local zone.
 *
 * Built by hand rather than with toLocaleTimeString: the setting has to decide
 * 12- or 24-hour, and the platform would otherwise override it from the device
 * locale. It also makes the output identical on every device, which is what
 * you want when comparing an audit row against someone's account of when they
 * arrived.
 */
export function formatClock(iso: string, use24h: boolean): string {
  const at = new Date(iso);
  const hours = at.getHours();
  const minutes = pad(at.getMinutes());

  if (use24h) return `${pad(hours)}:${minutes}`;

  const suffix = hours < 12 ? 'am' : 'pm';
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${minutes} ${suffix}`;
}

/** Date plus time, for log rows that may be days old. */
export function formatStamp(iso: string, use24h: boolean): string {
  const at = new Date(iso);
  return `${at.getDate()} ${MONTHS[at.getMonth()] ?? ''} ${formatClock(iso, use24h)}`;
}

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
