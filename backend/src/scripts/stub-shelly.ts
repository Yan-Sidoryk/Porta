import { createServer } from 'node:https';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

/**
 * A standing-in-for-Shelly server, so the app can be driven end to end
 * without moving a real gate. Every test in this repo already refuses to call
 * the real API for the same reason.
 *
 * It serves HTTPS because the backend only ever builds `https://` URLs --
 * `ShellyConfig.insecure` exists for the integration test and there is
 * deliberately no environment variable that can turn it on. The certificate
 * is generated fresh on every start and written to the OS temp directory, so
 * no private key is ever committed.
 *
 *   npm run stub-shelly -w backend
 *
 * Then start the backend with the two variables it prints.
 */
const PORT = 8443;

const pems = await generate([{ name: 'commonName', value: 'localhost' }], {
  // The library still defaults to sha1, which current TLS stacks refuse.
  algorithm: 'sha256',
  notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  extensions: [
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' }, // DNS
        { type: 7, ip: '127.0.0.1' }, // IP
      ],
    },
  ],
});

const certPath = join(tmpdir(), 'gate-stub-shelly-cert.pem');
writeFileSync(certPath, pems.cert);

createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    const url = req.url ?? '';
    // The auth key travels in the query string, so it is never logged here
    // either -- the same rule the backend follows.
    console.log(`${req.method} ${url.split('?')[0]} ${raw}`);

    if (url.startsWith('/v2/devices/api/get')) {
      // Reachability check. The shape mirrors what the state adapter walks.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { devices_status: { stub: { online: 1 } } } }));
      return;
    }

    // Anything else, including /v2/devices/api/set/switch: success is HTTP 200
    // and nothing else, exactly as the real API behaves.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log(`stub shelly listening on https://127.0.0.1:${PORT}`);
  console.log('start the backend with:');
  console.log(`  SHELLY_HOST=127.0.0.1:${PORT}`);
  console.log(`  NODE_EXTRA_CA_CERTS=${certPath}`);
});
