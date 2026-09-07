import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../test/fakes.js';
import { ReedSwitchStateAdapter, readInput } from './reed-switch-state-adapter.js';
import { readContact, startGateStatePoll } from './gate-state-poll.js';

const STALE_AFTER_MS = 300_000;

/** Matches the shape the live probe confirmed for `select: ['status']`. */
const deviceReply = (online: number, input?: { id: number; state: boolean }) => [{
  id: 'testdevice',
  type: 'relay',
  gen: 'G2',
  online,
  status: {
    'switch:0': { id: 0, output: false },
    ...(input === undefined ? {} : { [`input:${input.id}`]: input }),
  },
}];

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const start = (handler: () => { status: number; json: unknown }) =>
  new Promise<{ host: string; count: () => number }>((resolve) => {
    let calls = 0;
    server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        calls += 1;
        const { status, json } = handler();
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (typeof addr === 'string' || !addr) throw new Error('no address');
      resolve({ host: `127.0.0.1:${addr.port}`, count: () => calls });
    });
  });

const config = (host: string) => ({
  host, authKey: 'test-key-not-real', deviceId: 'testdevice', timeoutMs: 5000, insecure: true,
});

// The interval is parked out of reach so each test drives its own reads.
const SETTLE_MS = 150;
const options = {
  intervalMs: 3_600_000, settleAfterMs: SETTLE_MS,
  inputComponentId: 100, reedLogicInverted: false,
};
const silent = { warn: () => {} };

/**
 * A flat wait, for proving something does NOT happen. Longer than the settle
 * delay plus the client's process-wide one-second Shelly gap, so a wrongly
 * stacked or uncancelled timer has time to turn into a request and be seen.
 */
const QUIET_MS = 1600;
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Waits for the first tick to land rather than sleeping a fixed span: every
 * request in this file queues behind the client's process-wide one-per-second
 * Shelly gap, so how long a tick takes depends on what ran before it.
 */
async function settle(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    await new Promise((r) => { setTimeout(r, 50); });
    if (await done()) return;
  }
}

describe('readInput', () => {
  it('maps a closed circuit to closed, and inverts on demand', () => {
    expect(readInput(true, false)).toBe('closed');
    expect(readInput(false, false)).toBe('not_closed');

    // The multimeter says the NC leg reads the other way round: a config
    // change, never a code change.
    expect(readInput(true, true)).toBe('not_closed');
    expect(readInput(false, true)).toBe('closed');
  });
});

describe('readContact', () => {
  it('reads the configured component and nothing else', () => {
    const status = { 'input:0': { id: 0, state: true }, 'input:100': { id: 100, state: false } };

    // input:0 is the device's own terminal, wired to the gate board. Reading
    // it instead of the add-on would report the relay, not the magnet.
    expect(readContact(status, 100, false)).toBe('not_closed');
    expect(readContact(status, 0, false)).toBe('closed');
  });

  it('returns null when the add-on is not enabled on the device', () => {
    // Absent is a real case, not a bug: the Plus Add-on has to be turned on
    // in device settings before input:100 exists at all. No reading is not
    // the same as a reading of "not closed".
    expect(readContact({ 'input:0': { id: 0, state: true } }, 100, false)).toBeNull();
    expect(readContact({}, 100, false)).toBeNull();
    expect(readContact({ 'input:100': { id: 100 } }, 100, false)).toBeNull();
  });
});

