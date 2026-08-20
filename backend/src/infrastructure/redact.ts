const SENSITIVE_KEYS = ['auth_key', 'token', 'password', 'authorization'];
const MAX_LEN = 2000;

// Matches `key=value` where value runs up to the next `&`, whitespace, or end
// of string -- covers a secret both mid-URL (`?auth_key=X&y=1`) and trailing
// (`?auth_key=X`), in a query string or free-text error message alike.
const SENSITIVE_PATTERN = new RegExp(`\\b(${SENSITIVE_KEYS.join('|')})=[^&\\s]*`, 'gi');

/**
 * Strips credential-shaped values out of arbitrary text before it is
 * persisted or logged. Shelly Cloud takes its auth key as a query
 * parameter, so a failed fetch's message/stack can contain it verbatim --
 * this must run on anything derived from an adapter error before it is
 * written anywhere durable.
 */
export function redact(input: string): string {
  const clean = input.replace(SENSITIVE_PATTERN, (_match, key: string) => `${key}=***`);
  return clean.length > MAX_LEN ? clean.slice(0, MAX_LEN) : clean;
}
