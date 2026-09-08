// `extra.apiUrl` is only set for builds. Leaving it unset in dev keeps the
// api.ts fallback -- Metro's `hostUri` -- which follows the dev machine across
// DHCP leases instead of going stale in a checked-in file. eas.json's build
// profiles supply GATE_API_URL, because a standalone build has no Metro.
//
// `googleServicesFile` is NOT in the repository. It is not a credential -- a
// copy ships inside every APK -- but this repository is public, and an
// `AIzaSy...` key sitting in a JSON file reads as a mistake to anyone
// browsing it, whatever the restrictions on the key actually say. EAS keeps
// it as the file secret GOOGLE_SERVICES_JSON and hands the build a path;
// locally it is the untracked copy beside this file.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
  },
  extra: { ...config.extra, apiUrl: process.env.GATE_API_URL },
});
