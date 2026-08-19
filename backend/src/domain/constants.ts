/**
 * How long a single idempotency key is honoured as a replay.
 *
 * The app generates one UUID per user-initiated tap and reuses it across
 * network retries. Within this window the same key returns the original
 * result instead of sending a second pulse. Fixed by the spec; not
 * environment-configurable.
 */
export const IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Multiplier applied to GATE_COOLDOWN_MS at claim time.
 *
 * The window is written pessimistically (2x) before the pulse is attempted
 * and narrowed to 1x only when the outcome is CONFIRMED. An attempt whose
 * fate we do not know -- a timeout, or a process that died before releasing
 * its claim -- therefore holds the LONGER window. Writing 1x up front and
 * extending on timeout would invert this: an abandoned claim would get a
 * weaker guard than a timeout despite carrying strictly less information.
 */
export const UNCONFIRMED_COOLDOWN_MULTIPLIER = 2;
