import Constants from 'expo-constants';
import {
  AuditListResponseSchema,
  type AuditEvent,
  ErrorResponseSchema,
  GateStatusResponseSchema,
  LoginResponseSchema,
  TriggerResponseSchema,
  type ErrorCode,
  type GateStatusResponse,
  type TriggerResponse,
} from '@gate/shared';
import { clearTokens, getAccessToken, getRefreshToken, saveTokens } from './session';
import { NETWORK_UNREACHABLE, type ApiFailure } from './gate-machine';

// Defined in gate-machine.ts and re-exported here for callers: that module has
// to stay free of react-native imports so it can be unit tested.
export { NETWORK_UNREACHABLE, type ApiFailure };

const BACKEND_PORT = 3000;

const unreachable = (): ApiFailure => ({
  ok: false,
  code: NETWORK_UNREACHABLE,
  message: 'Could not reach the gate service. Check your connection.',
});

const unexpected = (): ApiFailure => ({
  ok: false,
  code: 'INTERNAL',
  message: 'The gate service sent something unexpected.',
});

/**
 * A phone cannot resolve the dev machine's `localhost`.
 *
 * Metro already knows the machine's LAN address -- it is serving the bundle
 * from it -- so the backend is derived from `hostUri` instead of asking
 * someone to paste an IP into app.json and re-paste it every time the router
 * hands out a new lease. `extra.apiUrl` in app.json overrides it, and is what
 * a real build sets, where `hostUri` is null.
 */
export function baseUrl(): string {
  const configured: unknown = Constants.expoConfig?.extra?.apiUrl;
  if (typeof configured === 'string' && configured.length > 0) return configured;

  const devHost = Constants.expoConfig?.hostUri?.split(':')[0];
  if (devHost) return `http://${devHost}:${BACKEND_PORT}`;

  throw new Error('No extra.apiUrl in app.json, and no Metro host to infer one from.');
}

interface Reply {
  status: number;
  body: unknown;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

async function send(path: string, init: RequestInit): Promise<Reply | null> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, init);
    // 204 has no body, and a proxy in front of the backend may answer HTML.
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  } catch {
    return null; // the request never arrived; nothing was triggered
  }
}

/** Every non-2xx body the backend emits has this shape. */
function toFailure(body: unknown): ApiFailure {
  const parsed = ErrorResponseSchema.safeParse(body);
  if (!parsed.success) return unexpected();
  return {
    ok: false,
    code: parsed.data.code,
    message: parsed.data.message,
    ...(parsed.data.retryAfterMs === undefined ? {} : { retryAfterMs: parsed.data.retryAfterMs }),
  };
}

const withAuth = (init: RequestInit, token: string | null): RequestInit => ({
  ...init,
  headers: { ...JSON_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) },
});

/**
 * One refresh at a time, shared by everything waiting on it.
 *
 * The backend rotates single-use, so two 401s racing here spend the same
 * token: one wins, and the loser's failure clears the keystore the winner
 * just filled. GateScreen asks for status and activity together on mount, so
 * that race was every cold start past the access token's 15 minutes.
 */
let inFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  inFlight ??= doRefresh().finally(() => { inFlight = null; });
  return inFlight;
}

async function doRefresh(): Promise<boolean> {
  const refreshToken = await getRefreshToken();
  if (!refreshToken) return false;

  const reply = await send('/auth/refresh', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ refreshToken }),
  });
  if (!reply || reply.status !== 200) return false;

  const parsed = LoginResponseSchema.safeParse(reply.body);
  if (!parsed.success) return false;

  // The backend rotates: the token just spent is already revoked, so the
  // replacement has to be stored or the session ends on the next 401.
  await saveTokens(parsed.data);
  return true;
}

/**
 * One refresh, then one retry. If that still comes back 401 the session is
 * genuinely over -- the tokens are cleared so the UI can ask for a login
 * rather than looping.
 */
async function authed(path: string, init: RequestInit): Promise<Reply | null> {
  const first = await send(path, withAuth(init, await getAccessToken()));
  if (!first || first.status !== 401) return first;

  if (!(await refreshSession())) {
    await clearTokens();
    return first;
  }
  return send(path, withAuth(init, await getAccessToken()));
}

export async function login(email: string, password: string): Promise<{ ok: true } | ApiFailure> {
  const reply = await send('/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password }),
  });
  if (!reply) return unreachable();
  if (reply.status !== 200) return toFailure(reply.body);

  const parsed = LoginResponseSchema.safeParse(reply.body);
  if (!parsed.success) return unexpected();

  await saveTokens(parsed.data);
  return { ok: true };
}

export async function logout(): Promise<void> {
  await authed('/auth/logout', { method: 'POST' });
  await clearTokens();
}

/**
 * `idempotencyKey` is the caller's, not this function's: one UUID per
 * user-initiated tap, reused across every retry of that tap. Generating one
 * here would turn a retry into a second pulse, and a second pulse arriving
 * while the gate is moving stops it mid-travel.
 */
export async function trigger(idempotencyKey: string): Promise<TriggerResponse | ApiFailure> {
  const reply = await authed('/gate/trigger', {
    method: 'POST',
    body: JSON.stringify({ idempotencyKey }),
  });
  if (!reply) return unreachable();

  // Parsed with the union: the backend's failure bodies for this endpoint
  // carry `replayed` and `retryAfterMs`, which the plain error shape lacks.
  const parsed = TriggerResponseSchema.safeParse(reply.body);
  return parsed.success ? parsed.data : toFailure(reply.body);
}

export async function getAudit(limit = 20): Promise<AuditEvent[] | ApiFailure> {
  const reply = await authed(`/audit?limit=${limit}`, { method: 'GET' });
  if (!reply) return unreachable();
  if (reply.status !== 200) return toFailure(reply.body);

  const parsed = AuditListResponseSchema.safeParse(reply.body);
  return parsed.success ? parsed.data : unexpected();
}

export async function getStatus(): Promise<GateStatusResponse | ApiFailure> {
  const reply = await authed('/gate/status', { method: 'GET' });
  if (!reply) return unreachable();
  if (reply.status !== 200) return toFailure(reply.body);

  const parsed = GateStatusResponseSchema.safeParse(reply.body);
  return parsed.success ? parsed.data : unexpected();
}