describe('ReedSwitchStateAdapter staleness', () => {
  it('reports a fresh reading, and unknown once it ages past the window', async () => {
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.record('closed', 'webhook', clock.now());

    expect((await adapter.getState()).position).toBe('closed');

    // Exactly on the boundary still counts: the cut is "older than".
    clock.advance(STALE_AFTER_MS);
    expect((await adapter.getState()).position).toBe('closed');

    clock.advance(1);
    const stale = await adapter.getState();
    expect(stale.position).toBe('unknown');

    // Stale is not amnesia. The app needs the old reading and its age to say
    // "last seen closed 12 minutes ago" instead of going quiet.
    expect(stale.lastReading?.position).toBe('closed');
  });

  it('has no reading at all before the first report', async () => {
    const state = await new ReedSwitchStateAdapter(new FakeClock(), STALE_AFTER_MS).getState();
    expect(state.position).toBe('unknown');
    expect(state.lastReading).toBeNull();
    expect(state.reachable).toBe(false);
  });

  it('forgets the position on markUnknown but keeps reachability', async () => {
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.setOnline(true);
    adapter.record('closed', 'poll', clock.now());

    adapter.markUnknown();

    const state = await adapter.getState();
    expect(state.position).toBe('unknown');
    expect(state.reachable).toBe(true);
  });

  it('will not claim a position once contact with the controller is lost', async () => {
    // The bug this exists to prevent: a green, confident CLOSED sitting on
    // screen while the controller is unreachable. The physical remote still
    // works, so a gate walked open during the silence would leave the app
    // asserting the opposite of the truth.
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.setOnline(true);
    adapter.record('closed', 'poll', clock.now());
    expect((await adapter.getState()).position).toBe('closed');

    adapter.setOnline(false);

    const state = await adapter.getState();
    expect(state.position).toBe('unknown');
    // Demoted to a recollection, not hidden: the app still shows what it was
    // and how long ago, which is the useful half of the answer.
    expect(state.lastReading).toEqual({ position: 'closed', at: clock.now() });
  });

  it('treats a webhook as proof the device is alive', async () => {
    // The device reaching us first-hand beats the cloud's keepalive flag,
    // which lags by up to a minute. Without this, a poll failing while pushes
    // still arrive would report unknown on data just delivered by the device.
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.setOnline(false);

    adapter.record('closed', 'webhook', clock.now());

    const state = await adapter.getState();
    expect(state.reachable).toBe(true);
    expect(state.position).toBe('closed');
  });

  it('does not let a reachable-but-silent controller keep a dead reading alive', async () => {
    // The add-on comes unseated: polls still succeed and still say online,
    // but no contact is ever read again. The reading must still age out.
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.record('closed', 'poll', clock.now());

    clock.advance(STALE_AFTER_MS + 1);
    adapter.setOnline(true);

    expect((await adapter.getState()).position).toBe('unknown');
  });
});

