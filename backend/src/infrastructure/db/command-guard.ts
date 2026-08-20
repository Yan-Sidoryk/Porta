import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { PulseOutcome } from '@gate/shared';
import type { ClaimResult } from '../../domain/gate.js';
import type { ClockPort, CommandGuardPort } from '../../domain/ports.js';
import { UNCONFIRMED_COOLDOWN_MULTIPLIER } from '../../domain/constants.js';

interface ClaimRow {
  id: string;
  claimed_at: number;
  cooling_until: number;
  outcome: string | null;
}

interface CoolingRow {
  cooling_until: number;
}

export class SqliteCommandGuard implements CommandGuardPort {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: ClockPort,
  ) {}

  async tryClaim(params: {
    idempotencyKey: string;
    cooldownMs: number;
    idempotencyWindowMs: number;
  }): Promise<ClaimResult> {
    // Wall-clock, deliberately. A monotonic clock cannot be compared across a
    // process restart, and surviving a restart is the whole point of storing
    // the window in sqlite. The cost: an NTP step FORWARD larger than the
    // remaining window expires the cooldown early -- the one case where this
    // guard fails open. A backward step only widens the window, which is safe.
    const now = this.clock.now().getTime();

    // IMMEDIATE takes the write lock at transaction START, so the read and
    // the insert below are a single atomic step. A plain (deferred) BEGIN
    // upgrades its lock lazily at the first write, which leaves a window in
    // which two simultaneous taps both observe "no active cooldown" and both
    // pulse -- the second pulse stopping a heavy gate mid-travel.
    const claim = this.db.transaction((): ClaimResult => {
      // Idempotency is evaluated BEFORE cooldown: a retry carrying the same
      // key is the SAME command, so it must replay rather than be rejected
      // as cooling down by the very claim it is retrying.
      const replay = this.db
        .prepare<[string, number], ClaimRow>(
          `SELECT id, claimed_at, cooling_until, outcome FROM command_claims
            WHERE idempotency_key = ? AND claimed_at > ?
            ORDER BY claimed_at DESC LIMIT 1`,
        )
        .get(params.idempotencyKey, now - params.idempotencyWindowMs);

      if (replay) {
        return {
          kind: 'replayed',
          outcome: (replay.outcome as PulseOutcome | null) ?? 'pending',
        };
      }

      const cooling = this.db
        .prepare<[number], CoolingRow>(
          `SELECT cooling_until FROM command_claims
            WHERE cooling_until > ? ORDER BY cooling_until DESC LIMIT 1`,
        )
        .get(now);

      if (cooling) {
        return { kind: 'cooling-down', retryAfterMs: cooling.cooling_until - now };
      }

      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO command_claims (id, idempotency_key, claimed_at, cooling_until, outcome)
           VALUES (?, ?, ?, ?, NULL)`,
        )
        // Pessimistic by default: the full UNCONFIRMED_COOLDOWN_MULTIPLIER
        // window until an outcome is known. release() narrows it on evidence.
        .run(
          id,
          params.idempotencyKey,
          now,
          now + params.cooldownMs * UNCONFIRMED_COOLDOWN_MULTIPLIER,
        );

      return { kind: 'granted', claimId: id };
    });

    return claim.immediate();
  }

  async release(claimId: string, outcome: PulseOutcome): Promise<void> {
    // A CONFIRMED outcome narrows the window to 1x. 'timeout' does not: the
    // pulse may well have reached the gate, so the unconfirmed 2x window
    // written at claim time stands. An abandoned claim -- never released at
    // all -- keeps that same 2x, which is the point: every unknown resolves
    // conservatively, and no unknown is ever weaker than a timeout.
    // `outcome IS NULL` on BOTH branches makes release once-only: the first
    // outcome recorded wins and any later call is a no-op. Without it the
    // narrowing UPDATE is not idempotent -- applied twice it divides the
    // window twice (2x -> 1x -> 0.5x), silently halving the guard. The port
    // does not promise a single call, so a retry, a queue redelivery, or a
    // future adapter could reach it.
    if (outcome === 'timeout') {
      this.db
        .prepare(`UPDATE command_claims SET outcome = ? WHERE id = ? AND outcome IS NULL`)
        .run(outcome, claimId);
      return;
    }

    this.db
      .prepare(
        `UPDATE command_claims
            SET outcome = ?,
                cooling_until = claimed_at + (cooling_until - claimed_at) / ?
          WHERE id = ? AND outcome IS NULL`,
      )
      .run(outcome, UNCONFIRMED_COOLDOWN_MULTIPLIER, claimId);
  }
}
