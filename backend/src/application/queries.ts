import type { ErrorCode } from '@gate/shared';
import type { GateState } from '../domain/gate.js';
import type {
  AuditLogPort, ClockPort, GateStatePort,
} from '../domain/ports.js';

export class GetGateStatusUseCase {
  constructor(
    private gate: GateStatePort,
    private clock: ClockPort,
  ) {}

  async execute(): Promise<GateState> {
    try {
      return await this.gate.getState();
    } catch {
      // "Unreachable" is the honest answer to a failed reachability check, and
      // it is one the app can actually display. A 500 is not.
      return { position: 'unknown', reachable: false, checkedAt: this.clock.now() };
    }
  }
}

/** Also the default: a caller that names no limit gets one page. */
export const MAX_AUDIT_PAGE = 200;

/** The audit row minus everything an operator keeps but a client never sees. */
export interface AuditEventView {
  id: string;
  userEmail: string | null;
  action: string;
  outcome: string;
  errorCode: ErrorCode | null;
  createdAt: Date;
}

export class ListAuditEventsUseCase {
  constructor(private audit: AuditLogPort) {}

  async execute(limit: number = MAX_AUDIT_PAGE): Promise<AuditEventView[]> {
    const wanted = Number.isFinite(limit) ? Math.trunc(limit) : MAX_AUDIT_PAGE;
    const rows = await this.audit.listRecent(Math.min(Math.max(wanted, 1), MAX_AUDIT_PAGE));

    // Rebuilt field by field on purpose. `detail` is a redacted stack trace
    // and `idempotencyKey` is another client's tap id -- a spread would ship
    // both the moment AuditEntry grows a field.
    return rows.map((row) => ({
      id: row.id,
      userEmail: row.userEmail,
      action: row.action,
      outcome: row.outcome,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
    }));
  }
}
