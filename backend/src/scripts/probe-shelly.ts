import { loadConfig } from '../config.js';
import { shellyPost } from '../infrastructure/shelly/client.js';
import { redact } from '../infrastructure/redact.js';

/**
 * Prints the raw reachability response from Shelly Cloud, redacted.
 *
 * Read-only: it calls the `get` endpoint, never `set/switch`, so it cannot
 * move a gate no matter what is wired up.
 *
 *   npm run probe-shelly -w backend
 *
 * Two uses. First, finding SHELLY_INPUT_COMPONENT_ID: look for `input:100`
 * (or whatever the Add-on's input is called) in the printed status. If only
 * `input:0` is there, the Add-on is not enabled in device settings yet --
 * `input:0` is the device's own terminal, wired to the gate board, and is
 * never the right id. Second, answering "why does status say unreachable"
 * when the gate misbehaves later.
 */
const config = loadConfig(process.env);

// `select: ['status']` is what makes this useful. Without it the cloud
// answers a five-field summary -- id, type, code, gen, online -- and no
// component state at all, so the Add-on's `input:<id>` is invisible and
// there is no way to read the id SHELLY_INPUT_COMPONENT_ID needs.
const reply = await shellyPost(config.shelly, '/v2/devices/api/get', {
  ids: [config.shelly.deviceId],
  select: ['status'],
});

if (reply.kind === 'response') {
  console.log(`HTTP ${reply.status}`);
  console.log(redact(JSON.stringify(reply.body, null, 2)));
} else if (reply.kind === 'timeout') {
  console.log('timeout -- Shelly Cloud did not answer within the configured window');
} else {
  console.log(`network failure: ${reply.detail}`);
}
