import { beforeEach, describe, expect, it } from 'vitest';
import type { ClockPort, CommandGuardPort } from '../src/domain/ports.js';
import { IDEMPOTENCY_WINDOW_MS, UNCONFIRMED_COOLDOWN_MULTIPLIER } from '../src/domain/constants.js';

/** A clock the contract can move forward, so it can probe cooldown edges deterministically. */
export interface ControllableClock extends ClockPort {
  advance(ms: number): void;
}

const COOLDOWN = 5000;
const WINDOW_MS = COOLDOWN * UNCONFIRMED_COOLDOWN_MULTIPLIER;
const KEY = 'aaaaaaaa-1111-2222-3333-444444444444';
const KEY2 = 'bbbbbbbb-1111-2222-3333-444444444444';
const KEY3 = 'cccccccc-1111-2222-3333-444444444444';

const claim = (guard: CommandGuardPort, key: string) =>
  guard.tryClaim({ idempotencyKey: key, cooldownMs: COOLDOWN, idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS });

/**
 * Runs one identical suite of behavioural assertions against any CommandGuardPort
 * implementation. Both the in-memory FakeGuard (Task 4) and the real SqliteCommandGuard
 * (Task 7) must satisfy this contract, so the two can never silently drift apart.
 */
export function runCommandGuardContract(
  factory: () => { guard: CommandGuardPort; clock: ControllableClock },
): void {
  describe('CommandGuardPort contract', () => {
    let guard: CommandGuardPort;
    let clock: ControllableClock;

    beforeEach(() => {
      ({ guard, clock } = factory());
    });

    it('grants a first claim', async () => {
      const r = await claim(guard, KEY);
      expect(r.kind).toBe('granted');
    });

    it('holds the 2x window at claim time -- still cooling just past 1x', async () => {
      await claim(guard, KEY);
      clock.advance(COOLDOWN + 1); // past 1x
      const r = await claim(guard, KEY2);
      expect(r.kind).toBe('cooling-down');
    });

    it('narrows to the 1x window after a CONFIRMED outcome', async () => {
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'success');
      clock.advance(COOLDOWN + 1); // past 1x
      const r = await claim(guard, KEY2);
      expect(r.kind).toBe('granted');
    });

    it('leaves the 2x window intact after a timeout outcome', async () => {
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'timeout');
      clock.advance(COOLDOWN + 1); // past 1x, still inside 2x
      const r = await claim(guard, KEY2);
      expect(r.kind).toBe('cooling-down');
    });

    it('keeps the 2x window for an abandoned claim that is never released', async () => {
      await claim(guard, KEY);
      clock.advance(COOLDOWN + 1); // past 1x, still inside 2x
      const r = await claim(guard, KEY2);
      expect(r.kind).toBe('cooling-down');
    });

    it('replays the same key inside the idempotency window instead of cooling down', async () => {
      // Ordering rule: idempotency is evaluated BEFORE cooldown. The retry lands
      // while its own claim is still cooling (same key), and must still be a
      // replay, never a cooling-down rejection.
      await claim(guard, KEY);
      const r = await claim(guard, KEY);
      expect(r.kind).toBe('replayed');
    });

    it('reports pending for a replay of an unreleased claim', async () => {
      await claim(guard, KEY);
      const r = await claim(guard, KEY);
      expect(r).toMatchObject({ kind: 'replayed', outcome: 'pending' });
    });

    it("reports the released claim's original outcome for a replay", async () => {
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'device-offline');
      const r = await claim(guard, KEY);
      expect(r).toMatchObject({ kind: 'replayed', outcome: 'device-offline' });
    });

    // release() is once-only: the first outcome recorded wins and any later
    // call is a no-op. Asserted purely through tryClaim, since the contract
    // cannot see either implementation's stored state.
    it('does not narrow the window twice when a confirmed release is repeated', async () => {
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'success');
      await guard.release(first.claimId, 'success');

      // Halving twice would land the window at COOLDOWN / 2, so a probe just
      // inside 1x would be granted instead of cooling down.
      clock.advance(COOLDOWN - 1);
      expect((await claim(guard, KEY2)).kind).toBe('cooling-down');

      clock.advance(2); // now just past 1x
      expect((await claim(guard, KEY3)).kind).toBe('granted');
    });

    it('does not let a confirmed release arriving after a timeout narrow the window', async () => {
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'timeout');
      await guard.release(first.claimId, 'success');

      clock.advance(COOLDOWN + 1); // past 1x -- would be granted had it narrowed
      expect((await claim(guard, KEY2)).kind).toBe('cooling-down');

      clock.advance(COOLDOWN); // now past 2x
      expect((await claim(guard, KEY3)).kind).toBe('granted');
    });

    it('keeps the confirmed outcome when a timeout release arrives after it', async () => {
      // A late timeout must not overwrite a recorded success, or a client
      // retrying its key is told the pulse failed when the gate really moved.
      const first = await claim(guard, KEY);
      if (first.kind !== 'granted') throw new Error('expected granted');
      await guard.release(first.claimId, 'success');
      await guard.release(first.claimId, 'timeout');

      const replay = await claim(guard, KEY);
      expect(replay).toMatchObject({ kind: 'replayed', outcome: 'success' });
    });

    it('counts retryAfterMs down from real elapsed time', async () => {
      await claim(guard, KEY);

      clock.advance(1000);
      const r1 = await claim(guard, KEY2);
      if (r1.kind !== 'cooling-down') throw new Error('expected cooling-down');
      expect(r1.retryAfterMs).toBe(WINDOW_MS - 1000);

      clock.advance(2000);
      const r2 = await claim(guard, KEY3);
      if (r2.kind !== 'cooling-down') throw new Error('expected cooling-down');
      expect(r2.retryAfterMs).toBe(WINDOW_MS - 3000);
      expect(r2.retryAfterMs).toBeLessThan(r1.retryAfterMs);
    });
  });
}
