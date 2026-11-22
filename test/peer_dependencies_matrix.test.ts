/**
 * Issues #888 and #889: checkPeerDependencies version matrix and no-op inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPeerDependencies } from '../src/peerDependencies.js';
import { SoroStreamDependencyError } from '../src/errors.js';

describe('checkPeerDependencies', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  describe('version matrix (#888)', () => {
    it('is silent for the exact required version', () => {
      expect(() => checkPeerDependencies('13.3.0')).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns but does not throw for a newer minor version', () => {
      expect(() => checkPeerDependencies('13.5.0')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('is silent for an older minor within the same major', () => {
      expect(() => checkPeerDependencies('13.0.0')).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('is silent for a patch difference', () => {
      expect(() => checkPeerDependencies('13.3.9')).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(['12.3.0', '14.0.0'])('throws SoroStreamDependencyError for major mismatch %s', (v) => {
      expect(() => checkPeerDependencies(v)).toThrow(SoroStreamDependencyError);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('undeterminable versions (#889)', () => {
    it.each([null, 'not-a-version'])('is a no-op for %s', (v) => {
      expect(() => checkPeerDependencies(v)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });
});
