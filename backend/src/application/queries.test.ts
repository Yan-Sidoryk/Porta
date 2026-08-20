import { describe, expect, it } from 'vitest';
import { GetGateStatusUseCase, ListAuditEventsUseCase, MAX_AUDIT_PAGE } from './queries.js';
import { FakeAuditLog, FakeClock, FakeGateState } from '../../test/fakes.js';
import type { AuditEntry } from '../domain/ports.js';

const NOW = new Date('2026-08-20T12:00:00Z');

describe('GetGateStatusUseCase', () => {
  it('passes the adapter reading through', async () => {
    const checkedAt = new Date('2026-08-20T11:59:00Z');
    const status = new GetGateStatusUseCase(
      new FakeGateState({ position: 'unknown', reachable: true, checkedAt }),
      new FakeClock(NOW),
    );
    expect(await status.execute()).toEqual({ position: 'unknown', reachable: true, checkedAt });
  });

  it('reports unreachable instead of throwing when the adapter fails', async () => {
    // A DNS blip must show as "gate unreachable", not as a 500 -- the app has
    // an honest state to display for the former and nothing for the latter.
    const status = new GetGateStatusUseCase(
      new FakeGateState(new Error('getaddrinfo ENOTFOUND shelly')),
      new FakeClock(NOW),
    );
    expect(await status.execute()).toEqual({ position: 'unknown', reachable: false, checkedAt: NOW });
  });
});

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  userId: 'u1',
  action: 'gate.trigger',
  outcome: 'error',
  errorCode: 'INTERNAL',
  idempotencyKey: 'key-1',
  createdAt: NOW,
  detail: 'auth_key=*** at Object.pulse (shelly/client.ts:61)',
  ...overrides,
});

describe('ListAuditEventsUseCase', () => {
  it('never returns the diagnostic detail', async () => {
    // `detail` is a redacted stack trace kept for the operator, not the app.
    // Redaction is best-effort; not shipping the field at all is not.
    const log = new FakeAuditLog();
    await log.append(entry());

    const [event] = await new ListAuditEventsUseCase(log).execute(10);

    expect(event).not.toHaveProperty('detail');
    expect(event).not.toHaveProperty('idempotencyKey');
    expect(event).toMatchObject({ action: 'gate.trigger', outcome: 'error', errorCode: 'INTERNAL' });
  });

  it('clamps an oversized page', async () => {
    const log = new FakeAuditLog();
    let asked = 0;
    log.listRecent = async (limit) => { asked = limit; return []; };

    await new ListAuditEventsUseCase(log).execute(10_000_000);

    expect(asked).toBe(MAX_AUDIT_PAGE);
  });

  it('falls back to the page size for a nonsense limit', async () => {
    const log = new FakeAuditLog();
    let asked = 0;
    log.listRecent = async (limit) => { asked = limit; return []; };

    await new ListAuditEventsUseCase(log).execute(Number.NaN);
    expect(asked).toBe(MAX_AUDIT_PAGE);

    await new ListAuditEventsUseCase(log).execute(0);
    expect(asked).toBe(1);
  });
});
