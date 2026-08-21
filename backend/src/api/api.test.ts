import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import type { Container } from '../composition-root.js';
import { AuditedTriggerGate } from '../application/audited-trigger.js';
import { TriggerGateUseCase } from '../application/trigger-gate.js';
import { AuthenticateUserUseCase, RefreshSessionUseCase } from '../application/auth.js';
import { IssueAccessGrantUseCase, RevokeAccessGrantUseCase } from '../application/access-grants.js';
import { GetGateStatusUseCase, ListAuditEventsUseCase } from '../application/queries.js';
import { RoleBasedAccessPolicy } from '../domain/access-policy.js';
import { InMemoryRateLimiter } from '../infrastructure/rate-limiter.js';
import { redact } from '../infrastructure/redact.js';
import {
  FakeAuditLog, FakeClock, FakeGateCommand, FakeGateState, FakeGrantRepo,
  FakeGuard, FakeTokenService, FakeUserRepo,
} from '../../test/fakes.js';
import type { User } from '../domain/user.js';
import { AUTH_RATE_LIMIT } from './routes/auth.js';

const COOLDOWN = 5000;
const KEY = '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f';
const KEY2 = '11111111-2222-3333-4444-555555555555';

/** The fake's password hashes are `hash:<plain>`; nothing else verifies. */
const fakeVerify = async (hash: string, plain: string): Promise<boolean> => hash === `hash:${plain}`;

const owner: User = {
  id: 'owner1', email: 'owner@example.com', passwordHash: 'hash:hunter2',
  role: 'owner', disabled: false, createdAt: new Date('2026-01-01T00:00:00Z'),
};
const guest: User = {
  id: 'guest1', email: 'guest@example.com', passwordHash: 'hash:guestpw',
  role: 'user', disabled: false, createdAt: new Date('2026-01-01T00:00:00Z'),
};

let app: FastifyInstance;
let clock: FakeClock;
let gate: FakeGateCommand;
let gateState: FakeGateState;
let tokens: FakeTokenService;
let audit: FakeAuditLog;

let container: Container;

const setup = (): void => {
  clock = new FakeClock();
  gate = new FakeGateCommand();
  gateState = new FakeGateState();
  tokens = new FakeTokenService();
  audit = new FakeAuditLog();

  const users = new FakeUserRepo([owner, guest]);
  const grants = new FakeGrantRepo();
  container = {
    trigger: new AuditedTriggerGate(
      new TriggerGateUseCase(
        users, grants, new RoleBasedAccessPolicy(), new FakeGuard(clock), gate, clock, COOLDOWN,
      ),
      audit, clock, redact,
    ),
    gateStatus: new GetGateStatusUseCase(gateState, clock),
    auditEvents: new ListAuditEventsUseCase(audit),
    login: new AuthenticateUserUseCase(users, tokens, fakeVerify),
    refresh: new RefreshSessionUseCase(users, tokens),
    issueGrant: new IssueAccessGrantUseCase(users, grants),
    revokeGrant: new RevokeAccessGrantUseCase(users, grants, clock),
    tokens,
    limiter: new InMemoryRateLimiter(clock),
    close: () => {},
  };
  app = buildApp(container);
};

const auth = (user: User): { authorization: string } => ({
  authorization: `Bearer ${tokens.issueAccessToken(user.id, user.role)}`,
});

const trigger = (user: User, idempotencyKey: string) =>
  app.inject({
    method: 'POST', url: '/gate/trigger',
    headers: auth(user), payload: { idempotencyKey },
  });

beforeEach(setup);

