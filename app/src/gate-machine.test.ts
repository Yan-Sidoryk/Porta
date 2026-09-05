import { describe, expect, it } from 'vitest';
import type { GateStatusResponse } from '@gate/shared';
import {
  canTap, cooldownProgress, formatAge, formatClock, formatStamp, gateStatusView,
  isAwaitingReading, messageFor, nextState, secondsLeft, shouldRelock, tapIsFinished,
  type GateUiState,
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

describe('gateStatusView', () => {
  const CHECKED = '2026-08-21T10:00:00.000Z';
  const NOW_MS = new Date(CHECKED).getTime();
  const reading = (over: Partial<GateStatusResponse>): GateStatusResponse => ({
    position: 'unknown', reachable: true, checkedAt: CHECKED, lastReading: null, ...over,
  });

  it('reports a measured position, and never calls not_closed "Open"', () => {
    expect(gateStatusView(reading({ position: 'closed' }), NOW_MS))
      .toMatchObject({ kind: 'closed', headline: 'Closed', checkedAt: CHECKED });

    // The whole point of the union. A gate stopped mid-travel, standing open,
    // and jammed on one leaf are the same reading -- "Open" would be a claim
    // about three situations and wrong in two.
    const notClosed = gateStatusView(reading({ position: 'not_closed' }), NOW_MS);
    expect(notClosed).toMatchObject({ kind: 'not-closed', headline: 'Not closed' });
    expect(JSON.stringify(notClosed)).not.toMatch(/open/i);
  });

  it('adds the age of the last reading once the current one goes stale', () => {
    const view = gateStatusView(
      reading({ position: 'unknown', lastReading: { position: 'closed', at: CHECKED } }),
      NOW_MS + 12 * 60_000,
    );
    expect(view.headline).toBe('Unknown');
    expect(view.note).toBe('Last seen closed 12 minutes ago.');
  });

  it('says the controller is offline rather than guessing at the gate', () => {
    const view = gateStatusView(
      reading({ reachable: false, lastReading: { position: 'closed', at: CHECKED } }),
      NOW_MS,
    );
    expect(view.headline).toBe('Unknown');
    expect(view.note).toBe('Controller offline.');
  });

  // The bug this exists to prevent: showing the last cached position, with no
  // age on it, when the app could not reach the backend at all.
  it('reports unknown when the check itself failed, never a cached value', () => {
    const noNetwork = gateStatusView({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' }, NOW_MS);
    const other = gateStatusView({ ok: false, code: 'INTERNAL', message: 'x' }, NOW_MS);

    expect(noNetwork).toMatchObject({ kind: 'unknown', headline: 'Unknown' });
    expect(other.kind).toBe('unknown');
    expect(noNetwork.checkedAt).toBeUndefined();
    expect(noNetwork.note).not.toBe(other.note);
  });

  it('is checking, not unknown, before the first reading lands', () => {
    expect(gateStatusView(null, NOW_MS)).toEqual({ kind: 'checking', headline: 'Checking...' });
  });
});

describe('isAwaitingReading', () => {
  const reading = (over: Partial<GateStatusResponse>): GateStatusResponse => ({
    position: 'unknown', reachable: true,
    checkedAt: '2026-08-21T10:00:00.000Z', lastReading: null, ...over,
  });

  it('keeps asking while the gate is mid-answer, and stops once it lands', () => {
    // The tap-then-watch case: the refresh fired straight after a pulse can
    // only say unknown, and without this the screen would sit on it.
    expect(isAwaitingReading(reading({ position: 'unknown' }))).toBe(true);

    expect(isAwaitingReading(reading({ position: 'closed' }))).toBe(false);
    expect(isAwaitingReading(reading({ position: 'not_closed' }))).toBe(false);
  });

  it('does not retry a backend it could not reach', () => {
    // A different problem from a moving gate, and a three-second timer aimed
    // at something already known to be down is a retry storm. Foreground and
    // pull-to-refresh still cover it.
    expect(isAwaitingReading({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' })).toBe(false);
    expect(isAwaitingReading({ ok: false, code: 'INTERNAL', message: 'x' })).toBe(false);
  });

  it('does not start before the first reading has landed', () => {
    // Mount already fetches; a second request racing it buys nothing.
    expect(isAwaitingReading(null)).toBe(false);
  });
});

describe('formatAge', () => {
  const AT = '2026-08-21T10:00:00.000Z';
  const age = (ms: number): string => formatAge(AT, new Date(AT).getTime() + ms);

  it('rounds down to the largest whole unit', () => {
    expect(age(0)).toBe('just now');
    expect(age(59_000)).toBe('just now');
    expect(age(60_000)).toBe('1 minute ago');
    expect(age(12 * 60_000)).toBe('12 minutes ago');
    expect(age(59 * 60_000 + 59_000)).toBe('59 minutes ago');
    expect(age(60 * 60_000)).toBe('1 hour ago');
    expect(age(25 * 60 * 60_000)).toBe('1 day ago');
  });

  it('never reports a negative age from a clock that ran backwards', () => {
    expect(age(-5_000)).toBe('just now');
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
