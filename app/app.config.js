// `extra.apiUrl` is only set for builds. Leaving it unset in dev keeps the
// api.ts fallback -- Metro's `hostUri` -- which follows the dev machine across
// DHCP leases instead of going stale in a checked-in file. eas.json's build
// profiles supply GATE_API_URL, because a standalone build has no Metro.
module.exports = ({ config }) => ({
  ...config,
  extra: { ...config.extra, apiUrl: process.env.GATE_API_URL },
});
