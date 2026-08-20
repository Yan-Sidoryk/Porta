import type { ErrorCode } from '@gate/shared';
import type { FastifyReply } from 'fastify';

/** The single ErrorCode -> HTTP status map. Nothing else assigns a status. */
export const STATUS: Record<ErrorCode, number> = {
  GATE_COOLING_DOWN: 409, ATTEMPT_IN_PROGRESS: 409, DEVICE_OFFLINE: 502,
  TIMEOUT_AMBIGUOUS: 504, ACCESS_DENIED: 403, SESSION_EXPIRED: 401,
  RATE_LIMITED: 429, DEVICE_FAILED_COMMAND: 502, BAD_REQUEST: 400,
  DEVICE_NOT_FOUND: 502, USER_UNKNOWN: 403, USER_DISABLED: 403, INTERNAL: 500,
};

/**
 * Codes the client is never told apart.
 *
 * "no such account", "account disabled" and "not allowed" are one answer on
 * the wire -- same status, same code, same message -- or the endpoint becomes
 * a directory of which accounts exist. The real code is still what gets
 * written to the audit log, where the operator can see it.
 */
const PUBLIC_CODE: Partial<Record<ErrorCode, ErrorCode>> = {
  USER_UNKNOWN: 'ACCESS_DENIED',
  USER_DISABLED: 'ACCESS_DENIED',
};

/** Plain language, no jargon: these strings are shown to a person at a gate. */
const MESSAGE: Record<ErrorCode, string> = {
  GATE_COOLING_DOWN: 'The gate was just triggered. Wait a moment before trying again.',
  ATTEMPT_IN_PROGRESS: 'That tap is still being sent. Wait for it to finish.',
  DEVICE_OFFLINE: 'The gate controller is offline.',
  TIMEOUT_AMBIGUOUS:
    'The gate controller did not answer in time. It may or may not have moved -- '
    + 'check the gate before trying again.',
  ACCESS_DENIED: 'You are not allowed to operate this gate.',
  SESSION_EXPIRED: 'Your session has expired. Sign in again.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  DEVICE_FAILED_COMMAND: 'The gate controller rejected the command.',
  BAD_REQUEST: 'The request was not valid.',
  DEVICE_NOT_FOUND: 'The gate controller is not registered with the account.',
  USER_UNKNOWN: 'You are not allowed to operate this gate.',
  USER_DISABLED: 'You are not allowed to operate this gate.',
  INTERNAL: 'Something went wrong. Try again.',
};

/**
 * The only way this API emits a failure body.
 *
 * `extra` is written out field by field by the caller -- a use-case result is
 * never spread into a response, because `TriggerResult` carries an
 * `internalDetail` (a raw adapter error, possibly holding the Shelly auth key)
 * that must not reach a client.
 */
export function fail(
  reply: FastifyReply,
  code: ErrorCode,
  extra: { replayed?: boolean; retryAfterMs?: number } = {},
): FastifyReply {
  const publicCode = PUBLIC_CODE[code] ?? code;
  const body: Record<string, unknown> = {
    ok: false,
    code: publicCode,
    message: MESSAGE[publicCode],
  };
  if (extra.replayed !== undefined) body.replayed = extra.replayed;
  if (extra.retryAfterMs !== undefined) body.retryAfterMs = extra.retryAfterMs;

  return reply.code(STATUS[publicCode]).send(body);
}
