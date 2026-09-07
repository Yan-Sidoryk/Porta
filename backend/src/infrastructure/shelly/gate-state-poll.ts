import type { GatePosition } from '@gate/shared';
import type { ClockPort } from '../../domain/ports.js';
import { shellyPost, type ShellyConfig } from './client.js';
import { readInput, type ReedSwitchStateAdapter } from './reed-switch-state-adapter.js';

export interface PollOptions {
  intervalMs: number;
  /**
   * How long after a pulse to take one direct read.
   *
   * Long enough that the gate has finished travelling: measured on the real
   * gate, closing takes about 12s and the magnet clears roughly 3.8s into an
   * opening. Reading earlier than that is worse than not reading -- during
   * the first seconds of an opening the contact truthfully still reports
   * `closed`, and recording it would put a confident CLOSED on screen under a
   * gate that is already swinging open.
   */
  settleAfterMs: number;
  inputComponentId: number;
  reedLogicInverted: boolean;
}

/** Just enough of a logger to be satisfied by `app.log` or by a test spy. */
export interface PollLogger {
  warn(payload: object, message: string): void;
}

/**
 * Reads the device status the way the probe confirmed it works.
 *
 * Without `select`, `/v2/devices/api/get` answers with a bare summary --
 * id, type, code, gen, online -- and no component state at all. The input
 * only appears under `select: ['status']`, and the same reply still carries
 * the top-level `online` flag, so one request serves both facts and the
 * account's one-request-per-second budget is spent once.
 */
export async function readDeviceStatus(
  config: ShellyConfig,
): Promise<{ online: boolean; status: Record<string, unknown> } | null> {
  const reply = await shellyPost(config, '/v2/devices/api/get', {
    ids: [config.deviceId],
    select: ['status'],
  });

  if (reply.kind !== 'response' || reply.status !== 200) return null;
  if (!Array.isArray(reply.body)) return null;

  // Exactly one id was requested, so exactly one entry is expected. Matching
  // by id rather than trusting position: a wrong device's `online` flag is
  // the one error this cannot be allowed to make.
  const entry = reply.body.find(
    (row): row is Record<string, unknown> =>
      typeof row === 'object' && row !== null
      && (row as Record<string, unknown>).id === config.deviceId,
  );
  if (entry === undefined) return null;

  const status = entry.status;
  return {
    online: entry.online === 1 || entry.online === true,
    status: typeof status === 'object' && status !== null
      ? status as Record<string, unknown>
      : {},
  };
}

/**
 * Pulls the reed contact out of a device status blob.
 *
 * Returns null when the component is absent, which is a real and expected
 * case: the Shelly Plus Add-on has to be enabled in device settings before
 * `input:<id>` shows up at all. Absent is not an error -- it is "no reading",
 * and the state ages out to unknown on its own.
 */
export function readContact(
  status: Record<string, unknown>,
  inputComponentId: number,
  inverted: boolean,
): GatePosition | null {
  const component = status[`input:${inputComponentId}`];
  if (typeof component !== 'object' || component === null) return null;

  const state = (component as Record<string, unknown>).state;
  if (typeof state !== 'boolean') return null;

  return readInput(state, inverted);
}

/**
 * The reconciliation poll. It exists solely to correct drift from webhooks
 * that were never delivered -- they are fire-and-forget, with no retry and no
 * queue, so a missed event is gone permanently.
 *
 * It is NOT the liveness path. Do not shorten the interval to paper over
 * webhook problems; fix the webhooks. One minute against a five-minute
 * staleness window means five consecutive failures before the app is told we
 * have stopped knowing.
 *
 * It also takes one read shortly after each pulse, subscribing to the
 * adapter's `onMoving`. The interval alone runs from server boot and has no
 * relationship to when anyone presses the button, so a dropped webhook could
 * otherwise leave the app wrong for up to a minute at exactly the moment
 * someone is looking -- driving away, wanting to know the gate shut.
 *
 * Returns a stop function. Started from server.ts rather than the composition
 * root so that building a container in a test does not open a socket to
 * Shelly.
 */
export function startGateStatePoll(
  adapter: ReedSwitchStateAdapter,
  config: ShellyConfig,
  clock: ClockPort,
  options: PollOptions,
  log: PollLogger,
): () => void {
  const tick = async (): Promise<void> => {
    const device = await readDeviceStatus(config);

    if (device === null) {
      // The cloud did not answer, or answered something we could not read.
      // Record nothing: the reading ages out and the app is told 'unknown',
      // which is the truth. Never throw -- this runs on a timer with no
      // caller to catch it.
      adapter.setOnline(false);
      return;
    }

    adapter.setOnline(device.online);

    // An offline device is served from Shelly Cloud's CACHE: the reply still
    // carries an `input:<id>` block, but it is the last value the device
    // managed to report, not a live read. Recording it would stamp a fresh
    // `confirmedAt` on stale data every 60 seconds, so a gate whose
    // controller had been dead for hours would still be reporting a
    // confident position. Read nothing until the device is answering again.
    if (!device.online) return;

    const seen = readContact(device.status, options.inputComponentId, options.reedLogicInverted);
    if (seen === null) return;

    // The poll is a direct read, so it wins any disagreement. Logged loudly
    // because a steady trickle of corrections means webhooks are being lost,
    // and that is worth finding out from a log rather than from a gate.
    const stored = adapter.lastPosition();
    if (stored !== null && stored !== seen) {
      log.warn({ stored, seen }, 'gate state corrected by reconciliation poll');
    }

    adapter.record(seen, 'poll', clock.now());
  };

  const run = (): void => {
    void tick().catch(() => {
      // readDeviceStatus already swallows transport failures; this is the
      // belt-and-braces guard that keeps an unexpected throw from killing the
      // interval and silently ending reconciliation for the process lifetime.
      adapter.setOnline(false);
    });
  };

  run();
  const timer = setInterval(run, options.intervalMs);
  timer.unref();

  // Last tap wins. A second pulse inside the window means travel restarted,
  // so the old deadline is meaningless -- and a burst of taps should cost one
  // read rather than one per tap.
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelSettle = (): void => {
    if (settleTimer !== null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
  };

  adapter.onMoving = () => {
    cancelSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      run();
    }, options.settleAfterMs);
    settleTimer.unref();
  };

  return () => {
    clearInterval(timer);
    cancelSettle();
    // Unsubscribe as well: a pulse arriving after shutdown must not wake a
    // poll that is meant to be stopped.
    delete adapter.onMoving;
  };
}
