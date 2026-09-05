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
    /**
     * How long the gate stays in cooldown after this pulse. The app disables
     * its button for exactly this long and never assumes a number -- the
     * cooldown is server-side configuration the client cannot see.
     */
    retryAfterMs: z.number().int().nonnegative().optional(),
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

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

/** Owner-only. The window is ISO-8601; the backend parses it into Dates. */
export const IssueGrantRequestSchema = z.object({
  userId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
});

export const IssueGrantResponseSchema = z.object({
  grantId: z.string(),
});

/** The shape of every non-2xx body the API returns. */
export const ErrorResponseSchema = z.object({
  ok: z.literal(false),
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
});

export const GateStatusResponseSchema = z.object({
  position: z.enum(GATE_POSITIONS),
  /**
   * Whether the controller itself is up, which is a different fact from
   * whether the position is fresh: Shelly Cloud lags a device offline by up
   * to a minute, so these two disagree routinely and neither implies the
   * other.
   */
  reachable: z.boolean(),
  checkedAt: z.string().datetime(),
  /**
   * The last reading actually taken, still reported once it is too stale to
   * stand as `position`. It is what lets the app say "last seen closed 12
   * minutes ago" instead of either silence or a lie. Null before the first
   * reading of a process.
   *
   * An object rather than two nullable fields: a position with no time is not
   * a thing that should be representable.
   */
  lastReading: z.object({
    position: z.enum(GATE_POSITIONS),
    at: z.string().datetime(),
  }).nullable(),
});

export const AuditEventSchema = z.object({
  id: z.string(),
  userEmail: z.string().nullable(),
  action: z.string(),
  outcome: z.string(),
  errorCode: z.enum(ERROR_CODES).nullable(),
  createdAt: z.string().datetime(),
});

/** What `GET /audit` returns: newest last. */
export const AuditListResponseSchema = z.array(AuditEventSchema);

export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;
export type TriggerResponse = z.infer<typeof TriggerResponseSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;
export type IssueGrantRequest = z.infer<typeof IssueGrantRequestSchema>;
export type IssueGrantResponse = z.infer<typeof IssueGrantResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type GateStatusResponse = z.infer<typeof GateStatusResponseSchema>;
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

export * from './vocabulary.js';
