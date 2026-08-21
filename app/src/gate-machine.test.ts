import { describe, expect, it } from 'vitest';
import {
  canTap, controllerView, cooldownProgress, messageFor, nextState, secondsLeft,
  shouldRelock, tapIsFinished, type GateUiState,
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

  it('reports online and offline from a real reading', () => {
    expect(controllerView({ position: 'unknown', reachable: true, checkedAt: CHECKED }))
      .toEqual({ kind: 'online', checkedAt: CHECKED });
    expect(controllerView({ position: 'unknown', reachable: false, checkedAt: CHECKED }))
      .toEqual({ kind: 'offline', checkedAt: CHECKED });
  });

  // The bug this exists to prevent: a failed CHECK is not an offline
  // CONTROLLER, and saying so is a claim about hardware we never reached.
  it('never reports offline when the check itself failed', () => {
    const rateLimited = controllerView({ ok: false, code: 'RATE_LIMITED', message: 'x' });
    expect(rateLimited.kind).toBe('unreadable');

    const noNetwork = controllerView({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' });
    expect(noNetwork.kind).toBe('unreadable');
  });

  it('distinguishes a missing connection from a failed check', () => {
    const noNetwork = controllerView({ ok: false, code: 'NETWORK_UNREACHABLE', message: 'x' });
    const other = controllerView({ ok: false, code: 'INTERNAL', message: 'x' });
    if (noNetwork.kind !== 'unreadable' || other.kind !== 'unreadable') {
      throw new Error('expected both to be unreadable');
    }
    expect(noNetwork.reason).not.toBe(other.reason);
  });

  it('is checking, not offline, before the first reading lands', () => {
    expect(controllerView(null)).toEqual({ kind: 'checking' });
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
