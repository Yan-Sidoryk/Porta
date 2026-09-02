import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The refresh race, and only the refresh race.
 *
 * api.ts imports no react-native, so it runs here as long as the two expo
 * modules it does touch are stubbed. The keystore is a Map; the backend is a
 * fetch stub that rotates refresh tokens single-use exactly the way
 * JwtTokenService.consumeRefreshToken does -- which is the whole point, since
 * the bug only exists because that rotation is unforgiving.
 */

const store = new Map<string, string>();

vi.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => store.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { store.set(k, v); },
  deleteItemAsync: async (k: string) => { store.delete(k); },
}));

vi.mock('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://gate.test' } } },
}));

const { getAudit, getStatus } = await import('./api');

const ACCESS_KEY = 'gate.accessToken';
const REFRESH_KEY = 'gate.refreshToken';

const STALE_ACCESS = 'access-expired';
const FRESH_ACCESS = 'access-fresh';
const LIVE_REFRESH = 'refresh-live';

const json = (status: number, body: unknown): Response =>
  ({ status, json: async () => body }) as Response;

const expired = () =>
  json(401, { ok: false, code: 'SESSION_EXPIRED', message: 'Your session has expired.' });

/** Counts what actually reached the wire, per path. */
let calls: string[];
/** Revoked-on-read, like the UPDATE ... RETURNING in jwt.ts. */
let spent: boolean;

function backend(url: string, init: RequestInit): Response {
  const path = url.replace('https://gate.test', '');
  calls.push(path);

  if (path === '/auth/refresh') {
    const { refreshToken } = JSON.parse(String(init.body)) as { refreshToken: string };
    if (spent || refreshToken !== LIVE_REFRESH) return expired();
    spent = true;
    return json(200, { accessToken: FRESH_ACCESS, refreshToken: 'refresh-rotated' });
  }

  if (init.headers?.['authorization' as keyof HeadersInit] !== `Bearer ${FRESH_ACCESS}`) {
    return expired();
  }

  if (path === '/gate/status') {
    return json(200, { position: 'closed', reachable: true, checkedAt: '2026-09-02T12:00:00.000Z' });
  }
  return json(200, []); // /audit
}

beforeEach(() => {
  store.clear();
  store.set(ACCESS_KEY, STALE_ACCESS);
  store.set(REFRESH_KEY, LIVE_REFRESH);
  calls = [];
  spent = false;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => backend(url, init));
});

describe('concurrent 401s', () => {
  // The cold-start shape: GateScreen fires both of these together, and before
  // the fix the loser's clearTokens() wiped the pair the winner had just saved.
  it('refresh once and both requests survive', async () => {
    const [status, audit] = await Promise.all([getStatus(), getAudit()]);

    expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
    expect(status).toEqual({ position: 'closed', reachable: true, checkedAt: '2026-09-02T12:00:00.000Z' });
    expect(audit).toEqual([]);

    // The rotated pair is still there. An emptied keystore is the login screen
    // on the next launch, which is the bug as the user experienced it.
    expect(store.get(ACCESS_KEY)).toBe(FRESH_ACCESS);
    expect(store.get(REFRESH_KEY)).toBe('refresh-rotated');
  });

  it('sign out once when the refresh token is genuinely dead', async () => {
    store.set(REFRESH_KEY, 'refresh-revoked');

    const [status, audit] = await Promise.all([getStatus(), getAudit()]);

    expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
    expect(status).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(audit).toMatchObject({ ok: false, code: 'SESSION_EXPIRED' });
    expect(store.size).toBe(0);
  });

  // The shared promise must not outlive its refresh, or the session could
  // never be renewed twice.
  it('refresh again on a later 401', async () => {
    await getStatus();

    spent = false;
    store.set(ACCESS_KEY, STALE_ACCESS);
    store.set(REFRESH_KEY, LIVE_REFRESH);
    calls = [];

    expect(await getStatus()).toMatchObject({ position: 'closed' });
    expect(calls.filter((p) => p === '/auth/refresh')).toHaveLength(1);
  });
});
