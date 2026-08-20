import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyServerOptions,
} from 'fastify';
import type { Container } from '../composition-root.js';
import { fail } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGateRoutes } from './routes/gate.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerGrantRoutes } from './routes/grants.js';

/** Every request body here is a handful of short fields. */
const BODY_LIMIT_BYTES = 16 * 1024;

export function buildApp(
  container: Container,
  logger: FastifyServerOptions['logger'] = false,
): FastifyInstance {
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES });

  app.decorateRequest('auth', null);

  // Fastify's default handler echoes the error message. An error from a
  // Shelly call can carry the auth key, so every failure leaves through
  // `fail`, which only ever emits a fixed string.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return fail(reply, 'BAD_REQUEST');
    request.log.error({ err: error }, 'unhandled route error');
    return fail(reply, 'INTERNAL');
  });

  app.setNotFoundHandler((_request, reply) => fail(reply, 'BAD_REQUEST'));

  registerAuthRoutes(app, container);
  registerGateRoutes(app, container);
  registerAuditRoutes(app, container);
  registerGrantRoutes(app, container);

  return app;
}
