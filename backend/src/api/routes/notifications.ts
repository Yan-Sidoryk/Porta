import { PushTokenSchema } from '@gate/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { fail } from '../errors.js';
import { authGuard, authOf, withinLimits } from '../guards.js';

/**
 * Generous, because registering is idempotent and the app does it on every
 * launch with notifications on. This exists to stop a loop filling the table,
 * not to ration a normal user.
 */
const REGISTER_RATE_LIMIT = 30;
const REGISTER_WINDOW_MS = 60_000;

export function registerNotificationRoutes(app: FastifyInstance, container: Container): void {
  const preHandler = authGuard(container.tokens);

  const limited = async (userId: string): Promise<boolean> => withinLimits(container.limiter, [
    { key: `push:user:${userId}`, limit: REGISTER_RATE_LIMIT, windowMs: REGISTER_WINDOW_MS },
  ]);

  app.post('/notifications/register', { preHandler }, async (request, reply) => {
    const parsed = PushTokenSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST');

    const { userId } = authOf(request);
    if (!await limited(userId)) return fail(reply, 'RATE_LIMITED');

    // Bound to whoever is signed in NOW. On a shared phone the token has to
    // follow the current user, or the previous one keeps being told about a
    // gate they may no longer be allowed to open.
    await container.pushTokens.save(
      { token: parsed.data.token, userId },
      container.clock.now(),
    );
    return reply.code(204).send();
  });

  app.post('/notifications/unregister', { preHandler }, async (request, reply) => {
    const parsed = PushTokenSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST');

    const { userId } = authOf(request);
    if (!await limited(userId)) return fail(reply, 'RATE_LIMITED');

    // Deliberately not scoped to the signed-in user. Sign-out unregisters, and
    // by then the token belongs to whoever signs in next; refusing to delete
    // someone else's row would leave a phone alerting its previous owner. The
    // token itself is the secret, and holding it is the authority to drop it.
    await container.pushTokens.remove(parsed.data.token);
    return reply.code(204).send();
  });
}
