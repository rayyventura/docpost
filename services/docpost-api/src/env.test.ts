import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('entrypoint env loading', () => {
  // Modules such as lib/s3 and middleware/auth read process.env at import time, so the
  // .env loader has to be evaluated before any of them (ES imports run in order).
  it('imports the dotenv loader before anything else', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const imports = source.match(/^import .+$/gm) ?? [];
    expect(imports[0]).toBe("import './env.js';");
  });

  it('the loader configures dotenv itself and imports no application modules', () => {
    const source = readFileSync(new URL('./env.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/dotenv\.config\(/);
    const specifiers = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map((m) => m[1]);
    expect(specifiers.every((s) => s.startsWith('node:') || s === 'dotenv')).toBe(true);
  });
});
