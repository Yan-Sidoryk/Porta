import { buildApp } from './api/app.js';
import { buildContainer } from './composition-root.js';
import { loadConfig } from './config.js';

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
  },
});

const shutdown = (signal: string): void => {
  app.log.info({ signal }, 'shutting down');
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
