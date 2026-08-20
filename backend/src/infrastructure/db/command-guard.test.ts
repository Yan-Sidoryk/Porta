import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from './open.js';
import { SqliteCommandGuard } from './command-guard.js';
import { FakeClock } from '../../../test/fakes.js';
import { runCommandGuardContract } from '../../../test/command-guard-contract.js';
import {
  IDEMPOTENCY_WINDOW_MS,
  UNCONFIRMED_COOLDOWN_MULTIPLIER,
} from '../../domain/constants.js';

// The same behavioural contract the in-memory FakeGuard satisfies (Task 4),
// run against the real database. Assertions live in the contract, never here.
runCommandGuardContract(() => {
  const clock = new FakeClock();
  return { guard: new SqliteCommandGuard(openDatabase(':memory:'), clock), clock };
});

const COOLDOWN_MS = 5_000;
const claimParams = (idempotencyKey: string) => ({
  idempotencyKey,
  cooldownMs: COOLDOWN_MS,
  idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
});

const opened: Database.Database[] = [];
const dirs: string[] = [];

/** An on-disk database, because :memory: cannot be shared between handles. */
function onDiskPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-guard-test-'));
  dirs.push(dir);
  return join(dir, 'gate.sqlite3');
}

function open(path: string): Database.Database {
  const db = openDatabase(path);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SqliteCommandGuard (sqlite-specific)', () => {
  it('grants exactly one of many claims that all see the same instant', async () => {
    // NOTE ON WHAT THIS PROVES. better-sqlite3 is synchronous, so these
    // promises do NOT interleave -- they run one after another on the single
    // JS thread. What this establishes is that N distinct keys arriving at
    // the SAME clock instant produce exactly one grant: the losers are
    // rejected on the state the winner just committed, not on a stale read.
    // It does NOT prove OS-level atomicity; the IMMEDIATE-lock test below
    // covers the part that a single-threaded test cannot.
    const clock = new FakeClock();
    const guard = new SqliteCommandGuard(open(onDiskPath()), clock);

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => guard.tryClaim(claimParams(`key-${i}`))),
    );

    expect(results.filter((r) => r.kind === 'granted')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'cooling-down')).toHaveLength(7);
  });

  it('takes the write lock at BEGIN, not lazily at the first write', async () => {
    // Two connections on one file. `holder` parks a write transaction open.
    // A deferred BEGIN would sail through its SELECT and only discover the
    // conflict when it tried to INSERT -- and a read-to-write upgrade fails
    // with SQLITE_BUSY *immediately*, without consulting the busy handler.
    // BEGIN IMMEDIATE instead blocks on the write lock up front, so the busy
    // handler runs and the call spends the whole busy_timeout waiting.
    // Elapsed time is therefore the observable difference between the two.
    const path = onDiskPath();
    const holder = open(path);
    const contender = open(path);
    const busyTimeoutMs = 400;
    contender.pragma(`busy_timeout = ${busyTimeoutMs}`);

    const guard = new SqliteCommandGuard(contender, new FakeClock());

    holder.exec('BEGIN IMMEDIATE');
    const startedAt = Date.now();
    let elapsedMs = 0;
    let error: unknown;
    try {
      await guard.tryClaim(claimParams('blocked-key'));
    } catch (e) {
      error = e;
    } finally {
      elapsedMs = Date.now() - startedAt;
      holder.exec('ROLLBACK');
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/database is locked/i);
    expect(elapsedMs).toBeGreaterThanOrEqual(busyTimeoutMs * 0.5);

    // ...and nothing was written while the lock was held.
    const rows = contender
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM command_claims')
      .get();
    expect(rows?.c).toBe(0);
  });

  it('honours a cooldown written by a previous handle on the same file', async () => {
    // A crash-and-restart must not hand out a fresh pulse immediately.
    const path = onDiskPath();
    const clock = new FakeClock();

    const first = open(path);
    const granted = await new SqliteCommandGuard(first, clock).tryClaim(claimParams('key-a'));
    expect(granted.kind).toBe('granted');
    first.close();
    opened.splice(opened.indexOf(first), 1);

    // Fresh process, fresh handle, same file, no in-memory state at all.
    const reopened = new SqliteCommandGuard(open(path), clock);
    clock.advance(COOLDOWN_MS + 1); // past 1x, still inside the unconfirmed window
    expect((await reopened.tryClaim(claimParams('key-b'))).kind).toBe('cooling-down');

    clock.advance(COOLDOWN_MS * (UNCONFIRMED_COOLDOWN_MULTIPLIER - 1));
    expect((await reopened.tryClaim(claimParams('key-c'))).kind).toBe('granted');
  });

  it('derives retryAfterMs from the stored row, not from memory', async () => {
    const db = open(onDiskPath());
    const clock = new FakeClock();
    const guard = new SqliteCommandGuard(db, clock);

    await guard.tryClaim(claimParams('key-a'));

    const stored = db
      .prepare<[], { cooling_until: number }>('SELECT cooling_until FROM command_claims')
      .get();
    if (!stored) throw new Error('expected a persisted claim row');

    clock.advance(1_234);
    const rejected = await guard.tryClaim(claimParams('key-b'));
    if (rejected.kind !== 'cooling-down') throw new Error('expected cooling-down');

    expect(rejected.retryAfterMs).toBe(stored.cooling_until - clock.now().getTime());

    // Corrupt the stored row and the answer must follow it -- proving the
    // number is read back from sqlite rather than recomputed in memory.
    const bumped = stored.cooling_until + 7_777;
    db.prepare<[number], unknown>('UPDATE command_claims SET cooling_until = ?').run(bumped);
    const again = await guard.tryClaim(claimParams('key-c'));
    if (again.kind !== 'cooling-down') throw new Error('expected cooling-down');
    expect(again.retryAfterMs).toBe(bumped - clock.now().getTime());
  });

  describe('release is once-only', () => {
    // Every assertion here reads cooling_until straight out of the row. A
    // weaker check -- "a later tryClaim still cools down" -- would pass even
    // if the window had silently halved, which is the bug being guarded.
    const coolingUntil = (db: Database.Database): number => {
      const row = db
        .prepare<[], { cooling_until: number }>('SELECT cooling_until FROM command_claims')
        .get();
      if (!row) throw new Error('expected a persisted claim row');
      return row.cooling_until;
    };

    const grantOne = async (db: Database.Database, clock: FakeClock): Promise<string> => {
      const first = await new SqliteCommandGuard(db, clock).tryClaim(claimParams('key-a'));
      if (first.kind !== 'granted') throw new Error('expected granted');
      return first.claimId;
    };

    it('does not narrow the window twice on a repeated confirmed release', async () => {
      const db = open(onDiskPath());
      const clock = new FakeClock();
      const guard = new SqliteCommandGuard(db, clock);
      const claimId = await grantOne(db, clock);
      const claimedAt = clock.now().getTime();

      await guard.release(claimId, 'success');
      const afterFirst = coolingUntil(db);
      expect(afterFirst).toBe(claimedAt + COOLDOWN_MS);

      await guard.release(claimId, 'success');
      expect(coolingUntil(db)).toBe(afterFirst);
    });

    it('leaves the 2x window alone on a repeated timeout release', async () => {
      const db = open(onDiskPath());
      const clock = new FakeClock();
      const guard = new SqliteCommandGuard(db, clock);
      const claimId = await grantOne(db, clock);
      const unconfirmed = clock.now().getTime() + COOLDOWN_MS * UNCONFIRMED_COOLDOWN_MULTIPLIER;

      await guard.release(claimId, 'timeout');
      expect(coolingUntil(db)).toBe(unconfirmed);

      await guard.release(claimId, 'timeout');
      expect(coolingUntil(db)).toBe(unconfirmed);
    });

    it('keeps the confirmed outcome when a late timeout release arrives', async () => {
      // The mirror of the case below, and the ONLY case in which the timeout
      // branch's `outcome IS NULL` is load-bearing: that branch writes just
      // `outcome`, never `cooling_until`, so repeating it is inherently a
      // no-op. What the guard prevents is a late timeout OVERWRITING a
      // recorded success -- which would tell a retrying client its pulse
      // timed out when the gate had in fact moved.
      const db = open(onDiskPath());
      const clock = new FakeClock();
      const guard = new SqliteCommandGuard(db, clock);
      const claimId = await grantOne(db, clock);
      const narrowed = clock.now().getTime() + COOLDOWN_MS;

      await guard.release(claimId, 'success');
      await guard.release(claimId, 'timeout');

      expect(coolingUntil(db)).toBe(narrowed);
      expect(await guard.tryClaim(claimParams('key-a'))).toMatchObject({
        kind: 'replayed',
        outcome: 'success',
      });
    });

    it('keeps the timeout window when a confirmed release arrives afterwards', async () => {
      // The first outcome recorded is the real one; a later arrival is a
      // duplicate, not new evidence, so it must not narrow an unconfirmed
      // window that a timeout already claimed.
      const db = open(onDiskPath());
      const clock = new FakeClock();
      const guard = new SqliteCommandGuard(db, clock);
      const claimId = await grantOne(db, clock);
      const unconfirmed = clock.now().getTime() + COOLDOWN_MS * UNCONFIRMED_COOLDOWN_MULTIPLIER;

      await guard.release(claimId, 'timeout');
      await guard.release(claimId, 'success');

      expect(coolingUntil(db)).toBe(unconfirmed);
      clock.advance(COOLDOWN_MS + 1); // past 1x -- would be granted had it narrowed
      expect((await guard.tryClaim(claimParams('key-b'))).kind).toBe('cooling-down');
    });
  });

  it('stops replaying once the idempotency window lapses', async () => {
    const clock = new FakeClock();
    const guard = new SqliteCommandGuard(open(onDiskPath()), clock);

    const first = await guard.tryClaim(claimParams('key-a'));
    if (first.kind !== 'granted') throw new Error('expected granted');
    await guard.release(first.claimId, 'success');

    clock.advance(IDEMPOTENCY_WINDOW_MS + 1);
    expect((await guard.tryClaim(claimParams('key-a'))).kind).toBe('granted');
  });
});
