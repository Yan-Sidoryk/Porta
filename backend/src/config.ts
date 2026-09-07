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

  // The reed contact on the pillar. The component id comes from
  // Shelly.GetStatus and is the Add-on's input (100+), never the device's own
  // built-in input:0 -- reading input:0 would report the state of the terminal
  // wired to the gate board, not the magnet.
  SHELLY_INPUT_COMPONENT_ID: z.coerce.number().int().nonnegative(),

  // Its own secret, sharing nothing with the trigger path: this token can
  // only report a position, and must never be able to open a gate.
  GATE_STATE_WEBHOOK_TOKEN: z.string().min(32),

  GATE_STATE_STALE_AFTER_MS: z.coerce.number().int().positive().default(300_000),
  GATE_STATE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // One direct read this long after a pulse, so a dropped webhook is
  // corrected in seconds rather than whenever the interval next happens to
  // come round. Must be longer than the gate takes to travel -- see
  // PollOptions.settleAfterMs for why reading early is worse than not
  // reading at all.
  GATE_STATE_SETTLE_AFTER_MS: z.coerce.number().int().positive().default(20_000),

  // Least gap between two pull-to-refresh reads. Caps how much of the Shelly
  // budget an impatient user can spend, and with it how long a gate pulse can
  // end up queued behind them.
  GATE_STATE_REFRESH_MIN_GAP_MS: z.coerce.number().int().positive().default(10_000),

  // The first boolean in this config. An enum rather than a truthiness check
  // so that REED_LOGIC_INVERTED=ture is a refusal to boot instead of a gate
  // that silently reports backwards.
  REED_LOGIC_INVERTED: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
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
  gateState: {
    webhookToken: string;
    inputComponentId: number;
    staleAfterMs: number;
    pollIntervalMs: number;
    settleAfterMs: number;
    refreshMinGapMs: number;
    reedLogicInverted: boolean;
  };
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
    gateState: {
      webhookToken: values.GATE_STATE_WEBHOOK_TOKEN,
      inputComponentId: values.SHELLY_INPUT_COMPONENT_ID,
      staleAfterMs: values.GATE_STATE_STALE_AFTER_MS,
      pollIntervalMs: values.GATE_STATE_POLL_INTERVAL_MS,
      settleAfterMs: values.GATE_STATE_SETTLE_AFTER_MS,
      refreshMinGapMs: values.GATE_STATE_REFRESH_MIN_GAP_MS,
      reedLogicInverted: values.REED_LOGIC_INVERTED,
    },
  };
}
