import type { ErrorCode } from '@gate/shared';

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
