import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('redacts a trailing auth_key', () => {
    const out = redact('https://x.shelly.cloud/set?auth_key=SECRET1');
    expect(out).not.toContain('SECRET1');
    expect(out).toContain('auth_key=***');
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

  it('redacts a JSON auth_key with no space around the colon', () => {
    const out = redact('{"auth_key":"SECRET123"}');
    expect(out).not.toContain('SECRET123');
    expect(out).toContain('***');
  });

  it('redacts a JSON password while leaving an unrelated field intact', () => {
    const out = redact('{"password": "hunter2", "email": "a@b.c"}');
    expect(out).not.toContain('hunter2');
    expect(out).toContain('***');
    expect(out).toContain('a@b.c');
  });

  it('redacts an Authorization: Bearer token', () => {
    const out = redact('Authorization: Bearer eyJhbGciOi.SECRET123');
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('eyJhbGciOi');
    expect(out).toContain('***');
  });

  it('redacts a key with a word-character prefix, e.g. x_auth_key', () => {
    const out = redact('https://h/api?x_auth_key=SECRET123');
    expect(out).not.toContain('SECRET123');
    expect(out).toContain('***');
  });

  it('redacts a single-quoted key=value pair', () => {
    const out = redact("'token'='SECRET'");
    expect(out).not.toContain('SECRET');
    expect(out).toContain('***');
  });

  it('redacts multiple different secret shapes in one string', () => {
    const out = redact('multi token=ABC123 and then Authorization: Bearer XYZ789 end');
    expect(out).not.toContain('ABC123');
    expect(out).not.toContain('XYZ789');
    expect(out).toContain('***');
  });

  it('redacts before truncating, so a secret past the 2000-char cutoff is still caught', () => {
    // A quoted value is the case that exposes ordering: if truncation ran
    // first, it could cut this secret off before its closing quote, and by
    // design (see redact.ts) a quoted value that never reaches its closing
    // quote does not match at all -- the survivING fragment would leak.
    const padding = 'x'.repeat(1950);
    const secret = 'S'.repeat(200);
    const input = `${padding} {"auth_key":"${secret}"} tail`;
    const out = redact(input);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });
});
