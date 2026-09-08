import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../../../test/fakes.js';
import { ReedSwitchStateAdapter } from './reed-switch-state-adapter.js';
import { startGateOpenAlarm } from './gate-open-alarm.js';

const STALE_AFTER_MS = 300_000;
const ALERT_MS = 50;
const silent = { warn: () => {} };

/** Long enough for the alarm's timer plus its async re-check to complete. */
const settle = (): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ALERT_MS * 4); });

function build() {
  const clock = new FakeClock();
  const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
  adapter.setOnline(true);
  const notify = vi.fn(async () => {});
  const stop = startGateOpenAlarm(adapter, notify, { openAlertAfterMs: ALERT_MS }, silent);
  return { clock, adapter, notify, stop };
}

describe('gate-open alarm', () => {
  it('warns once the gate has been open for the configured time', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    expect(notify).not.toHaveBeenCalled();

    await settle();
    stop();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('is not restarted by the poll re-recording the same position', async () => {
    // The bug this exists to prevent: the reconciliation poll records
    // not_closed every 60s for as long as the gate stays open. Re-arming on
    // each would push the deadline back a minute at a time, forever, and the
    // alert would never fire at all.
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => { setTimeout(r, ALERT_MS / 5); });
      adapter.record('not_closed', 'poll', clock.now());
    }

    await settle();
    stop();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('never repeats while the gate stays open', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    await settle();
    adapter.record('not_closed', 'poll', clock.now());
    await settle();
    adapter.record('not_closed', 'poll', clock.now());
    await settle();
    stop();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('warns again only after a confirmed close and a fresh opening', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    await settle();
    expect(notify).toHaveBeenCalledTimes(1);

    adapter.record('closed', 'webhook', clock.now());
    adapter.record('not_closed', 'webhook', clock.now());
    await settle();
    stop();

    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('is not cancelled by a pulse', async () => {
    // markUnknown says the gate is MOVING, not that it closed -- and tapping a
    // moving gate stops it, which leaves it open. Only a confirmed close
    // clears the alarm.
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    adapter.markUnknown();
    adapter.record('not_closed', 'webhook', clock.now());

    await settle();
    stop();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stays silent when the position can no longer be confirmed', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    // The controller drops mid-countdown. "Open for five minutes" is not
    // something we can say about a position we cannot currently read.
    adapter.setOnline(false);

    await settle();
    expect(notify).not.toHaveBeenCalled();

    // ...and the alert was never spent, so a recovery still warns.
    adapter.setOnline(true);
    adapter.record('not_closed', 'poll', clock.now());
    await settle();
    stop();

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('cancels when the gate closes before the deadline', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    adapter.record('closed', 'webhook', clock.now());

    await settle();
    stop();
    expect(notify).not.toHaveBeenCalled();
  });

  it('fires nothing once stopped', async () => {
    const { clock, adapter, notify, stop } = build();

    adapter.record('not_closed', 'webhook', clock.now());
    stop();

    await settle();
    expect(notify).not.toHaveBeenCalled();
    expect(adapter.onReading).toBeUndefined();
  });
});
