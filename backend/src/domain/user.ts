import type { Role } from '@gate/shared';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
}

export interface AccessGrant {
  id: string;
  userId: string;
  startsAt: Date;
  endsAt: Date;
  createdBy: string;
  revokedAt: Date | null;
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string };
