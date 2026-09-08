import type { GatePosition } from '@gate/shared';
import type { ReedSwitchStateAdapter } from './reed-switch-state-adapter.js';

/** Just enough of a logger to be satisfied by `app.log` or a test spy. */
export interface AlarmLogger {
  warn(payload: object, message: string): void;
}

export interface AlarmOptions {
  openAlertAfterMs: number;
}

/**
 * Warns once when the gate has been left open.
 *
 * Three details carry the whole behaviour, and each is a bug if reversed:
 *
 * **Arms on the position BECOMING not_closed, not on a closed -> not_closed
 * transition.** A pulse blanks the position, so the real sequence when someone
 * opens the gate is closed -> unknown -> not_closed. Waiting for the direct
 * transition would wait forever.
 *
 * **`timer === null` is load-bearing.** The reconciliation poll re-records
 * not_closed every 60 seconds for as long as the gate stays open. Re-arming on
 * each of those would push the deadline back a minute at a time and the alert
 * would never fire at all.
 *
 * **A pulse does not cancel it.** `markUnknown()` says the gate is moving, not
 * that it closed -- and tapping a moving gate STOPS it, which leaves it open.
 * Only a confirmed `closed` clears the alarm. That is also what makes the
 * "must close first" rule true rather than approximately true.
 */
export function startGateOpenAlarm(
  adapter: ReedSwitchStateAdapter,
  notify: () => Promise<void>,
  options: AlarmOptions,
  log: AlarmLogger,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let notified = false;

  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = (): void => {
    timer = null;
    void (async () => {
      // Re-checked, not assumed. The reading may have gone stale or the
      // controller dropped since the countdown started, and "your gate has
      // been open five minutes" is not something we can say about a position
      // we can no longer confirm.
      //
      // `notified` stays false in that case on purpose: we never spent the
      // alert, so a controller that recovers still gets to warn.
      const state = await adapter.getState();
      if (state.position !== 'not_closed') return;

      notified = true;
      try {
        await notify();
      } catch (error) {
        // Never throw out of a timer with no caller to catch it.
        log.warn({ detail: String(error) }, 'gate-open notification failed');
      }
    })();
  };

  adapter.onReading = (position: GatePosition) => {
    if (position === 'closed') {
      cancel();
      notified = false;
      return;
    }

    if (position === 'not_closed' && timer === null && !notified) {
      timer = setTimeout(fire, options.openAlertAfterMs);
      timer.unref();
    }
  };

  return () => {
    cancel();
    delete adapter.onReading;
  };
}
