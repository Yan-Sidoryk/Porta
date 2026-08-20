import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ShellyCloudGateCommandAdapter } from './gate-command-adapter.js';
import { UnknownPositionStateAdapter } from './state-adapter.js';
import { FakeClock } from '../../../test/fakes.js';

let server: Server | undefined;
afterEach(() => {
  // closeAllConnections first: the no-retry test leaves a request hanging
  // open, and close() alone would never resolve.
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

const start = (handler: (body: unknown, url: string) => { status: number; json: unknown }) =>
  new Promise<{ host: string; seen: { body: unknown; url: string }[] }>((resolve) => {
    const seen: { body: unknown; url: string }[] = [];
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ body, url: req.url ?? '' });
        const { status, json } = handler(body, req.url ?? '');
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      });
    }).listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      if (typeof addr === 'string' || !addr) throw new Error('no address');
      resolve({ host: `127.0.0.1:${addr.port}`, seen });
    });
  });

const config = (host: string) => ({
  host, authKey: 'test-key-not-real', deviceId: 'testdevice', timeoutMs: 5000, insecure: true,
});

describe('ShellyCloudGateCommandAdapter', () => {
  it('sends the exact documented request shape', async () => {
    const { host, seen } = await start(() => ({ status: 200, json: {} }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));

    const result = await adapter.pulse();

    expect(result.outcome).toBe('success');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({
      id: 'testdevice', channel: 0, on: true, toggle_after: 1,
    });
    expect(seen[0]?.url).toContain('/v2/devices/api/set/switch');
    expect(seen[0]?.url).toContain('auth_key=test-key-not-real');
  });

  it('treats HTTP 200 alone as success, ignoring the body', async () => {
    const { host } = await start(() => ({ status: 200, json: { anything: 'at all' } }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('success');
  });

  it('maps DEVICE_OFFLINE', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'DEVICE_OFFLINE', data: { messages: ['offline'] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('device-offline');
  });

  it('maps DEVICE_NOT_FOUND', async () => {
    const { host } = await start(() => ({
      status: 404, json: { error: 'DEVICE_NOT_FOUND', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('device-not-found');
  });

  it('maps BAD_REQUEST', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'BAD_REQUEST', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('bad-request');
  });

  it('maps DEVICE_FAILED_COMMAND', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'DEVICE_FAILED_COMMAND', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('device-failed');
  });

  it('maps an unrecognised error string to error, not success', async () => {
    const { host } = await start(() => ({
      status: 500, json: { error: 'SOMETHING_NEW', data: { messages: [] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    expect((await adapter.pulse()).outcome).toBe('error');
  });

  it('returns timeout WITHOUT retrying', async () => {
    let requests = 0;
    server = createServer(() => { requests += 1; /* never respond */ })
      .listen(0, '127.0.0.1');
    await new Promise((r) => server?.once('listening', r));
    const addr = server.address();
    if (typeof addr === 'string' || !addr) throw new Error('no address');

    const adapter = new ShellyCloudGateCommandAdapter(
      { ...config(`127.0.0.1:${addr.port}`), timeoutMs: 150 },
    );

    const result = await adapter.pulse();
    expect(result.outcome).toBe('timeout');
    expect(requests).toBe(1); // exactly one -- a retry could stop the gate
  });

  it('never puts the auth key in the returned detail', async () => {
    const { host } = await start(() => ({
      status: 400, json: { error: 'BAD_REQUEST', data: { messages: ['auth_key=test-key-not-real leaked'] } },
    }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));
    const result = await adapter.pulse();
    expect(JSON.stringify(result)).not.toContain('test-key-not-real');
  });

  it('spaces consecutive requests at least a second apart', async () => {
    const { host } = await start(() => ({ status: 200, json: {} }));
    const adapter = new ShellyCloudGateCommandAdapter(config(host));

    await adapter.pulse(); // pays whatever the previous test left on the clock
    const startedAt = Date.now();
    await adapter.pulse();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000);
  });
});

describe('UnknownPositionStateAdapter', () => {
  it('reports reachable when the device is online, position always unknown', async () => {
    const { host, seen } = await start(() => ({
      status: 200, json: { data: { devices_status: { testdevice: { online: 1 } } } },
    }));
    const clock = new FakeClock();
    const adapter = new UnknownPositionStateAdapter(config(host), clock);

    const state = await adapter.getState();

    expect(state).toEqual({ position: 'unknown', reachable: true, checkedAt: clock.now() });
    expect(seen[0]?.body).toEqual({ ids: ['testdevice'] });
    expect(seen[0]?.url).toContain('/v2/devices/api/get');
  });

  it('reports unreachable when online is 0', async () => {
    const { host } = await start(() => ({
      status: 200, json: { data: { devices_status: { testdevice: { online: 0 } } } },
    }));
    const state = await new UnknownPositionStateAdapter(config(host), new FakeClock()).getState();
    expect(state.reachable).toBe(false);
  });

  it('reports unreachable when the call fails outright', async () => {
    const { host } = await start(() => ({ status: 401, json: { error: 'BAD_REQUEST' } }));
    const state = await new UnknownPositionStateAdapter(config(host), new FakeClock()).getState();
    expect(state).toMatchObject({ position: 'unknown', reachable: false });
  });
});
