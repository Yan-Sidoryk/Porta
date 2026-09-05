import { createHash, timingSafeEqual } from 'node:crypto';
import type { GatePosition } from '@gate/shared';
import type { FastifyInstance } from 'fastify';
import type { Container } from '../../composition-root.js';
import { fail } from '../errors.js';
import { withinLimits } from '../guards.js';

/**
 * Generous on purpose. The only legitimate caller is one Shelly on one IP,
 * and a reed contact bounces -- a gate settling on its stop can produce a
 * short burst of toggles. Dropping a real state change costs more than
 * accepting a few extra requests from a device that cannot do anything with
 * them except report a position.
 */
const WEBHOOK_RATE_LIMIT = 120;
const WEBHOOK_WINDOW_MS = 60_000;

/** The two path segments the device is registered to call. */
const READINGS: Record<string, GatePosition> = {
  closed: 'closed',
  'not-closed': 'not_closed',
};

/**
 * Constant-time comparison that does not leak length either.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * timing-free but perfectly readable oracle for the token's length. Hashing
 * both sides first makes every comparison the same 32 bytes.
 */
function tokenMatches(supplied: string, expected: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(expected));
}

/**
 * The Shelly's push path: it calls this the moment the reed contact changes,
 * outbound, so nothing has to be open to the internet at the gate end.
 *
 * Shelly Gen2 webhooks are plain GETs with no body -- `Webhook.Create` takes a
 * list of URLs and the device fetches them -- so the event rides in the path
 * and each event is registered to its own URL:
 *
 *   input.toggle_on  -> /webhooks/gate-state/<token>/closed
 *   input.toggle_off -> /webhooks/gate-state/<token>/not-closed
 *
 * THIS ROUTE MAY ONLY REPORT STATE. It holds its own token, shares no auth
 * with the app, and there is deliberately no path from here into
 * TriggerGateUseCase -- `container.gateStateSink` is the write side of
 * position and nothing else. A leaked webhook token must not be able to open
 * a gate.
 */
export function registerWebhookRoutes(app: FastifyInstance, container: Container): void {
  app.get<{ Params: { token: string; reading: string } }>(
    '/webhooks/gate-state/:token/:reading',
    async (request, reply) => {
      const allowed = await withinLimits(container.limiter, [{
        key: `gate-state:ip:${request.ip}`,
        limit: WEBHOOK_RATE_LIMIT,
        windowMs: WEBHOOK_WINDOW_MS,
      }]);
      if (!allowed) return fail(reply, 'RATE_LIMITED');

      // A bad token and a bad reading get the identical answer that an
      // unrecognised path gets from setNotFoundHandler. Not 404 -- this API
      // answers an unknown path with 400 BAD_REQUEST, so a lone 404 here
      // would be exactly the "yes, this endpoint exists" signal that
      // rejecting quietly is meant to withhold.
      const { token, reading } = request.params;
      const position = READINGS[reading];
      if (position === undefined) return fail(reply, 'BAD_REQUEST');
      if (!tokenMatches(token, container.gateStateWebhookToken)) {
        return fail(reply, 'BAD_REQUEST');
      }

      // An in-memory assignment, so there is nothing worth deferring past the
      // response -- and the device does not wait around for a slow answer.
      container.gateStateSink.record(position, 'webhook', container.clock.now());
      return reply.send({ ok: true });
    },
  );
}