describe('CORS', () => {
  const preflight = (instance: FastifyInstance) =>
    instance.inject({
      method: 'OPTIONS', url: '/auth/login',
      headers: { origin: 'http://192.168.1.50:8081', 'access-control-request-method': 'POST' },
    });

  it('sends no CORS headers by default', async () => {
    const res = await preflight(buildApp(container));
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // The switch exists so production says no. A shipped app is a native binary
  // that sends no Origin, so this only ever serves the Expo dev client.
  it('reflects the origin only when explicitly allowed', async () => {
    const res = await preflight(buildApp(container, { allowCors: true }));
    expect(res.headers['access-control-allow-origin']).toBe('http://192.168.1.50:8081');
  });
});

describe('POST /gate/trigger', () => {
  it('rejects a request with no token', async () => {
    const res = await app.inject({ method: 'POST', url: '/gate/trigger', payload: { idempotencyKey: KEY } });
    expect(res.statusCode).toBe(401);
    expect(gate.calls).toBe(0);
  });

  it('rejects a garbage token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/gate/trigger',
      headers: { authorization: 'Bearer not-a-token' }, payload: { idempotencyKey: KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(gate.calls).toBe(0);
  });

  it('pulses once for an authenticated owner', async () => {
    const res = await trigger(owner, KEY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true, outcome: 'success', replayed: false, retryAfterMs: COOLDOWN,
    });
    expect(gate.calls).toBe(1);
  });

  it('rejects a malformed idempotency key with 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/gate/trigger', headers: auth(owner), payload: { idempotencyKey: 'nope' },
    });
    expect(res.statusCode).toBe(400);
    expect(gate.calls).toBe(0);
  });

  it('answers a second immediate trigger with 409 and retryAfterMs', async () => {
    await trigger(owner, KEY);
    const res = await trigger(owner, KEY2);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ ok: false, code: 'GATE_COOLING_DOWN' });
    expect(res.json().retryAfterMs).toBeGreaterThan(0);
    expect(gate.calls).toBe(1);
  });

  it('never leaks internalDetail, or the auth key inside it, on a 500', async () => {
    const SECRET = 'MzY0NzUyNHVpZ' + 'SECRETAUTHKEY';
    gate.pulse = async (): Promise<never> => {
      throw new Error(`fetch failed https://shelly.example/v2/x?auth_key=${SECRET}`);
    };

    const res = await trigger(owner, KEY);
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain('auth_key');
    expect(res.json()).not.toHaveProperty('internalDetail');
  });

  // Not just the 500 path: every failed pulse now carries the adapter's own
  // detail out for the audit log, so every failure body is a leak candidate.
  it('never leaks the adapter detail on a device failure either', async () => {
    const SECRET = 'OFFLINE' + 'SECRETKEY456';
    gate.setResult({
      outcome: 'device-offline',
      detail: `HTTP 502 https://shelly.example/v2/x?auth_key=${SECRET}`,
    });

    const res = await trigger(owner, KEY);

    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain(SECRET);
    expect(res.json()).not.toHaveProperty('internalDetail');
  });

  it('gives an unknown user the same answer as a denied one', async () => {
    const ghost: User = { ...owner, id: 'ghost', role: 'owner' };
    const denied = await trigger(guest, KEY); // real user, no grant
    const unknown = await trigger(ghost, KEY2); // token for a deleted account

    expect(denied.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(denied.statusCode);
    expect(unknown.json()).toEqual(denied.json());
    expect(unknown.json()).toMatchObject({ code: 'ACCESS_DENIED' });
    expect(gate.calls).toBe(0);
  });

  it('audits the attempt even when the route rejects it', async () => {
    await trigger(guest, KEY);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ userId: 'guest1', errorCode: 'ACCESS_DENIED' });
  });
});

