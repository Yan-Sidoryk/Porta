import type { GatePosition } from '@gate/shared';
import type { GateReading, GateState, ReadingSource } from '../../domain/gate.js';
import type { ClockPort, GateStatePort, GateStateSinkPort } from '../../domain/ports.js';

/**
 * Turns the raw contact into a position, honouring the polarity flag.
 *
 * `on` is the input's boolean state as the device reports it -- from the
 * webhook (`input.toggle_on` => true) or from the `input:<id>.state` field of
 * a poll. Both go through here, so REED_LOGIC_INVERTED cannot flip one and
 * leave the other, which would make a gate read closed on push and not closed
 * on poll and produce an endless stream of "corrections".
 *
 * Which way the NC leg actually reads gets confirmed with a multimeter at the
 * pillar, so this must be a config change and never a code change.
 */
export const readInput = (on: boolean, inverted: boolean): GatePosition =>
  (on !== inverted ? 'closed' : 'not_closed');

/**
 * Gate position from the reed contact on the pillar.
 *
 * Holds the last reading in memory and answers from it. It deliberately does
 * NOT call Shelly on read: the webhook pushes changes the moment they happen,
 * and a synchronous call per status request would spend the account's one
 * request per second on a question we already know the answer to.
 *
 * Nothing is persisted. An earlier draft kept a durable row and then forced
 * it to 'unknown' on boot anyway -- the gate can be walked open by the
 * physical remote while the backend is down -- so the row could only ever be
 * overwritten before it was read. The startup poll is what makes a restart
 * safe, not storage.
 *
 * `UnknownPositionStateAdapter` remains in the tree as the documented
 * fallback for a deployment with no sensor fitted.
 */
export class ReedSwitchStateAdapter implements GateStatePort, GateStateSinkPort {
  private reading: GateReading | null = null;
  private source: ReadingSource | null = null;

  /** Last moment we had ANY successful reading, push or poll. */
  private confirmedAt: Date | null = null;

  /** Last `online` flag from the poll. Null until the first poll answers. */
  private online = false;

  constructor(
    private readonly clock: ClockPort,
    private readonly staleAfterMs: number,
  ) {}

  record(position: GatePosition, source: ReadingSource, at: Date): void {
    this.reading = { position, at };
    this.source = source;
    this.confirmedAt = at;

    // A webhook is the device reaching US, which is stronger proof it is
    // alive than the cloud's keepalive flag -- that lags by up to a minute
    // and can call a perfectly healthy device offline. Without this, a poll
    // failing while pushes still arrive would report 'unknown' on data that
    // had just been delivered first-hand.
    if (source === 'webhook') this.online = true;

    this.onReading?.(position);
  }

  /**
   * Set by the reconciliation poll, which owns the only Shelly connection.
   *
   * This adapter deliberately never calls Shelly -- answering from memory is
   * the whole reason it exists -- so it cannot go and look for itself. It
   * just says "the gate is moving" and lets whoever can read the device
   * decide what to do about it.
   */
  onMoving?: () => void;

  /**
   * Also set by the poll: take one direct read NOW and resolve when it has
   * landed. Backs pull-to-refresh, the one gesture that unambiguously means
   * "I want the truth right now" -- every other route to the real sensor is
   * on a timer.
   *
   * Throttled and de-duplicated by the poll, not here. This adapter still
   * never opens a socket.
   */
  readNow?: () => Promise<void>;

  /**
   * Every reading as it is recorded, raw -- before the staleness cut, and
   * whichever of the webhook or the poll produced it. Set by the gate-open
   * alarm, which needs the transitions rather than the answer `getState()`
   * gives.
   */
  onReading?: (position: GatePosition) => void;

  markUnknown(): void {
    // `confirmedAt` is deliberately NOT advanced: a pulse we sent is not
    // evidence that anyone read the contact. Clearing the reading is enough
    // to make getState() answer 'unknown' until a webhook or poll resolves it.
    this.reading = null;
    this.source = null;
    this.onMoving?.();
  }

  /**
   * Called by the poll only. Reachability is a separate fact from position.
   *
   * It deliberately does not touch `confirmedAt`: a poll that reaches the
   * cloud but comes back without an input reading -- the add-on unseated, say
   * -- proves the controller is up and proves nothing at all about the
   * contact. Letting it refresh the timestamp would keep a long-dead reading
   * looking current forever.
   */
  setOnline(online: boolean): void {
    this.online = online;
  }

  /**
   * The raw stored position, before the staleness cut. The poll compares
   * against this rather than against getState(), which would otherwise report
   * a "correction" every single time a reading merely aged out.
   */
  lastPosition(): GatePosition | null {
    return this.reading?.position ?? null;
  }

  async getState(): Promise<GateState> {
    const now = this.clock.now();

    // Stale is not an error. It means the Shelly stopped answering -- Wi-Fi at
    // the pillar drops, which is the expected failure -- and the honest reply
    // to "is the gate closed" is then that we do not know.
    const fresh = this.confirmedAt !== null
      && now.getTime() - this.confirmedAt.getTime() <= this.staleAfterMs;

    // `online` is part of the test, not just decoration beside it. Losing
    // contact with the controller is POSITIVE evidence that we can no longer
    // know the position -- the physical remote still works, and a gate walked
    // open while we were disconnected would leave a confident, green, wrong
    // CLOSED on the screen. Reporting a position we cannot currently confirm
    // is the exact failure this sensor was added to remove.
    //
    // The last reading survives on `lastReading`, with its age, so nothing is
    // hidden -- it is demoted from a claim to a recollection.
    return {
      position: fresh && this.online && this.reading !== null ? this.reading.position : 'unknown',
      reachable: this.online,
      checkedAt: this.confirmedAt ?? now,
      lastReading: this.reading,
    };
  }
}
