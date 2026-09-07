import { describe, expect, it } from 'vitest';
import type { GateStatusResponse } from '@gate/shared';
import {
  canTap, controllerView, cooldownProgress, formatClock, formatStamp,
  isAwaitingReading, messageFor, nextState, positionBanner, secondsLeft, shouldRelock,
  tapIsFinished, type GateUiState,
} from './gate-machine';

const NOW = 1_700_000_000_000;
const COOLDOWN = 5000;

describe('nextState', () => {
  it('starts the cooldown from the server number on success', () => {
    const s = nextState({ ok: true, outcome: 'success', replayed: false, retryAfterMs: COOLDOWN }, NOW);
    expect(s).toEqual({
      kind: 'success', until: NOW + COOLDOWN, totalMs: COOLDOWN, replayed: false,
    });
  });

  // The whole reason the field was added to the success response: without it
  // the commonest path leaves the button live for an immediate second tap.
  it('keeps the button locked for the full server window after a success', () => {
    const s = nextState({ ok: true, outcome: 'success', replayed: false, retryAfterMs: COOLDOWN }, NOW);
    expect(canTap(s, NOW)).toBe(false);
    expect(canTap(s, NOW + COOLDOWN - 1)).toBe(false);
    expect(canTap(s, NOW + COOLDOWN)).toBe(true);
  });

  it('honours a DOUBLED window after an ambiguous timeout, not a guessed 5s', () => {
    const doubled = COOLDOWN * 2;
    const s = nextState(
      { ok: false, code: 'GATE_COOLING_DOWN', message: 'x', replayed: false, retryAfterMs: doubled },
      NOW,
    );
    // A client that assumed 5s would re-enable here while the server still says no.
    expect(canTap(s, NOW + COOLDOWN)).toBe(false);
    expect(canTap(s, NOW + doubled)).toBe(true);

    // And the ring must fill across the DOUBLED window, not race to full at 5s.
    if (s.kind !== 'error' || s.until === undefined) throw new Error('expected a cooling error');
    expect(cooldownProgress(s.until, NOW + COOLDOWN, s.totalMs ?? 0)).toBeCloseTo(0.5);
  });

  it('treats ATTEMPT_IN_PROGRESS as still sending, never as an error', () => {
    const s = nextState(
      { ok: false, code: 'ATTEMPT_IN_PROGRESS', message: 'x', replayed: true },
      NOW,
    );
    expect(s.kind).toBe('sending');
    expect(canTap(s, NOW + 60_000)).toBe(false);
  });

  it('maps a failure to plain language and leaves the button live', () => {
    const s = nextState(
      { ok: false, code: 'DEVICE_OFFLINE', message: 'The gate controller is offline.', replayed: false },
      NOW,
    );
    expect(s.kind).toBe('error');
    if (s.kind !== 'error') throw new Error('expected an error state');
    expect(s.message).toContain('offline');
    expect(s.until).toBeUndefined();
    // Nothing is cooling down, so the user may try again immediately.
    expect(canTap(s, NOW)).toBe(true);
  });

  it('reports an unreachable backend distinctly from a denied one', () => {
    expect(messageFor('NETWORK_UNREACHABLE')).not.toBe(messageFor('ACCESS_DENIED'));
    expect(messageFor('NETWORK_UNREACHABLE')).toMatch(/connection|signal|wi-?fi/i);
  });
});

describe('clock formatting', () => {
  // Built from local components so the assertions hold in any timezone.
  const at = (h: number, m: number): string => new Date(2026, 7, 21, h, m).toISOString();

  it('pads to a fixed width in 24-hour mode', () => {
    expect(formatClock(at(14, 32), true)).toBe('14:32');
    expect(formatClock(at(9, 5), true)).toBe('09:05');
  });

  it('turns midnight and noon into 12, not 0', () => {
    expect(formatClock(at(0, 15), false)).toBe('12:15 am');
    expect(formatClock(at(12, 15), false)).toBe('12:15 pm');
  });

  it('wraps the afternoon back to 1-11', () => {
    expect(formatClock(at(13, 0), false)).toBe('1:00 pm');
    expect(formatClock(at(23, 45), false)).toBe('11:45 pm');
  });

  it('puts the date in front for log rows', () => {
    expect(formatStamp(at(14, 32), true)).toBe('21 Aug 14:32');
    expect(formatStamp(at(14, 32), false)).toBe('21 Aug 2:32 pm');
  });
});

