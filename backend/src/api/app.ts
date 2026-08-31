import Fastify, {
  type FastifyError, type FastifyInstance, type FastifyServerOptions,
} from 'fastify';
import cors from '@fastify/cors';
import type { Container } from '../composition-root.js';
import { fail } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerGateRoutes } from './routes/gate.js';
import { registerAuditRoutes } from './routes/audit.js';
import { registerGrantRoutes } from './routes/grants.js';

/** Every request body here is a handful of short fields. */
const BODY_LIMIT_BYTES = 16 * 1024;

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  /**
   * Development only, and off unless asked for. The Expo dev client runs in a
   * browser-like origin and needs CORS; a shipped app is a native binary that
   * sends no `Origin` at all, so enabling this in production buys nothing and
   * hands a browser a way to call the gate on a signed-in user's behalf.
   */
  allowCors?: boolean;
}

export function buildApp(
  container: Container,
  { logger = false, allowCors = false }: AppOptions = {},
): FastifyInstance {
  // Caddy reaches this process over 127.0.0.1, so `X-Forwarded-For` is only
  // believed when the connection itself is loopback. Without this every
  // request reads as 127.0.0.1 and the per-IP rate limits collapse into one
  // shared bucket -- ten bad logins would lock out every account.
  //
  // `'loopback'` rather than a numeric hop count: the number form trusts by
  // position and resolved to 127.0.0.1 here, silently doing nothing. This
  // form also means a request arriving on any non-loopback socket is keyed on
  // that socket, so a forged header buys an attacker nothing.
  const app = Fastify({ logger, bodyLimit: BODY_LIMIT_BYTES, trustProxy: 'loopback' });

  if (allowCors) {
    // Reflects the request origin: a dev machine's LAN address changes with
    // the DHCP lease, and pinning a list here would be re-edited weekly.
    app.register(cors, { origin: true });
  }

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