describe('GET /gate/status', () => {
  it('reports an unknown position with an ISO timestamp', async () => {
    gateState.setResult({ position: 'unknown', reachable: true, checkedAt: new Date('2026-08-19T12:00:00Z') });
    const res = await app.inject({ method: 'GET', url: '/gate/status', headers: auth(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      position: 'unknown', reachable: true, checkedAt: '2026-08-19T12:00:00.000Z',
    });
  });

  it('reports unreachable rather than failing when the adapter throws', async () => {
    gateState.setResult(new Error('shelly is down'));
    const res = await app.inject({ method: 'GET', url: '/gate/status', headers: auth(owner) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ position: 'unknown', reachable: false });
  });

  it('requires a token', async () => {
    expect((await app.inject({ method: 'GET', url: '/gate/status' })).statusCode).toBe(401);
  });
});

describe('POST /auth/login', () => {
  it('issues a token pair for the right password', async () => {
    const res = await app.inject({
      method: 'POST', url: '/auth/login',
      payload: { email: owner.email, password: 'hunter2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
    expect(res.json().refreshToken).toBeTruthy();
  });

  it('answers an unknown email exactly as it answers a wrong password', async () => {
    const wrong = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'wrong' },
    });
    const unknown = await app.inject({
      method: 'POST', url: '/auth/login', payload: { email: 'nobody@example.com', password: 'wrong' },
    });
    expect(wrong.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.body).toBe(wrong.body);
  });

  it('rate limits repeated attempts', async () => {
    const attempt = () => app.inject({
      method: 'POST', url: '/auth/login', payload: { email: owner.email, password: 'wrong' },
    });
    for (let i = 0; i < AUTH_RATE_LIMIT; i += 1) await attempt();
    expect((await attempt()).statusCode).toBe(429);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates a refresh token', async () => {
    const refreshToken = await tokens.issueRefreshToken(owner.id);
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(res.statusCode).toBe(200);
    expect(res.json().refreshToken).not.toBe(refreshToken);

    const replay = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(replay.statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the caller\'s refresh tokens', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(owner) });
    expect(res.statusCode).toBe(204);
    expect(tokens.revokedFor).toContain(owner.id);
  });

  it('requires a token', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/logout' })).statusCode).toBe(401);
  });
});

describe('GET /audit', () => {
  it('serialises createdAt as ISO and omits operator-only fields', async () => {
    await trigger(owner, KEY);
    const res = await app.inject({ method: 'GET', url: '/audit', headers: auth(owner) });
    expect(res.statusCode).toBe(200);

    const [event] = res.json();
    expect(event.createdAt).toBe('2026-08-19T12:00:00.000Z');
    expect(event).not.toHaveProperty('idempotencyKey');
    expect(event).not.toHaveProperty('detail');
  });
});

describe('/access-grants', () => {
  const window = {
    startsAt: '2026-08-20T00:00:00.000Z',
    endsAt: '2026-08-21T00:00:00.000Z',
  };

  it('lets an owner issue a grant', async () => {
    const res = await app.inject({
      method: 'POST', url: '/access-grants', headers: auth(owner),
      payload: { userId: guest.id, ...window },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().grantId).toBeTruthy();
  });

  it('lets the granted user through the gate', async () => {
    await app.inject({
      method: 'POST', url: '/access-grants', headers: auth(owner),
      payload: { userId: guest.id, startsAt: '2026-08-19T00:00:00.000Z', endsAt: '2026-08-20T00:00:00.000Z' },
    });
    const res = await trigger(guest, KEY);
    expect(res.statusCode).toBe(200);
    expect(gate.calls).toBe(1);
  });

  it('refuses a non-owner', async () => {
    const res = await app.inject({
      method: 'POST', url: '/access-grants', headers: auth(guest),
      payload: { userId: guest.id, ...window },
    });
    expect(res.statusCode).toBe(403);
  });

  it('revokes idempotently for an owner and refuses a non-owner', async () => {
    const issued = await app.inject({
      method: 'POST', url: '/access-grants', headers: auth(owner),
      payload: { userId: guest.id, ...window },
    });
    const { grantId } = issued.json();

    expect((await app.inject({
      method: 'DELETE', url: `/access-grants/${grantId}`, headers: auth(guest),
    })).statusCode).toBe(403);

    expect((await app.inject({
      method: 'DELETE', url: `/access-grants/${grantId}`, headers: auth(owner),
    })).statusCode).toBe(204);

    // Idempotent: the same call again, and one for an id that never existed.
    expect((await app.inject({
      method: 'DELETE', url: `/access-grants/${grantId}`, headers: auth(owner),
    })).statusCode).toBe(204);
  });
});
