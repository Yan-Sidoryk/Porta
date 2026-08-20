import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './open.js';
import { SqliteUserRepository } from './user-repository.js';
import { SqliteAccessGrantRepository } from './grant-repository.js';
import { SqliteAuditLog } from './audit-log.js';

const setup = () => {
  const db = openDatabase(':memory:');
  return {
    db,
    users: new SqliteUserRepository(db),
    grants: new SqliteAccessGrantRepository(db),
    audit: new SqliteAuditLog(db),
  };
};

describe('SqliteUserRepository', () => {
  it('round-trips a user', async () => {
    const { users } = setup();
    const createdAt = new Date('2026-08-19T12:00:00.123Z');
    await users.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt });
    const found = await users.findByEmail('a@b.c');
    expect(found?.id).toBe('u1');
    expect(found?.disabled).toBe(false);
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.createdAt.getTime()).toBe(createdAt.getTime());
  });

  it('returns null for an unknown email', async () => {
    const { users } = setup();
    expect(await users.findByEmail('nobody@x.c')).toBeNull();
  });
});

describe('SqliteAccessGrantRepository', () => {
  it('issues, lists, and revokes a grant', async () => {
    const { users, grants } = setup();
    await users.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt: new Date() });
    const startsAt = new Date('2026-08-19T00:00:00Z');
    const endsAt = new Date('2026-08-20T00:00:00Z');
    await grants.issue({ id: 'g1', userId: 'u1', startsAt, endsAt, createdBy: 'u1', revokedAt: null });

    const listed = await grants.listForUser('u1');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.revokedAt).toBeNull();
    expect(listed[0]?.startsAt.getTime()).toBe(startsAt.getTime());

    const revokedAt = new Date('2026-08-19T06:00:00Z');
    await grants.revoke('g1', revokedAt);
    const afterRevoke = await grants.listForUser('u1');
    expect(afterRevoke[0]?.revokedAt).toBeInstanceOf(Date);
    expect(afterRevoke[0]?.revokedAt?.getTime()).toBe(revokedAt.getTime());
  });
});

describe('SqliteAuditLog', () => {
  it('appends and lists with the user email joined', async () => {
    const { users, audit } = setup();
    await users.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt: new Date() });
    await audit.append({ userId: 'u1', action: 'gate.trigger', outcome: 'success', errorCode: null, idempotencyKey: 'k', createdAt: new Date(), detail: null });
    const recent = await audit.listRecent(10);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.userEmail).toBe('a@b.c');
  });

  it('tolerates a null user id for unknown-user attempts', async () => {
    const { audit } = setup();
    await audit.append({ userId: null, action: 'gate.trigger', outcome: 'denied', errorCode: 'USER_UNKNOWN', idempotencyKey: 'k', createdAt: new Date(), detail: null });
    expect((await audit.listRecent(10))[0]?.userEmail).toBeNull();
  });

  it('round-trips a detail string intact', async () => {
    const { audit } = setup();
    const detail = 'device offline: connect ECONNREFUSED 10.0.0.5:80';
    await audit.append({ userId: null, action: 'gate.trigger', outcome: 'failed', errorCode: 'DEVICE_OFFLINE', idempotencyKey: 'k', createdAt: new Date(), detail });
    const recent = await audit.listRecent(10);
    expect(recent[0]?.detail).toBe(detail);
  });

  it('honours the limit and returns rows oldest-first, newest-last', async () => {
    const { audit } = setup();
    const base = new Date('2026-08-19T00:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await audit.append({
        userId: null,
        action: `action-${i}`,
        outcome: 'success',
        errorCode: null,
        idempotencyKey: null,
        createdAt: new Date(base + i * 1000),
        detail: null,
      });
    }
    const recent = await audit.listRecent(3);
    expect(recent).toHaveLength(3);
    // The 3 most recent (action-2, action-3, action-4), oldest-first.
    expect(recent.map((r) => r.action)).toEqual(['action-2', 'action-3', 'action-4']);
  });
});

describe('openDatabase', () => {
  it('is idempotent -- opening the same on-disk database twice does not error or duplicate tables', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-db-test-'));
    const dbPath = join(dir, 'gate.sqlite3');
    try {
      const db1 = openDatabase(dbPath);
      const users1 = new SqliteUserRepository(db1);
      await users1.create({ id: 'u1', email: 'a@b.c', passwordHash: 'h', role: 'owner', disabled: false, createdAt: new Date() });
      db1.close();

      // Re-opening the same file re-runs schema.sql (all IF NOT EXISTS).
      // Must not throw and must not duplicate the users table or lose data.
      let db2: ReturnType<typeof openDatabase> | undefined;
      expect(() => {
        db2 = openDatabase(dbPath);
      }).not.toThrow();

      const tableCount = db2!
        .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'users'")
        .get() as { c: number };
      expect(tableCount.c).toBe(1);

      const found = await new SqliteUserRepository(db2!).findByEmail('a@b.c');
      expect(found?.id).toBe('u1');
      db2!.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
