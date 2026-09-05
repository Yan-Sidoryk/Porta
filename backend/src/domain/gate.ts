import type { GatePosition, PulseOutcome } from '@gate/shared';

/** Where a reading came from. Kept for debugging, never for a decision. */
export type ReadingSource = 'webhook' | 'poll';

export interface GateReading {
  position: GatePosition;
  at: Date;
}

export interface GateState {
  position: GatePosition;
  reachable: boolean;
  checkedAt: Date;
  /**
   * The last reading taken, surviving the staleness cut that forces
   * `position` to 'unknown'. Null before anything has been read.
   */
  lastReading: GateReading | null;
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
