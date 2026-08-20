import type { GateState } from '../../domain/gate.js';
import type { ClockPort, GateStatePort } from '../../domain/ports.js';
import { shellyPost, type ShellyConfig } from './client.js';

/**
 * Walks the response looking for this device's `online` flag. Shelly's v2
 * `get` nests it (`data.devices_status.<id>.online`), but the exact depth
 * could not be verified without calling the real API. So: search rather than
 * assume.
 *
 * CONFIRMED against real hardware (2026-08-21): reports true for a powered
 * device and false for an unplugged one. Note that this proved the walk
 * *works*, not where the flag lives -- the search finds it without reporting
 * the path.
 *
 * ponytail: the search is loose by construction. It returns true if `online`
 * is truthy ANYWHERE in the response, and the false-positive direction is the
 * bad one -- claiming the gate is reachable when it is not. Only one device id
 * is ever requested, so nothing else should be in there today. Replace with a
 * direct path once `npm run probe-shelly -w backend` has shown the real shape.
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
