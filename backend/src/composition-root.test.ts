import { afterEach, describe, expect, it } from 'vitest';
import { buildContainer, type Container } from './composition-root.js';
import { loadConfig } from './config.js';
import type { Redactor } from './application/audited-trigger.js';

const config = loadConfig({
  SHELLY_HOST: 'shelly.invalid',
  SHELLY_AUTH_KEY: 'not-a-real-key',
  SHELLY_DEVICE_ID: 'device',
  JWT_SECRET: 'x'.repeat(32),
  GATE_COOLDOWN_MS: '5000',
  DATABASE_PATH: ':memory:',
  NODE_ENV: 'test',
  PUBLIC_URL: 'http://localhost:3000',
});

let container: Container | null = null;
const build = (): Container => {
  container = buildContainer(config);
  return container;
};

afterEach(() => {
  container?.close();
  container = null;
});

describe('buildContainer', () => {
  /**
   * The wiring this test exists for: `AuditedTriggerGate` takes its redactor
   * as a constructor argument, so passing `(s) => s` compiles, type-checks,
   * and writes the Shelly auth key into the audit table in plain text. The
   * assertion is behavioural on purpose -- an identity function fails it.
   */
  it('wires the real redactor into the audit decorator', () => {
    const { trigger } = build();
    const { redact } = trigger as unknown as { redact: Redactor };

    expect(redact('fetch failed https://shelly/v2?auth_key=SUPERSECRET')).not.toContain('SUPERSECRET');
    expect(redact('SHELLY_AUTH_KEY=SUPERSECRET')).not.toContain('SUPERSECRET');
  });

  it('opens a working database and closes it again', async () => {
    const c = build();
    // Nothing is registered, so this exercises the schema without a fixture.
    expect(await c.auditEvents.execute(10)).toEqual([]);
    expect(() => c.close()).not.toThrow();
    container = null; // already closed; afterEach must not double-close
  });

  it('issues a verifiable access token from the configured secret', () => {
    const { tokens } = build();
    const token = tokens.issueAccessToken('u1', 'owner');
    expect(tokens.verifyAccessToken(token)).toEqual({ userId: 'u1', role: 'owner' });
  });
});
