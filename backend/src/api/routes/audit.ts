import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { authGuard } from '../guards.js';

export function registerAuditRoutes(app: FastifyInstance, container: Container): void {
  // Any signed-in user, not owners only: SPEC.md puts a recent-activity list
  // in the app, and "who operated the gate and when" is the point of it.
  app.get('/audit', { preHandler: authGuard(container.tokens) }, async (request, reply) => {
    // A missing or junk `limit` arrives as NaN and the use case falls back to
    // its default page size, so nothing here needs to validate it.
    const { limit } = request.query as { limit?: string };
    const events = await container.auditEvents.execute(Number(limit));

    return reply.send(
      events.map((event) => ({
        id: event.id,
        userEmail: event.userEmail,
        action: event.action,
        outcome: event.outcome,
        errorCode: event.errorCode,
        createdAt: event.createdAt.toISOString(),
      })),
    );
  });
}
