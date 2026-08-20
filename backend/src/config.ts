import { z } from 'zod';
import type { ShellyConfig } from './infrastructure/shelly/client.js';

/** SPEC.md: aggressive. A hanging request must not leave the app spinning. */
const SHELLY_TIMEOUT_MS = 5000;

/**
 * Everything here is required except the two that are neither secret nor
 * safety-relevant. A missing cooldown or database path is a deployment
 * mistake, and finding out at boot beats finding out at the gate.
 */
const EnvSchema = z.object({
  SHELLY_HOST: z.string().min(1),
  SHELLY_AUTH_KEY: z.string().min(1),
  SHELLY_DEVICE_ID: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  GATE_COOLDOWN_MS: z.coerce.number().int().positive(),
  DATABASE_PATH: z.string().min(1),
  PUBLIC_URL: z.string().url(),
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
});

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  publicUrl: string;
  databasePath: string;
  jwtSecret: string;
  gateCooldownMs: number;
  shelly: ShellyConfig;
}

/**
 * Parses and validates the environment, throwing before anything listens.
 *
 * The thrown message names the variables that are wrong and never prints a
 * value: this error reaches a log, a terminal, and possibly a support ticket,
 * and SHELLY_AUTH_KEY is account-wide and does not expire.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].sort();
    throw new Error(`Invalid configuration: ${names.join(', ')}. Fix .env and restart.`);
  }

  const values = parsed.data;

  // TLS terminates at a reverse proxy, so this process cannot check its own
  // certificate -- PUBLIC_URL is the operator's declaration of how it is
  // reached, and in production a plaintext one is a refusal to boot.
  if (values.NODE_ENV === 'production' && !values.PUBLIC_URL.startsWith('https://')) {
    throw new Error(
      'PUBLIC_URL must use https:// in production. TLS terminates at the reverse '
      + 'proxy; this process never serves plaintext to the internet.',
    );
  }

  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    host: values.HOST,
    publicUrl: values.PUBLIC_URL,
    databasePath: values.DATABASE_PATH,
    jwtSecret: values.JWT_SECRET,
    gateCooldownMs: values.GATE_COOLDOWN_MS,
    // `insecure` is deliberately never set: it exists so the integration test's
    // stub server can be reached over http://127.0.0.1, and there is no
    // environment variable that can turn it on in a deployed process.
    shelly: {
      host: values.SHELLY_HOST,
      authKey: values.SHELLY_AUTH_KEY,
      deviceId: values.SHELLY_DEVICE_ID,
      timeoutMs: SHELLY_TIMEOUT_MS,
    },
  };
}
