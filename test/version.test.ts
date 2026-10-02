import { describe, it, expect } from 'vitest';
import { VERSION, SDK_VERSION } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('SDK Version Constants (#660)', () => {
  it('exports VERSION and SDK_VERSION matching package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
    expect(SDK_VERSION).toBe(pkg.version);
    expect(typeof VERSION).toBe('string');
  });
});
