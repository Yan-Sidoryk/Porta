import { z } from 'zod';
import { ERROR_CODES, GATE_POSITIONS, PULSE_OUTCOMES } from './vocabulary.js';

export const TriggerRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
});

export const TriggerResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    outcome: z.enum(PULSE_OUTCOMES),
    replayed: z.boolean(),
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(ERROR_CODES),
    message: z.string(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    replayed: z.boolean(),
  }),
]);

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
});

export const GateStatusResponseSchema = z.object({
  position: z.enum(GATE_POSITIONS),
  reachable: z.boolean(),
  checkedAt: z.string().datetime(),
});

export const AuditEventSchema = z.object({
  id: z.string(),
  userEmail: z.string().nullable(),
  action: z.string(),
  outcome: z.string(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  createdAt: z.string().datetime(),
});

export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;
export type TriggerResponse = z.infer<typeof TriggerResponseSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type GateStatusResponse = z.infer<typeof GateStatusResponseSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export * from './vocabulary.js';
