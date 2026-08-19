import { describe, expect, it } from 'vitest';
import { TriggerRequestSchema, TriggerResponseSchema } from './api.js';

describe('TriggerRequestSchema', () => {
  it('requires a uuid idempotency key', () => {
    expect(TriggerRequestSchema.safeParse({ idempotencyKey: 'nope' }).success).toBe(false);
    expect(
      TriggerRequestSchema.safeParse({
        idempotencyKey: '3f6d1c8e-9b2a-4c5d-8e1f-0a2b3c4d5e6f',
      }).success,
    ).toBe(true);
  });
});

describe('TriggerResponseSchema', () => {
  it('carries retryAfterMs on a cooldown rejection', () => {
    const parsed = TriggerResponseSchema.parse({
      ok: false,
      code: 'GATE_COOLING_DOWN',
      message: 'Cooling down',
      retryAfterMs: 4200,
    });
    expect(parsed).toMatchObject({ ok: false, retryAfterMs: 4200 });
  });

  it('rejects an unknown error code', () => {
    const bad = TriggerResponseSchema.safeParse({
      ok: false, code: 'MADE_UP', message: 'x',
    });
    expect(bad.success).toBe(false);
  });
});
