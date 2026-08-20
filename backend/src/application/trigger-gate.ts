import type { ErrorCode, PulseOutcome } from '@gate/shared';
import type {
  AccessGrantRepositoryPort, AccessPolicyPort, ClockPort,
  CommandGuardPort, GateCommandPort, UserRepositoryPort,
} from '../domain/ports.js';
import { IDEMPOTENCY_WINDOW_MS } from '../domain/constants.js';

export type TriggerResult =
  | { ok: true; outcome: PulseOutcome; replayed: boolean }
  | {
      ok: false;
      code: ErrorCode;
      retryAfterMs?: number;
      replayed: boolean;
      /**
       * Diagnostic detail for an INTERNAL failure (adapter error message + stack).
       * Never sent to the client: absent from TriggerResponseSchema in shared/ on
       * purpose, so leaking it onto the wire is a type error, not a runtime bug.
       * Exists for the auditing decorator (Task 5) to write into the audit log;
       * the API layer (Task 11) strips this field before serialising a response.
       */
      internalDetail?: string;
    };

export interface TriggerGate {
  execute(userId: string, idempotencyKey: string): Promise<TriggerResult>;
}

const OUTCOME_TO_CODE: Record<Exclude<PulseOutcome, 'success'>, ErrorCode> = {
  timeout: 'TIMEOUT_AMBIGUOUS',
  'device-offline': 'DEVICE_OFFLINE',
  'device-failed': 'DEVICE_FAILED_COMMAND',
  'bad-request': 'BAD_REQUEST',
  'device-not-found': 'DEVICE_NOT_FOUND',
  error: 'INTERNAL',
};

const toResult = (outcome: PulseOutcome, replayed: boolean): TriggerResult =>
  outcome === 'success'
    ? { ok: true, outcome, replayed }
    : { ok: false, code: OUTCOME_TO_CODE[outcome], replayed };

export class TriggerGateUseCase implements TriggerGate {
  constructor(
    private users: UserRepositoryPort,
    private grants: AccessGrantRepositoryPort,
    private policy: AccessPolicyPort,
    private guard: CommandGuardPort,
    private gate: GateCommandPort,
    private clock: ClockPort,
    private cooldownMs: number,
  ) {}

  async execute(userId: string, idempotencyKey: string): Promise<TriggerResult> {
    try {
      const user = await this.users.findById(userId);
      if (!user) return { ok: false, code: 'USER_UNKNOWN', replayed: false };
      if (user.disabled) return { ok: false, code: 'USER_DISABLED', replayed: false };

      const at = this.clock.now();
      const decision = this.policy.canOperate(user, await this.grants.listForUser(userId), at);
      if (!decision.allowed) return { ok: false, code: 'ACCESS_DENIED', replayed: false };

      // Claim BEFORE calling. If the pulse timestamp were recorded only after
      // Shelly responds, the cooldown would be blind for the whole duration of
      // that in-flight request -- exactly the window it exists to protect.
      const claim = await this.guard.tryClaim({
        idempotencyKey,
        cooldownMs: this.cooldownMs,
        idempotencyWindowMs: IDEMPOTENCY_WINDOW_MS,
      });

      if (claim.kind === 'cooling-down') {
        return { ok: false, code: 'GATE_COOLING_DOWN', retryAfterMs: claim.retryAfterMs, replayed: false };
      }
      if (claim.kind === 'replayed') {
        // Reached only when the guard recognised the key -- no pulse was sent
        // either way, so `replayed` is true even while the original attempt
        // is still in flight ('pending').
        return claim.outcome === 'pending'
          ? { ok: false, code: 'ATTEMPT_IN_PROGRESS', replayed: true }
          : toResult(claim.outcome, true);
      }

      // Never retried: exactly one pulse per granted claim. If this rejects,
      // control jumps straight to the catch below WITHOUT reaching release()
      // -- we do not know whether the relay fired, so the claim stays held at
      // its full pessimistic 2x window rather than being narrowed or freed.
      const result = await this.gate.pulse();
      await this.guard.release(claim.claimId, result.outcome);
      return toResult(result.outcome, false);
    } catch (err) {
      // Adapter failure (SQLite, HTTP, etc). Never let a raw exception cross
      // the layer boundary; never release a claim here -- see the note above.
      // The bound error is carried out as internalDetail for diagnostics only
      // (see the field's doc comment) -- never returned to the client.
      const internalDetail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      return { ok: false, code: 'INTERNAL', replayed: false, internalDetail };
    }
  }
}
