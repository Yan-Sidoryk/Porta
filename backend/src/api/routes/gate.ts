import { TriggerRequestSchema } from '@gate/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { fail } from '../errors.js';
import { authGuard, authOf, withinLimits } from '../guards.js';

/**
 * DoS protection only. The thing that actually stops a double tap from
 * halting the gate mid-travel is the 5s cooldown in TriggerGateUseCase --
 * this just keeps a stuck client from filling the audit log.
 */
export const TRIGGER_RATE_LIMIT = 20;
const TRIGGER_IP_RATE_LIMIT = 60;
const TRIGGER_WINDOW_MS = 60_000;

export function registerGateRoutes(app: FastifyInstance, container: Container): void {
  const preHandler = authGuard(container.tokens);

  app.post('/gate/trigger', { preHandler }, async (request, reply) => {
    const parsed = TriggerRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST', { replayed: false });

    const { userId } = authOf(request);
    const allowed = await withinLimits(container.limiter, [
      { key: `trigger:user:${userId}`, limit: TRIGGER_RATE_LIMIT, windowMs: TRIGGER_WINDOW_MS },
      { key: `trigger:ip:${request.ip}`, limit: TRIGGER_IP_RATE_LIMIT, windowMs: TRIGGER_WINDOW_MS },
    ]);
    if (!allowed) return fail(reply, 'RATE_LIMITED', { replayed: false });

    const result = await container.trigger.execute(userId, parsed.data.idempotencyKey);

    // Rebuilt field by field, never spread: `result` carries `internalDetail`
    // on an INTERNAL failure -- a raw adapter error whose text can contain the
    // Shelly auth key, since the key travels in the request's query string.
    if (result.ok) {
      return reply.send({ ok: true, outcome: result.outcome, replayed: result.replayed });
    }
    return fail(reply, result.code, {
      replayed: result.replayed,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    });
  });

  app.get('/gate/status', { preHandler }, async (_request, reply) => {
    const state = await container.gateStatus.execute();
    return reply.send({
      position: state.position,
      reachable: state.reachable,
      checkedAt: state.checkedAt.toISOString(),
    });
  });
}
