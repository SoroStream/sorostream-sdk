import { describe, it, expectTypeOf } from 'vitest';
import {
  SoroStreamClient,
  VERSION,
  SDK_VERSION,
  toStroops,
  formatUSDC,
  type StorageAdapter,
  type SoroStreamClientOptions,
  type Stream,
  type CreateStreamParams,
} from '../src/index.js';

describe('TypeScript Type Definitions Correctness (#642)', () => {
  it('version constants are strings', () => {
    expectTypeOf(VERSION).toEqualTypeOf<string>();
    expectTypeOf(SDK_VERSION).toEqualTypeOf<string>();
  });

  it('utility functions return expected types', () => {
    expectTypeOf(toStroops('10')).toEqualTypeOf<bigint>();
    expectTypeOf(formatUSDC(10000000n)).toEqualTypeOf<string>();
  });

  it('SoroStreamClient instance signatures match type definitions', () => {
    expectTypeOf(SoroStreamClient).toBeConstructibleWith({} as SoroStreamClientOptions);
  });

  it('StorageAdapter satisfies storage interface shape', () => {
    expectTypeOf<StorageAdapter>().toHaveProperty('getItem');
    expectTypeOf<StorageAdapter>().toHaveProperty('setItem');
    expectTypeOf<StorageAdapter>().toHaveProperty('removeItem');
  });

  it('CreateStreamParams requires mandatory fields', () => {
    expectTypeOf<CreateStreamParams>().toHaveProperty('recipient');
    expectTypeOf<CreateStreamParams>().toHaveProperty('token');
    expectTypeOf<CreateStreamParams>().toHaveProperty('amount');
    expectTypeOf<CreateStreamParams>().toHaveProperty('durationSeconds');
  });
});
