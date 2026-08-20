import { describe, expect, it } from 'vitest';
import { AuditedTriggerGate } from './audited-trigger.js';
import type { TriggerGate, TriggerResult } from './trigger-gate.js';
import { FakeAuditLog, FakeClock } from '../../test/fakes.js';
import { redact } from '../infrastructure/redact.js';

const KEY = '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f';
const stub = (r: TriggerResult): TriggerGate => ({ execute: async () => r });

describe('AuditedTriggerGate', () => {
  it('audits a success', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: true, outcome: 'success', replayed: false }), log, new FakeClock(), redact);
    await g.execute('u1', KEY);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({ userId: 'u1', outcome: 'success', errorCode: null });
  });

  // The reason auditing is a wrapper: these paths return EARLY.
  it('audits an access denial', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: false, code: 'ACCESS_DENIED', replayed: false }), log, new FakeClock(), redact);
    await g.execute('u1', KEY);
    expect(log.entries[0]).toMatchObject({ outcome: 'denied', errorCode: 'ACCESS_DENIED' });
  });

  it('audits an unknown user', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: false, code: 'USER_UNKNOWN', replayed: false }), log, new FakeClock(), redact);
    await g.execute('ghost', KEY);
    expect(log.entries[0]).toMatchObject({ userId: 'ghost', errorCode: 'USER_UNKNOWN' });
  });

  it('audits an unexpected throw and rethrows it', async () => {
    const log = new FakeAuditLog();
    const boom: TriggerGate = { execute: async () => { throw new Error('kaboom'); } };
    const g = new AuditedTriggerGate(boom, log, new FakeClock(), redact);
    await expect(g.execute('u1', KEY)).rejects.toThrow('kaboom');
    expect(log.entries[0]).toMatchObject({ outcome: 'error', errorCode: 'INTERNAL' });
  });

  it('records the idempotency key', async () => {
    const log = new FakeAuditLog();
    const g = new AuditedTriggerGate(stub({ ok: true, outcome: 'success', replayed: false }), log, new FakeClock(), redact);
    await g.execute('u1', KEY);
    expect(log.entries[0]?.idempotencyKey).toBe(KEY);
  });

  it('redacts a Shelly auth_key leaked in a poisoned adapter stack before persisting it', async () => {
    const log = new FakeAuditLog();
    const poisonedStack =
      'FetchError: request to https://shelly-280-eu.shelly.cloud/v2/devices/api/set/switch?auth_key=SUPERSECRETKEY123 failed\n' +
      '    at ClientRequest.<anonymous> (/app/node_modules/node-fetch/lib/index.js:1491:11)';
    const g = new AuditedTriggerGate(
      stub({ ok: false, code: 'INTERNAL', replayed: false, internalDetail: poisonedStack }),
      log, new FakeClock(), redact,
    );
    await g.execute('u1', KEY);
    const entry = log.entries[0];
    expect(entry?.detail).not.toContain('SUPERSECRETKEY123');
    expect(entry?.detail).toContain('***');
  });

  it('redacts an auth_key that appears mid-URL, followed by another query param', async () => {
    const log = new FakeAuditLog();
    const midUrlStack =
      'FetchError: request to https://shelly-280-eu.shelly.cloud/v2/devices/api/set/switch?auth_key=MIDURLSECRET&channel=0 failed';
    const g = new AuditedTriggerGate(
      stub({ ok: false, code: 'INTERNAL', replayed: false, internalDetail: midUrlStack }),
      log, new FakeClock(), redact,
    );
    await g.execute('u1', KEY);
    const entry = log.entries[0];
    expect(entry?.detail).not.toContain('MIDURLSECRET');
    expect(entry?.detail).toContain('***');
    expect(entry?.detail).toContain('channel=0');
  });
});
