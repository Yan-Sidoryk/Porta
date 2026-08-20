import { IssueGrantRequestSchema } from '@gate/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { fail } from '../errors.js';
import { authGuard, authOf } from '../guards.js';

export function registerGrantRoutes(app: FastifyInstance, container: Container): void {
  const preHandler = authGuard(container.tokens);

  // Owner-only, enforced by the use case rather than here -- the check is
  // then unit-tested without HTTP, and a second transport cannot skip it.
  app.post('/access-grants', { preHandler }, async (request, reply) => {
    const parsed = IssueGrantRequestSchema.safeParse(request.body);
    if (!parsed.success) return fail(reply, 'BAD_REQUEST');

    const result = await container.issueGrant.execute(authOf(request).userId, {
      userId: parsed.data.userId,
      startsAt: new Date(parsed.data.startsAt),
      endsAt: new Date(parsed.data.endsAt),
    });
    if (!result.ok) return fail(reply, result.code);

    return reply.send({ grantId: result.grantId });
  });

  app.delete('/access-grants/:id', { preHandler }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await container.revokeGrant.execute(authOf(request).userId, id);
    if (!result.ok) return fail(reply, result.code);

    // 204 whether or not that id existed: the use case is idempotent on
    // purpose, so this endpoint cannot be used to enumerate grant ids.
    return reply.code(204).send();
  });
}