describe('reconciliation poll', () => {
  it('corrects stored state that disagrees with a direct read', async () => {
    const { host } = await start(() => ({
      status: 200, json: deviceReply(1, { id: 100, state: false }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    // A webhook said closed; the one that said otherwise never arrived.
    adapter.record('closed', 'webhook', clock.now());

    const warnings: object[] = [];
    const stop = startGateStatePoll(adapter, config(host), clock, options, {
      warn: (payload) => warnings.push(payload),
    });
    await settle(() => warnings.length > 0);
    stop();

    expect((await adapter.getState()).position).toBe('not_closed');
    // Logged loudly: a trickle of these means webhooks are being lost, and
    // that is worth learning from a log rather than from a gate.
    expect(warnings).toEqual([{ stored: 'closed', seen: 'not_closed' }]);
  });

  it('goes stale rather than throwing when the poll fails', async () => {
    const { host, count } = await start(() => ({ status: 500, json: { error: 'nope' } }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);
    adapter.record('closed', 'webhook', clock.now());

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(async () => !(await adapter.getState()).reachable && count() > 0);
    stop();

    // A failed poll must degrade honestly rather than throw out of the timer.
    // Losing contact drops BOTH reachability and the claim to a position: we
    // are no longer in a position to say, and the gate can still be worked by
    // the physical remote while we are not looking.
    const state = await adapter.getState();
    expect(state.reachable).toBe(false);
    expect(state.position).toBe('unknown');

    // The reading itself is kept, so the app can still say what it last saw
    // and when -- demoted from a claim to a recollection, never discarded.
    expect(state.lastReading).toEqual({ position: 'closed', at: clock.now() });
  });

  it('honours REED_LOGIC_INVERTED end to end', async () => {
    const { host } = await start(() => ({
      status: 200, json: deviceReply(1, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(
      adapter, config(host), clock, { ...options, reedLogicInverted: true }, silent,
    );
    await settle(() => adapter.lastPosition() !== null);
    stop();

    expect((await adapter.getState()).position).toBe('not_closed');
  });

  it('ignores the cloud cache served for an offline device', async () => {
    // An offline device still comes back with an `input:<id>` block -- it is
    // Shelly's cached last-known value, not a live read. Recording it would
    // stamp a fresh confirmedAt on stale data every single tick, so a gate
    // whose controller died hours ago would still report a position and the
    // staleness window would never fire at all.
    const { host, count } = await start(() => ({
      status: 200, json: deviceReply(0, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(() => count() > 0);
    stop();

    expect(adapter.lastPosition()).toBeNull();
    expect((await adapter.getState()).position).toBe('unknown');
  });

  it('records nothing when the add-on is missing, but still reports reachability', async () => {
    const { host, count } = await start(() => ({ status: 200, json: deviceReply(1) }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(async () => (await adapter.getState()).reachable);
    stop();

    const state = await adapter.getState();
    expect(state.reachable).toBe(true);
    expect(state.position).toBe('unknown');
    expect(state.lastReading).toBeNull();
  });
});

describe('settle read after a pulse', () => {
  it('takes one direct read once the gate has finished travelling', async () => {
    // The webhook that never arrived: a gate that actually closed, with a
    // store still holding the reading from before the pulse.
    const { host } = await start(() => ({
      status: 200, json: deviceReply(1, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(async () => (await adapter.getState()).position === 'closed');

    // A pulse: the gate is moving, so the stored position is dropped.
    adapter.markUnknown();
    expect((await adapter.getState()).position).toBe('unknown');

    // Without the settle read this would wait out the whole interval, which
    // runs from server boot and has nothing to do with when anyone tapped.
    await settle(async () => (await adapter.getState()).position === 'closed');
    stop();

    expect((await adapter.getState()).position).toBe('closed');
  }, 20_000);

  it('costs one read for a burst of taps, timed from the last', async () => {
    const { host, count } = await start(() => ({
      status: 200, json: deviceReply(1, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(() => count() > 0);
    const afterStartup = count();

    // Three taps in quick succession. Travel restarts on each, so the earlier
    // deadlines are meaningless and must not each buy their own request.
    adapter.markUnknown();
    adapter.markUnknown();
    adapter.markUnknown();

    await settle(() => count() > afterStartup);
    await pause(QUIET_MS);
    stop();

    expect(count() - afterStartup).toBe(1);
  }, 20_000);

  it('does not fire into a poll that has been stopped', async () => {
    const { host, count } = await start(() => ({
      status: 200, json: deviceReply(1, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(() => count() > 0);

    adapter.markUnknown();
    stop();
    const atStop = count();

    await pause(QUIET_MS);
    expect(count()).toBe(atStop);

    // And a pulse arriving after shutdown wakes nothing at all.
    adapter.markUnknown();
    await pause(QUIET_MS);
    expect(count()).toBe(atStop);
  }, 20_000);

  it('reuses the offline guard rather than trusting a cached read', async () => {
    // Same rule as the interval: an offline device is served from Shelly's
    // cache, and recording it would stamp fresh confirmedAt on stale data.
    const { host, count } = await start(() => ({
      status: 200, json: deviceReply(0, { id: 100, state: true }),
    }));
    const clock = new FakeClock();
    const adapter = new ReedSwitchStateAdapter(clock, STALE_AFTER_MS);

    const stop = startGateStatePoll(adapter, config(host), clock, options, silent);
    await settle(() => count() > 0);
    const afterStartup = count();

    adapter.markUnknown();
    await settle(() => count() > afterStartup);
    stop();

    expect(adapter.lastPosition()).toBeNull();
    expect((await adapter.getState()).position).toBe('unknown');
  }, 20_000);
});
