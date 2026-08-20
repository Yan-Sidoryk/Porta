const SENSITIVE_KEYS = ['auth_key', 'token', 'password', 'authorization'];
const MAX_LEN = 2000;

// `Bearer <token>` -- the real secret follows a space, so a `key<sep>value`
// match alone stops at the first whitespace and would redact only the
// literal word "Bearer", leaving the actual token exposed right after it.
// Run this BEFORE the general pattern below so the token itself is gone
// first; the general pattern then just tidies up the leftover "Authorization:"
// prefix.
const BEARER_PATTERN = /\bBearer\s+\S+/gi;

// `key=value`, `key:value`, `key: value` -- covers query strings, header
// lines, and JSON bodies alike. No `\b` before the key: a secret still
// shows up as `x_auth_key` or `shelly_auth_key`, and matching the suffix is
// enough to destroy the value that follows; `\w*` after the key absorbs a
// numeric/word suffix (`auth_key_2`) the same way.
//
// The value alternation is deliberate: a `"..."` or `'...'` quoted value
// must run to ITS OWN matching closing quote, not just "some chars, maybe
// quoted" -- if a quoted secret didn't fully match (e.g. because it was cut
// off before its closing quote), we do NOT want the third, unquoted
// alternative to instead swallow the stray opening quote and stop early or
// silently pass the raw value through, so it must NOT match on a value that
// begins with a quote. That guarantees any truncation must happen strictly
// AFTER this pattern runs (see below), never before -- a value cut off by an
// earlier truncation would leave a leaked quoted fragment instead.
const KEY_VALUE_PATTERN = new RegExp(
  `["']?(${SENSITIVE_KEYS.join('|')})\\w*["']?\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|[^"'&,}\\s]+)`,
  'gi',
);

/**
 * Strips credential-shaped values out of arbitrary text before it is
 * persisted or logged. Shelly Cloud takes its auth key as a query
 * parameter, and Task 11's request logger sees JSON bodies and
 * Authorization headers -- this must run on anything derived from an
 * adapter error or request before it is written anywhere durable.
 *
 * Over-redaction is the safe failure mode here: this text lands in a
 * durable audit row, so a slightly mangled stack trace beats a leaked
 * credential.
 *
 * Redact BEFORE truncating, never the reverse -- truncating first can cut a
 * quoted secret off before its closing quote, which (by design, see above)
 * stops the pattern from matching it at all, leaving the surviving fragment
 * unredacted in the final output.
 */
export function redact(input: string): string {
  const clean = input
    .replace(BEARER_PATTERN, 'Bearer ***')
    .replace(KEY_VALUE_PATTERN, (_match, key: string) => `${key}=***`);
  return clean.length > MAX_LEN ? clean.slice(0, MAX_LEN) : clean;
}
