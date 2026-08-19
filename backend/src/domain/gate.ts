import type { GatePosition, PulseOutcome } from '@gate/shared';

export interface GateState {
  position: GatePosition;
  reachable: boolean;
  checkedAt: Date;
}

export interface PulseResult {
  outcome: PulseOutcome;
  /** Raw device detail, for the audit log only. Never returned to the app. */
  detail?: string;
}

export type ClaimResult =
  | { kind: 'granted'; claimId: string }
  | { kind: 'cooling-down'; retryAfterMs: number }
  | { kind: 'replayed'; outcome: PulseOutcome | 'pending' };