describe('shouldRelock', () => {
  it('does not re-lock a foreground app, however long it has run', () => {
    expect(shouldRelock(null, NOW)).toBe(false);
    expect(shouldRelock(null, NOW + 60 * 60_000)).toBe(false);
  });

  it('re-locks once the grace period has fully elapsed', () => {
    const grace = 15_000;
    expect(shouldRelock(NOW, NOW + grace - 1, grace)).toBe(false);
    expect(shouldRelock(NOW, NOW + grace, grace)).toBe(true);
    expect(shouldRelock(NOW, NOW + 60_000, grace)).toBe(true);
  });
});

describe('controllerView', () => {
  const CHECKED = '2026-08-21T10:00:00.000Z';
  const reading = (over: Partial<GateStatusResponse>): GateStatusResponse => ({
    position: 'unknown', reachable: true, checkedAt: CHECKED, lastReading: null, ...over,
  });

  const seen = { position: 'closed' as const, at: CHECKED };

  it('reports online and offline from a real reading', () => {
    expect(controllerView(reading({ reachable: true, position: 'closed', lastReading: seen })))
      .toEqual({ kind: 'online', seen: { at: CHECKED, current: true } });
    expect(controllerView(reading({ reachable: false, lastReading: seen })))
      .toEqual({ kind: 'offline', seen: { at: CHECKED, current: false } });
  });

  it('only says "Checked" while the reading is still being stood behind', () => {
    // The stamp is when a reading was last CONFIRMED, not when we last tried.
    // An unreachable controller labelled "Checked 15:02" claims a check that
    // had in fact just failed.
    const offline = controllerView(reading({ reachable: false, lastReading: seen }));
    const stale = controllerView(reading({ reachable: true, lastReading: seen }));
    const live = controllerView(reading({ reachable: true, position: 'closed', lastReading: seen }));

    expect(offline.kind === 'offline' && offline.seen?.current).toBe(false);
    // Online but stale counts too: the poll answered, the contact did not.
    expect(stale.kind === 'online' && stale.seen?.current).toBe(false);
    expect(live.kind === 'online' && live.seen?.current).toBe(true);
  });

  it('shows no time at all when no reading has ever been taken', () => {
    // checkedAt falls back to "now" with nothing recorded, and printing it
    // would date a reading that never happened.
    const view = controllerView(reading({ lastReading: null }));
    expect(view.kind === 'online' && view.seen).toBeNull();
  });

  // The bug this exists to prevent: a failed CHECK is not an offline
  // CONTROLLER, and saying so is a claim about hardware we never reached.
  it('never reports offline when the check itself failed', () => {
    expect(controllerView({ ok: false, code: 'RATE_LIMITED', message: 'x' }).kind)
      .toBe('unreadable');
    expect(controllerView({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' }).kind)
      .toBe('unreadable');
  });

  it('is checking, not offline, before the first reading lands', () => {
    expect(controllerView(null)).toEqual({ kind: 'checking' });
  });
});

describe('positionBanner', () => {
  const CHECKED = '2026-08-21T10:00:00.000Z';
  const reading = (over: Partial<GateStatusResponse>): GateStatusResponse => ({
    position: 'unknown', reachable: true, checkedAt: CHECKED, lastReading: null, ...over,
  });

  it('reads at a glance: CLOSED green, OPEN red, UNKNOWN muted', () => {
    expect(positionBanner(reading({ position: 'closed' })))
      .toEqual({ text: 'CLOSED', tone: 'ok' });

    // 'not_closed' renders OPEN deliberately -- see the doc comment. The
    // precise word survives on the wire; the driver gets the readable one.
    expect(positionBanner(reading({ position: 'not_closed' })))
      .toEqual({ text: 'OPEN', tone: 'alert' });

    expect(positionBanner(reading({ position: 'unknown' })))
      .toEqual({ text: 'UNKNOWN', tone: 'muted' });
  });

  it('greys the last reading and labels it rather than dropping it', () => {
    // More useful than a bare UNKNOWN and no less honest: the word is what we
    // last saw, and the grey plus the label both say we no longer stand
    // behind it. Two carriers, so the doubt survives a colour-blind reader.
    expect(positionBanner(reading({ lastReading: { position: 'closed', at: CHECKED } })))
      .toEqual({ label: 'LAST SEEN', text: 'CLOSED', tone: 'muted' });

    expect(positionBanner(reading({ lastReading: { position: 'not_closed', at: CHECKED } })))
      .toEqual({ label: 'LAST SEEN', text: 'OPEN', tone: 'muted' });
  });

  it('keeps the position out of the wrapping half of the line', () => {
    // "LAST SEEN CLOSED" as one hero-sized string wraps wherever the phone is
    // narrow and could land as "LAST" / "SEEN CLOSED". The word that answers
    // the question has to be the one that stays whole.
    const banner = positionBanner(reading({ lastReading: { position: 'closed', at: CHECKED } }));
    expect(banner.text).toBe('CLOSED');
    expect(banner.text).not.toContain(' ');
  });

  it('repeats neither why the reading is unconfirmed nor when it was taken', () => {
    // StatusPanel above carries both -- "Controller offline" and
    // "Last seen 21:34". Saying either twice makes the screen slower to read,
    // which is the one thing this element cannot afford.
    expect(positionBanner(
      reading({ reachable: false, lastReading: { position: 'closed', at: CHECKED } }),
    )).toEqual({ label: 'LAST SEEN', text: 'CLOSED', tone: 'muted' });
  });

  it('falls back to UNKNOWN when there is nothing to have last seen', () => {
    expect(positionBanner(reading({ lastReading: null })))
      .toEqual({ text: 'UNKNOWN', tone: 'muted' });
  });

  // The bug this exists to prevent: showing the last cached position, with no
  // mark on it, when the app could not reach the backend at all.
  it('reports unknown when the check itself failed, never a cached value', () => {
    // No response means no reading at all, not even a stale one to mark
    // doubtful. StatusPanel carries the reason.
    expect(positionBanner({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' }))
      .toEqual({ text: 'UNKNOWN', tone: 'muted' });
    expect(positionBanner({ ok: false, code: 'INTERNAL', message: 'x' }))
      .toEqual({ text: 'UNKNOWN', tone: 'muted' });
  });

  it('is checking, not unknown, before the first reading lands', () => {
    expect(positionBanner(null)).toEqual({ text: 'CHECKING...', tone: 'muted' });
  });
});

describe('tapIsFinished', () => {
  it('keeps the tap alive only when the backend was never reached', () => {
    expect(tapIsFinished({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' })).toBe(false);
  });

  it('ends the tap on any definite answer, including a rejection', () => {
    expect(tapIsFinished({ ok: true, outcome: 'success', replayed: false })).toBe(true);
    expect(tapIsFinished({ ok: false, code: 'DEVICE_OFFLINE', message: 'x', replayed: false })).toBe(true);
    expect(tapIsFinished({ ok: false, code: 'GATE_COOLING_DOWN', message: 'x', replayed: false })).toBe(true);
  });
});

describe('the countdown', () => {
  it('rounds up, so 4001ms left reads as 5 and never as 0 while waiting', () => {
    expect(secondsLeft(NOW + 4001, NOW)).toBe(5);
    expect(secondsLeft(NOW + 1, NOW)).toBe(1);
    expect(secondsLeft(NOW, NOW)).toBe(0);
    expect(secondsLeft(NOW - 9999, NOW)).toBe(0);
  });

  it('sweeps from 0 to 1 across the window', () => {
    expect(cooldownProgress(NOW + COOLDOWN, NOW, COOLDOWN)).toBe(0);
    expect(cooldownProgress(NOW + COOLDOWN / 2, NOW, COOLDOWN)).toBeCloseTo(0.5);
    expect(cooldownProgress(NOW, NOW, COOLDOWN)).toBe(1);
  });

  it('stays inside 0..1 for a stale or zero window', () => {
    expect(cooldownProgress(NOW - 60_000, NOW, COOLDOWN)).toBe(1);
    expect(cooldownProgress(NOW + 60_000, NOW, 0)).toBe(1);
  });
});

describe('canTap', () => {
  it('allows a tap only when idle or once the window has passed', () => {
    expect(canTap({ kind: 'idle' }, NOW)).toBe(true);
    expect(canTap({ kind: 'sending' }, NOW)).toBe(false);
  });

  it('never re-enables mid-flight no matter how much time passes', () => {
    const sending: GateUiState = { kind: 'sending' };
    expect(canTap(sending, NOW + 10 * 60_000)).toBe(false);
  });
});
