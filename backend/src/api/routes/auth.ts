import { LoginRequestSchema, RefreshRequestSchema } from '@gate/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { fail } from '../errors.js';
import { authGuard, authOf, withinLimits } from '../guards.js';

/** Attempts per window, per IP and per email address independently. */
export const AUTH_RATE_LIMIT = 10;
const AUTH_WINDOW_MS = 60_000;

export function registerAuthRoutes(app: FastifyInstance, container: Container): void {
  app.post('/auth/login', async (request, reply) => {
    const parsed = LoginRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST');
    const { email, password } = parsed.data;

    // Per IP and per account: one limits a scan across many accounts, the
    // other limits a guess-fest against one account from many addresses.
    const allowed = await withinLimits(container.limiter, [
      { key: `auth:ip:${request.ip}`, limit: AUTH_RATE_LIMIT, windowMs: AUTH_WINDOW_MS },
      { key: `auth:email:${email.toLowerCase()}`, limit: AUTH_RATE_LIMIT, windowMs: AUTH_WINDOW_MS },
    ]);
    if (!allowed) return fail(reply, 'RATE_LIMITED');

    const result = await container.login.execute(email, password);
    if (!result.ok) return fail(reply, result.code);

    return reply.send({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = RefreshRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST');

    const allowed = await withinLimits(container.limiter, [
      { key: `refresh:ip:${request.ip}`, limit: AUTH_RATE_LIMIT, windowMs: AUTH_WINDOW_MS },
    ]);
    if (!allowed) return fail(reply, 'RATE_LIMITED');

    const result = await container.refresh.execute(parsed.data.refreshToken);
    if (!result.ok) return fail(reply, result.code);

    return reply.send({ accessToken: result.accessToken, refreshToken: result.refreshToken });
  });

  // No use case: logging out is one port call. Wrapping it in an application
  // class would add a file and no behaviour.
  app.post('/auth/logout', { preHandler: authGuard(container.tokens) }, async (request, reply) => {
    await container.tokens.revokeRefreshTokensFor(authOf(request).userId);
    return reply.code(204).send();
  });
}
