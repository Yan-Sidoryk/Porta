import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const base = {
  SHELLY_HOST: 'h', SHELLY_AUTH_KEY: 'k', SHELLY_DEVICE_ID: 'd',
  JWT_SECRET: 'x'.repeat(32), GATE_COOLDOWN_MS: '5000',
  DATABASE_PATH: ':memory:', NODE_ENV: 'development',
  PUBLIC_URL: 'http://localhost:3000',
};

describe('loadConfig', () => {
  it('refuses to start when a secret is missing', () => {
    const { SHELLY_AUTH_KEY: _omitted, ...withoutKey } = base;
    expect(() => loadConfig(withoutKey)).toThrow(/SHELLY_AUTH_KEY/);
  });

  it('refuses to start in production without https', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).toThrow(/https/i);
  });

  it('accepts production behind an https public url', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://gate.example.com' }),
    ).not.toThrow();
  });

  it('rejects a short jwt secret', () => {
    expect(() => loadConfig({ ...base, JWT_SECRET: 'tooshort' })).toThrow(/JWT_SECRET/);
  });

  it('reads the cooldown from the environment', () => {
    expect(loadConfig({ ...base, GATE_COOLDOWN_MS: '7000' }).gateCooldownMs).toBe(7000);
  });

  it('never includes the auth key in a thrown message', () => {
    let message = '';
    try {
      loadConfig({ ...base, NODE_ENV: 'production' });
    } catch (e) {
      message = String(e);
    }

    // Asserted first, and on the message rather than in the catch: an empty
    // string here means nothing was thrown, and a `not.toContain` on nothing
    // passes happily.
    expect(message).toMatch(/https/i);
    // The whole point: a boot failure is loud about WHICH variable is wrong
    // and silent about its value. 'k' is the auth key in `base`.
    expect(message).not.toContain('k');
  });

  it('leaves shelly.insecure unset so production can only ever use https', () => {
    expect(loadConfig(base).shelly).not.toHaveProperty('insecure');
  });

  it('rejects a cooldown that is not a number', () => {
    expect(() => loadConfig({ ...base, GATE_COOLDOWN_MS: 'soon' })).toThrow(/GATE_COOLDOWN_MS/);
  });
});
