import type { Role } from '@gate/shared';
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { RateLimiterPort, TokenServicePort } from '../domain/ports.js';
import { fail } from './errors.js';

export interface AuthContext {
  userId: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authGuard`; null on every route that does not use it. */
    auth: AuthContext | null;
  }
}

const BEARER = 'Bearer ';

/**
 * Verifies the access token and nothing else. Authorisation -- who may open
 * the gate, who may issue a grant -- stays in the use cases, where it is
 * unit-tested without HTTP.
 */
export function authGuard(tokens: TokenServicePort): preHandlerAsyncHookHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = request.headers.authorization ?? '';
    const claims = header.startsWith(BEARER)
      ? tokens.verifyAccessToken(header.slice(BEARER.length))
      : null;

    // Missing, malformed, expired, wrong signature: all one answer.
    if (!claims) {
      await fail(reply, 'SESSION_EXPIRED');
      return;
    }
    request.auth = claims;
  };
}

/** The guard runs before every handler that calls this; null is a wiring bug. */
export function authOf(request: FastifyRequest): AuthContext {
  if (!request.auth) throw new Error('route is missing its authGuard preHandler');
  return request.auth;
}

export interface Bucket {
  key: string;
  limit: number;
  windowMs: number;
}

/**
 * Consumes from every bucket and reports whether all of them had room.
 *
 * Deliberately consumes from all of them even after one is exhausted: the
 * per-IP budget must still shrink while a single account is being hammered,
 * or an attacker gets a free per-IP allowance by reusing one email.
 */
export async function withinLimits(limiter: RateLimiterPort, buckets: Bucket[]): Promise<boolean> {
  const results = await Promise.all(
    buckets.map((b) => limiter.consume(b.key, b.limit, b.windowMs)),
  );
  return results.every(Boolean);
}
