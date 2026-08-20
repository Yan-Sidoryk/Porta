import type { GateState } from '../../domain/gate.js';
import type { ClockPort, GateStatePort } from '../../domain/ports.js';
import { shellyPost, type ShellyConfig } from './client.js';

/**
 * Walks the response looking for this device's `online` flag. Shelly's v2
 * `get` nests it (`data.devices_status.<id>.online`), but the exact depth is
 * the one thing here that cannot be verified without calling the real API --
 * and every real call moves a real gate. So: search rather than assume.
 * ponytail: unverified nesting, replace the walk with a direct path once the
 * live shape is confirmed by hand.
 */
function findOnline(node: unknown, deviceId: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const record = node as Record<string, unknown>;
  if (record.online === 1 || record.online === true) return true;
  const nested = record[deviceId];
  if (nested !== undefined) return findOnline(nested, deviceId);
  return Object.values(record).some((value) => findOnline(value, deviceId));
}

/**
 * There is no position sensor on this gate, so `position` is hardcoded
 * `'unknown'` -- inferring it from command history would be a lie the app
 * would then show as fact. A future reed-switch adapter replaces this class
 * wholesale; the port does not change.
 */
export class UnknownPositionStateAdapter implements GateStatePort {
  constructor(
    private readonly config: ShellyConfig,
    private readonly clock: ClockPort,
  ) {}

  async getState(): Promise<GateState> {
    const reply = await shellyPost(this.config, '/v2/devices/api/get', {
      ids: [this.config.deviceId],
    });

    return {
      position: 'unknown',
      reachable:
        reply.kind === 'response'
        && reply.status === 200
        && findOnline(reply.body, this.config.deviceId),
      checkedAt: this.clock.now(),
    };
  }
}
