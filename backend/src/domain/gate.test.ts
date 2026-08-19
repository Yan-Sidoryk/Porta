import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_WINDOW_MS, UNCONFIRMED_COOLDOWN_MULTIPLIER } from './constants.js';

describe('domain layer', () => {
  it('imports nothing from outer layers', () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(join(dir, file), 'utf8');
      if (/from '\.\.\/(application|infrastructure|api)\//.test(src)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('holds the longer window for unconfirmed attempts', () => {
    expect(UNCONFIRMED_COOLDOWN_MULTIPLIER).toBe(2);
    expect(IDEMPOTENCY_WINDOW_MS).toBe(60_000);
  });
});
