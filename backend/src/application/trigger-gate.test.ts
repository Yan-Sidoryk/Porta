import { beforeEach, describe, expect, it } from 'vitest';
import { TriggerGateUseCase } from './trigger-gate.js';
import { AuditedTriggerGate } from './audited-trigger.js';
import { RoleBasedAccessPolicy } from '../domain/access-policy.js';
import { redact } from '../infrastructure/redact.js';
import { FakeAuditLog, FakeClock, FakeGateCommand, FakeGrantRepo, FakeGuard, FakeUserRepo } from '../../test/fakes.js';
import type { User } from '../domain/user.js';
import type { GateCommandPort, UserRepositoryPort } from '../domain/ports.js';

const COOLDOWN = 5000;
const KEY = '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f';
const KEY2 = '11111111-2222-3333-4444-555555555555';

const owner: User = {
  id: 'owner1', email: 'o@x.c', passwordHash: 'h',
  role: 'owner', disabled: false, createdAt: new Date('2026-01-01'),
};

let clock: FakeClock, guard: FakeGuard, gate: FakeGateCommand, useCase: TriggerGateUseCase;

beforeEach(() => {
  clock = new FakeClock();
  guard = new FakeGuard(clock);
  gate = new FakeGateCommand();
  useCase = new TriggerGateUseCase(
    new FakeUserRepo([owner]), new FakeGrantRepo([]),
    new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
  );
});

