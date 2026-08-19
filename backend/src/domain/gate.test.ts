import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDEMPOTENCY_WINDOW_MS, UNCONFIRMED_COOLDOWN_MULTIPLIER } from './constants.js';

const OUTER_LAYERS = new Set(['application', 'infrastructure', 'api']);

/**
 * True when an import specifier's path segments name an outer layer --
 * whatever the relative depth ('../', '../../', ...) or a bare/aliased
 * specifier that names the layer directly (a tsconfig path alias).
 */
function importsOuterLayer(specifier: string): boolean {
  return specifier.split('/').some((segment) => OUTER_LAYERS.has(segment));
}

// Matches static `from '...'` / `from "..."` and dynamic `import('...')` /
// `import("...")`, either quote style.
const IMPORT_RE = /\bfrom\s+(['"])([^'"]+)\1|\bimport\(\s*(['"])([^'"]+)\3\s*\)/g;

describe('domain layer', () => {
  it('imports nothing from outer layers', () => {
    const dir = import.meta.dirname;
    const offenders: string[] = [];
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'));

    for (const file of files) {
      const src = readFileSync(join(dir, file), 'utf8');
      src.split('\n').forEach((line, index) => {
        IMPORT_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = IMPORT_RE.exec(line)) !== null) {
          const specifier = match[2] ?? match[4];
          if (specifier && importsOuterLayer(specifier)) {
            offenders.push(`${file}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(offenders, `outward imports found:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('holds the longer window for unconfirmed attempts', () => {
    expect(UNCONFIRMED_COOLDOWN_MULTIPLIER).toBe(2);
    expect(IDEMPOTENCY_WINDOW_MS).toBe(60_000);
  });
});
