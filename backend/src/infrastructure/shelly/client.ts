import { redact } from '../redact.js';

export interface ShellyConfig {
  host: string;
  authKey: string;
  deviceId: string;
  timeoutMs: number;
  /** Test-only: build http:// instead of https://, so the stub server can be
   *  reached on 127.0.0.1. Never set in production config. */
  insecure?: boolean;
}

export type ShellyReply =
  | { kind: 'response'; status: number; body: unknown }
  | { kind: 'timeout' }
  | { kind: 'network'; detail: string };

const MIN_REQUEST_GAP_MS = 1000;

// Shelly rate-limits to 1 req/sec per account, and this process holds exactly
// one account -- so one process-wide timestamp IS the rate limiter, shared by
// every adapter without having to thread a client object through them.
// ponytail: process-global. Key it by account if this ever serves two gates,
// and move it behind a port if the backend ever runs on more than one node.
let nextAllowedAt = 0;

async function waitForSlot(): Promise<void> {
  // Wall clock, not ClockPort: this pairs with setTimeout, and a fake clock
  // would sit here forever.
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  nextAllowedAt = Date.now() + MIN_REQUEST_GAP_MS;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null; // a proxy in front of Shelly may answer HTML
  }
};

/**
 * The single door to Shelly Cloud. Owns the rate limit, the timeout, and the
 * guarantee that nothing carrying the auth key escapes: the key rides in the
 * query string, so any error text derived from a failed request is redacted
 * before it is handed back.
 *
 * Never retries. A timeout does not mean the command failed -- see
 * gate-command-adapter.ts.
 */
export async function shellyPost(
  config: ShellyConfig,
  path: string,
  body: unknown,
): Promise<ShellyReply> {
  await waitForSlot();
  const scheme = config.insecure ? 'http' : 'https';
  const url = `${scheme}://${config.host}${path}?auth_key=${encodeURIComponent(config.authKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    return { kind: 'response', status: res.status, body: parseJson(await res.text()) };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { kind: 'timeout' };
    return { kind: 'network', detail: redact(String(error)) };
  }
}
