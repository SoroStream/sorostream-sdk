/**
 * Issue #757: `src/graphql.ts` (plain data/string GraphQL resolver helpers,
 * Issue #214) is a backend-team-facing module that was unreachable by any
 * package consumer because it was not exposed through a public entry point.
 *
 * The `./graphql` subpath in `package.json`'s `exports` map points this module
 * out as a separate entry point so consumers who don't build GraphQL APIs
 * never pull in anything GraphQL-related. This test imports the module via
 * that public subpath (`@sorostream/sdk/graphql`) to confirm the surface is
 * wired up, and that the existing helper behavior is unchanged.
 */
import { describe, it, expect } from 'vitest';

// Import via the public subpath entry point — NOT the deep `../src/graphql.js`
// path. If the `./graphql` subpath export (or the vitest alias that stands in
// for it) is missing, this import fails to resolve.
import {
  StreamTypeDefs,
  bigIntScalarConfig,
  toStreamResolverResult,
  toStreamDelegationResolverResult,
} from '@sorostream/sdk/graphql';
import type { StreamGraphQLResult, StreamDelegationGraphQLResult } from '@sorostream/sdk/graphql';
import type { Stream } from '../src/types.js';

const sampleStream: Stream = {
  id: '1',
  sender: 'GSENDER',
  recipient: 'GRECIPIENT',
  token: 'GTOKEN',
  deposit: 1_000_000_000n,
  flowRate: 1_000n,
  startTime: 1_700_000_000,
  endTime: 1_700_003_600,
  lastWithdrawTime: 1_700_000_000,
  status: 'Active',
  autoRenew: false,
};

describe('Issue #757: graphql module reachable via @sorostream/sdk/graphql', () => {
  it('exports the Stream SDL type definitions and BigInt scalar config', () => {
    expect(StreamTypeDefs).toContain('type Stream');
    expect(StreamTypeDefs).toContain('scalar BigInt');
    expect(bigIntScalarConfig.name).toBe('BigInt');
  });

  it('bigIntScalarConfig serializes/parses unchanged', () => {
    expect(bigIntScalarConfig.serialize(1_000_000_000n)).toBe('1000000000');
    expect(bigIntScalarConfig.parseValue('1000000000')).toBe(1_000_000_000n);
    expect(bigIntScalarConfig.parseLiteral({ kind: 'IntValue', value: '500' })).toBe(500n);
  });

  it('toStreamResolverResult strips the non-serializable toJSON helper', () => {
    const result = toStreamResolverResult(sampleStream);
    expect(result.id).toBe('1');
    expect(result.deposit).toBe(1_000_000_000n);
    expect((result as Partial<Stream>).toJSON).toBeUndefined();
  });

  it('toStreamDelegationResolverResult builds a GraphQL-ready delegation object', () => {
    expect(toStreamDelegationResolverResult('GDELEGATE', ['GOLD', 'GDELEGATE'])).toEqual({
      currentDelegate: 'GDELEGATE',
      delegationHistory: ['GOLD', 'GDELEGATE'],
    });
    expect(toStreamDelegationResolverResult(undefined)).toEqual({
      currentDelegate: null,
      delegationHistory: [],
    });
  });

  it('StreamGraphQLResult and StreamDelegationGraphQLResult types are importable', () => {
    // Type-only usage — if the export is missing, TypeScript compilation fails.
    const streamResult: StreamGraphQLResult = toStreamResolverResult(sampleStream);
    const delegation: StreamDelegationGraphQLResult = {
      currentDelegate: null,
      delegationHistory: [],
    };
    expect(streamResult.id).toBe('1');
    expect(delegation.currentDelegate).toBeNull();
  });
});
