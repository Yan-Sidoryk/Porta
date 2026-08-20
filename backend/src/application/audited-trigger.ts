import type { ErrorCode } from '@gate/shared';
import type { AuditLogPort, ClockPort } from '../domain/ports.js';
import type { TriggerGate, TriggerResult } from './trigger-gate.js';

/** A function, not a class -- `application/` may not import `infrastructure/redact.ts`
 *  directly, so the composition root injects the real redactor through this shape
 *  instead (same pattern as ClockPort, minus the ceremony of a one-implementation port). */
export type Redactor = (input: string) => string;

/**
 * Auditing wraps the use case rather than sitting at the end of it.
 *
 * TriggerGateUseCase returns EARLY for an unknown user and for a denied
 * policy check -- the attempts the spec calls most important. An audit write
 * placed as the last statement of that method would never run for them.
 * Wrapping guarantees every path in and out is recorded by construction,
 * not by remembering to call the logger on each branch.
 */
export class AuditedTriggerGate implements TriggerGate {
  constructor(
    private inner: TriggerGate,
    private audit: AuditLogPort,
    private clock: ClockPort,
    private redact: Redactor,
  ) {}

  async execute(userId: string, idempotencyKey: string): Promise<TriggerResult> {
    // Defaults to the throw case. Overwritten only on a normal return, so an
    // exception escaping `inner` is still recorded as an error rather than
    // silently skipping the audit write.
    let recorded: { outcome: string; errorCode: ErrorCode | null; detail: string | null } = {
      outcome: 'error',
      errorCode: 'INTERNAL',
      detail: null,
    };

    try {
      const result = await this.inner.execute(userId, idempotencyKey);
      recorded = result.ok
        ? { outcome: result.replayed ? 'replayed' : result.outcome, errorCode: null, detail: null }
        : {
            outcome: result.code === 'ACCESS_DENIED' || result.code === 'USER_UNKNOWN'
              ? 'denied'
              : 'failed',
            errorCode: result.code,
            // internalDetail can hold a raw adapter error (message + stack) --
            // e.g. a Shelly fetch failure embeds ?auth_key=<secret> in the URL.
            // Never persist it unredacted; an audit table row is a log.
            detail: result.internalDetail ? this.redact(result.internalDetail) : null,
          };
      return result;
    } finally {
      await this.audit.append({
        userId,
        action: 'gate.trigger',
        outcome: recorded.outcome,
        errorCode: recorded.errorCode,
        idempotencyKey,
        createdAt: this.clock.now(),
        detail: recorded.detail,
      });
    }
  }
}
