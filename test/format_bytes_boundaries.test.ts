/**
 * Tests for the formatBytes helper in packages/cli/src/analyze.ts.
 *
 * Covers exact 1024-byte unit boundaries where floating-point log imprecision
 * in `Math.floor(Math.log(bytes) / Math.log(1024))` could produce an off-by-one
 * unit error (e.g. '1024.00 B' instead of '1.00 KB').
 *
 * Closes: #802
 */
import { describe, it, expect } from 'vitest';
import { formatBytes } from '../packages/cli/src/analyze';

describe('formatBytes — unit boundary tests', () => {
  it('returns "0 B" for 0 bytes (special case)', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats exactly 1024 bytes as "1.00 KB" (not "1024.00 B")', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
  });

  it('formats exactly 1024 * 1024 bytes as "1.00 MB" (not "1024.00 KB")', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
  });

  it('formats a mid-range value (512 bytes) as "512.00 B"', () => {
    expect(formatBytes(512)).toBe('512.00 B');
  });

  it('formats a mid-range value (1536 bytes = 1.5 KB) as "1.50 KB"', () => {
    expect(formatBytes(1536)).toBe('1.50 KB');
  });

  it('formats exactly 1 GB boundary (1024^3 bytes) as "1.00 GB"', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});
