import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('redacts a trailing auth_key', () => {
    expect(redact('https://x.shelly.cloud/set?auth_key=SECRET1')).not.toContain('SECRET1');
    expect(redact('https://x.shelly.cloud/set?auth_key=SECRET1')).toContain('auth_key=***');
  });

  it('redacts an auth_key that appears mid-URL, before another query param', () => {
    const out = redact('https://x.shelly.cloud/set?auth_key=SECRET2&channel=0');
    expect(out).not.toContain('SECRET2');
    expect(out).toContain('auth_key=***');
    expect(out).toContain('channel=0');
  });

  it('redacts token, password, and authorization values, case-insensitively', () => {
    const out = redact('token=T1 Password=P1 AUTHORIZATION=A1');
    expect(out).not.toMatch(/T1|P1|A1/);
    expect(out).toContain('token=***');
  });

  it('leaves unrelated text untouched', () => {
    expect(redact('device offline, retry later')).toBe('device offline, retry later');
  });

  it('truncates to 2000 chars', () => {
    expect(redact('x'.repeat(5000)).length).toBe(2000);
  });
});