describe('TriggerGateUseCase', () => {
  it('pulses once for an owner', async () => {
    const r = await useCase.execute('owner1', KEY);
    expect(r).toEqual({ ok: true, outcome: 'success', replayed: false });
    expect(gate.calls).toBe(1);
  });

  it('rejects an unknown user without pulsing', async () => {
    const r = await useCase.execute('nobody', KEY);
    expect(r).toMatchObject({ ok: false, code: 'USER_UNKNOWN' });
    expect(gate.calls).toBe(0);
  });

  it('rejects a user with no grant without pulsing', async () => {
    const u: User = { ...owner, id: 'u2', role: 'user' };
    const uc = new TriggerGateUseCase(
      new FakeUserRepo([u]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
    );
    const r = await uc.execute('u2', KEY);
    expect(r).toMatchObject({ ok: false, code: 'ACCESS_DENIED' });
    expect(gate.calls).toBe(0);
  });

  it('rejects a second tap inside the cooldown', async () => {
    await useCase.execute('owner1', KEY);
    clock.advance(2000);
    const r = await useCase.execute('owner1', KEY2);
    expect(r).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(r).toHaveProperty('retryAfterMs');
    expect(gate.calls).toBe(1);
  });

  it('replays an identical key without a second pulse', async () => {
    const first = await useCase.execute('owner1', KEY);
    const second = await useCase.execute('owner1', KEY);
    expect(second).toEqual({ ...first, replayed: true });
    expect(gate.calls).toBe(1);
  });

  it('propagates DEVICE_OFFLINE', async () => {
    gate.setResult({ outcome: 'device-offline' });
    const r = await useCase.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE' });
  });

  // THE critical safety test.
  it('rejects an immediate retry after a TIMEOUT, and holds the DOUBLED window', async () => {
    gate.setResult({ outcome: 'timeout' });
    const first = await useCase.execute('owner1', KEY);
    expect(first).toMatchObject({ ok: false, code: 'TIMEOUT_AMBIGUOUS' });
    expect(gate.calls).toBe(1);

    clock.advance(1000);
    const second = await useCase.execute('owner1', KEY2);
    expect(second).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(gate.calls).toBe(1);

    // Still cooling at 6s -- proves the 2x window, not 1x.
    clock.advance(5000);
    const third = await useCase.execute('owner1', '99999999-8888-7777-6666-555555555555');
    expect(third).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(gate.calls).toBe(1);
  });

  it('narrows to the 1x window after a confirmed success', async () => {
    await useCase.execute('owner1', KEY);
    clock.advance(COOLDOWN + 1);
    const r = await useCase.execute('owner1', KEY2);
    expect(r).toMatchObject({ ok: true });
    expect(gate.calls).toBe(2);
  });

  it('reports ATTEMPT_IN_PROGRESS when replaying an unreleased claim', async () => {
    const slow = new TriggerGateUseCase(
      new FakeUserRepo([owner]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
    );
    await guard.tryClaim({ idempotencyKey: KEY, cooldownMs: COOLDOWN, idempotencyWindowMs: 60_000 });
    const r = await slow.execute('owner1', KEY);
    // replayed: true -- the key was recognised and no pulse was sent, which is
    // exactly what "replayed" means even while the original attempt is pending.
    expect(r).toMatchObject({ ok: false, code: 'ATTEMPT_IN_PROGRESS', replayed: true });
    expect(gate.calls).toBe(0);
  });

  it('replays an identical key that previously failed, returning the original failure', async () => {
    gate.setResult({ outcome: 'device-offline' });
    const first = await useCase.execute('owner1', KEY);
    expect(first).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE', replayed: false });

    gate.setResult({ outcome: 'success' }); // must not matter -- no second pulse should happen
    const second = await useCase.execute('owner1', KEY);
    expect(second).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE', replayed: true });
    expect(gate.calls).toBe(1);
  });

  it('returns INTERNAL and never releases the claim when the pulse call throws', async () => {
    const throwingGate: GateCommandPort = {
      pulse: () => { throw new Error('relay HTTP failure'); },
    };
    const uc = new TriggerGateUseCase(
      new FakeUserRepo([owner]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, throwingGate, clock, COOLDOWN,
    );
    const r = await uc.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL', replayed: false });
    expect(guard.releaseCalls).toBe(0);
  });

  it('carries the bound error as internalDetail, never dropping diagnostics', async () => {
    const throwingGate: GateCommandPort = {
      pulse: () => { throw new Error('boom'); },
    };
    const uc = new TriggerGateUseCase(
      new FakeUserRepo([owner]), new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, throwingGate, clock, COOLDOWN,
    );
    const r = await uc.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL' });
    if (r.ok) throw new Error('expected a failure result');
    expect(r.internalDetail).toBeDefined();
    expect(r.internalDetail).toContain('boom');
  });

  it('carries a FAILED pulse\'s adapter detail out on internalDetail', async () => {
    const detail = 'HTTP 502 {"error":"DEVICE_OFFLINE","data":{"messages":["offline"]}}';
    gate.setResult({ outcome: 'device-offline', detail });

    const r = await useCase.execute('owner1', KEY);

    expect(r).toMatchObject({ ok: false, code: 'DEVICE_OFFLINE' });
    if (r.ok) throw new Error('expected a failure result');
    // Without this the audit row reads `failed / DEVICE_OFFLINE` and nothing
    // else -- not enough to tell a dropped pillar Wi-Fi from a rejected key.
    expect(r.internalDetail).toBe(detail);
  });

  it('lands that detail in the audit log, redacted, when wrapped', async () => {
    // The whole point of the field, proven across the join rather than in
    // either half: adapter -> use case -> decorator -> audit row.
    const log = new FakeAuditLog();
    gate.setResult({
      outcome: 'device-offline',
      detail: 'GET https://shelly.example/v2/x?auth_key=SUPERSECRET failed: offline',
    });
    const audited = new AuditedTriggerGate(useCase, log, clock, redact);

    await audited.execute('owner1', KEY);

    expect(log.entries[0]?.detail).toContain('offline');
    expect(log.entries[0]?.detail).not.toContain('SUPERSECRET');
  });

  it('returns INTERNAL without pulsing when the user repository throws', async () => {
    const throwingUsers: UserRepositoryPort = {
      findById: () => { throw new Error('sqlite down'); },
      findByEmail: async () => null,
      create: async () => {},
    };
    const uc = new TriggerGateUseCase(
      throwingUsers, new FakeGrantRepo([]),
      new RoleBasedAccessPolicy(), guard, gate, clock, COOLDOWN,
    );
    const r = await uc.execute('owner1', KEY);
    expect(r).toMatchObject({ ok: false, code: 'INTERNAL', replayed: false });
    expect(gate.calls).toBe(0);
  });
});
