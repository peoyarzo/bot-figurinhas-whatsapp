import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

const root = path.resolve(import.meta.dirname, '..');

describe('chip do bot', () => {
  it('recusa 5511976882096 como chip e aceita como admin', () => {
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const example = readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(readme).toContain('5511976882096');
    expect(readme.toLowerCase()).toContain('admin');
    expect(example).not.toContain('5511976882096');
    expect(example).not.toContain('97688');
    expect(() => loadEnv({ ADMIN_TOKEN: 't', PAIRING_NUMBER: '5511976882096' })).toThrow(/chip/);
    expect(() => loadEnv({ ADMIN_TOKEN: 't', PAIRING_NUMBER: '+55 (11) 97688-2096' })).toThrow(/chip/);
    const env = loadEnv({
      ADMIN_TOKEN: 't',
      ADMIN_NUMBERS: '5511976882096',
      PAIRING_NUMBER: '5511900000000',
    });
    expect(env.ADMIN_NUMBERS).toEqual(['5511976882096']);
    expect(env.PAIRING_NUMBER).toBe('5511900000000');
  });
});
