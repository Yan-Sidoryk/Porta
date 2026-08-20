import type { PulseOutcome } from '@gate/shared';
import type { PulseResult } from '../../domain/gate.js';
import type { GateCommandPort } from '../../domain/ports.js';
import { redact } from '../redact.js';
import { shellyPost, type ShellyConfig } from './client.js';

const ERROR_TO_OUTCOME: Record<string, PulseOutcome> = {
  DEVICE_OFFLINE: 'device-offline',
  DEVICE_FAILED_COMMAND: 'device-failed',
  BAD_REQUEST: 'bad-request',
  DEVICE_NOT_FOUND: 'device-not-found',
};

const errorString = (body: unknown): string =>
  typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : '';

export class ShellyCloudGateCommandAdapter implements GateCommandPort {
  constructor(private readonly config: ShellyConfig) {}

  async pulse(): Promise<PulseResult> {
    const reply = await shellyPost(this.config, '/v2/devices/api/set/switch', {
      id: this.config.deviceId,
      channel: 0,
      on: true,
      toggle_after: 1,
    });

    // DO NOT ADD A RETRY. Not here, not in the client, not in the use case.
    // A timeout does not mean the pulse failed -- it may well have fired. A
    // second pulse arriving while the gate is moving stops it mid-travel, so
    // the ambiguity goes to the user instead.
    if (reply.kind === 'timeout') return { outcome: 'timeout' };
    if (reply.kind === 'network') return { outcome: 'error', detail: reply.detail };

    // Success is HTTP 200 and nothing else. The body is never inspected for
    // confirmation -- Shelly does not put one there (SPEC.md).
    if (reply.status === 200) return { outcome: 'success' };

    return {
      outcome: ERROR_TO_OUTCOME[errorString(reply.body)] ?? 'error',
      // Redacted even though the body is Shelly's own: its `messages` array
      // echoes request context, and the auth key travels in the query string.
      detail: redact(`HTTP ${reply.status} ${JSON.stringify(reply.body)}`),
    };
  }
}
