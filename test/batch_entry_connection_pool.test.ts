/**
 * Issue #984: `@sorostream/sdk/batch` re-exports `ConnectionPool` even though no
 * bulk operation uses it. The re-export is kept (and documented in
 * `src/batch.ts`) so existing imports keep working; this guards that it stays
 * the very same class exported from `core` and the package root.
 */
import { describe, it, expect } from 'vitest';
import * as batch from '../src/batch.js';
import * as core from '../src/core.js';
import * as root from '../src/index.js';

describe('batch entry point ConnectionPool re-export (issue #984)', () => {
  it('still exports ConnectionPool for existing consumers', () => {
    expect(typeof batch.ConnectionPool).toBe('function');
  });

  it('exports the same class as core and the package root', () => {
    expect(batch.ConnectionPool).toBe(core.ConnectionPool);
    expect(batch.ConnectionPool).toBe(root.ConnectionPool);
  });

  it('keeps its batch helpers alongside it', () => {
    expect(typeof batch.parseCsvStreamRows).toBe('function');
    expect(typeof batch.batchSize).toBe('function');
    expect(typeof batch.BatchBuilder).toBe('function');
  });
});
