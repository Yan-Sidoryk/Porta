import { buildApp } from './api/app.js';
import { buildContainer } from './composition-root.js';
import { loadConfig } from './config.js';
import { startGateStatePoll } from './infrastructure/shelly/gate-state-poll.js';

/**
 * The webhook token rides in the URL path -- the one place a Shelly can carry
 * it, since Gen2 webhooks send no custom headers -- so the request logger
 * would otherwise write the secret to disk on every contact change.
 *
 * `redact.paths` cannot mask part of a string, so the URL is rewritten before
 * it is ever serialised. The reverse proxy logs the same URL and needs the
 * same treatment; see docs/DEPLOY.md.
 */
const WEBHOOK_PREFIX = '/webhooks/gate-state/';
const scrubUrl = (url: string): string =>
  (url.startsWith(WEBHOOK_PREFIX) ? `${WEBHOOK_PREFIX}[redacted]` : url);

// Throws before anything opens a socket if a secret is missing or production
// is not behind https. Failing here is the point: not at 2am.
const config = loadConfig(process.env);
const container = buildContainer(config);

const app = buildApp(container, {
  // Never in production: see AppOptions.allowCors.
  allowCors: config.nodeEnv !== 'production',
  logger: {
    level: config.nodeEnv === 'production' ? 'info' : 'debug',
    // SHELLY_AUTH_KEY must never reach a log line. `authKey` is the field name
    // on ShellyConfig and `auth_key` the query parameter, so both are censored
    // wherever they appear, along with anything that grants a session.
    redact: {
      paths: [
        'req.headers.authorization', 'req.headers.cookie',
        '*.password', '*.authKey', '*.auth_key', '*.accessToken', '*.refreshToken',
        'password', 'authKey', 'auth_key', 'accessToken', 'refreshToken',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (request: { method: string; url: string }) => ({
        method: request.method,
        url: scrubUrl(request.url),
      }),
    },
  },
});

// Started here rather than in the composition root: buildContainer() runs in
// tests, and a container that opens a socket to Shelly on construction would
// make every one of them talk to a real gate.
//
// It corrects drift from webhooks that were never delivered -- they are
// fire-and-forget, so a missed event is gone for good -- and it is not the
// liveness path. Do not shorten the interval to compensate for lost webhooks.
const stopPoll = startGateStatePoll(
  container.gateStateAdapter,
  config.shelly,
  container.clock,
  {
    intervalMs: config.gateState.pollIntervalMs,
    inputComponentId: config.gateState.inputComponentId,
    reedLogicInverted: config.gateState.reedLogicInverted,
  },
  app.log,
);

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
  stopPoll();
  void app.close().then(() => {
    container.close();
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ publicUrl: config.publicUrl }, 'gate opener backend listening');
} catch (error) {
  app.log.error({ err: error }, 'failed to start');
  process.exit(1);
}
