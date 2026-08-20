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
 * Two uses. First, pinning down where `online` actually lives in the response
 * -- `UnknownPositionStateAdapter` currently searches for it rather than
 * reading a known path, because the real shape could not be confirmed without
 * a live call. Second, answering "why does status say unreachable" when the
 * gate misbehaves later.
 */
const config = loadConfig(process.env);

const reply = await shellyPost(config.shelly, '/v2/devices/api/get', {
  ids: [config.shelly.deviceId],
});

if (reply.kind === 'response') {
  console.log(`HTTP ${reply.status}`);
  console.log(redact(JSON.stringify(reply.body, null, 2)));
} else if (reply.kind === 'timeout') {
  console.log('timeout -- Shelly Cloud did not answer within the configured window');
} else {
  console.log(`network failure: ${reply.detail}`);
}
